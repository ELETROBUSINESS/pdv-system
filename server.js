// Importa as bibliotecas necessárias
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const NFe = require('node-sped-nfe');
const fs = require('fs');
const http = require('http'); // Importamos o módulo http

const app = express();
app.use(cors());
app.use(express.json());

// --- Conexão com o Banco de Dados Neon ---
let pool;
try {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
} catch (error) {
    console.error("Erro ao criar o Pool de conexão:", error);
    process.exit(1);
}

// --- Inicialização das Tabelas ---
async function initializeDatabase() {
  try {
    const conn = await pool.connect();
    await conn.query(`CREATE TABLE IF NOT EXISTS products ( codigo TEXT PRIMARY KEY, nome TEXT NOT NULL, preco REAL NOT NULL );`);
    await conn.query(`CREATE TABLE IF NOT EXISTS sales ( id SERIAL PRIMARY KEY, data TIMESTPTZ NOT NULL, total REAL NOT NULL, valorPago REAL NOT NULL, troco REAL NOT NULL, itens JSONB NOT NULL );`);
    await conn.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS nfce_status TEXT DEFAULT 'PROCESSANDO';`);
    await conn.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS nfce_protocolo TEXT;`);
    await conn.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS nfce_detalhes TEXT;`);
    conn.release();
    console.log('Banco de dados conectado e tabelas verificadas/atualizadas!');
  } catch (error) {
    console.error('Erro fatal ao inicializar o banco de dados:', error);
    process.exit(1);
  }
}

// --- Rota de Emissão de NFC-e (Simplificada) ---
app.post('/api/emitir-nfce', async (req, res) => {
    const { total, itens, valorPago, sale_id } = req.body;

    const updateSaleStatus = async (status, protocolo, detalhes) => {
        const conn = await pool.connect();
        try { await conn.query('UPDATE sales SET nfce_status = $1, nfce_protocolo = $2, nfce_detalhes = $3 WHERE id = $4', [status, protocolo, detalhes, sale_id]); } finally { conn.release(); }
    };

    try {
        const certPath = '/etc/secrets/certificado.pfx';
        const pfx = fs.readFileSync(certPath);
        const senha = process.env.CERTIFICATE_PASSWORD;

        // 1. Configuração da Biblioteca
        const nfe = new NFe({
            "empresa": {
                "razaoSocial": process.env.EMIT_RAZAO_SOCIAL,
                "cnpj": process.env.EMIT_CNPJ,
                "uf": process.env.EMIT_UF,
                "inscricaoEstadual": process.env.EMIT_IE,
                "codigoRegimeTributario": 1,
                "endereco": {
                    "logradouro": process.env.EMIT_LOGRADOURO,
                    "numero": process.env.EMIT_NUMERO,
                    "bairro": process.env.EMIT_BAIRRO,
                    "cidade": process.env.EMIT_MUNICIPIO,
                    "cep": process.env.EMIT_CEP,
                    "codigoCidade": process.env.EMIT_MUN_CODE
                }
            },
            "producao": false,
            "certificado": { "pfx": pfx, "senha": senha },
            "codigoSeguranca": { "id": process.env.CSC_ID, "csc": process.env.CSC_TOKEN }
        });

        // 2. Informações Gerais Simplificadas
        const numeroNFe = Math.floor(Date.now() / 1000);
        nfe.setInformacoesGerais({
            "modelo": "65", "naturezaOperacao": "VENDA", "dataEmissao": new Date(), "finalidade": "1",
            "consumidorFinal": true, "presenca": "1", "tipo": "1", "numero": numeroNFe, "serie": 1
        });

        nfe.setDestinatario({ "nome": "CONSUMIDOR FINAL" });

        itens.forEach(item => {
            nfe.adicionarProduto({
                "codigo": item.codigo, "descricao": item.nome, "ncm": "22021000", "cfop": "5102",
                "unidade": "UN", "quantidade": item.quantidade, "valor": item.preco,
                "icms": { "origem": "0", "csosn": "102" }
            });
        });
        
        nfe.adicionarPagamento({ "forma": "01", "valor": valorPago });
        
        // 3. Envio para a SEFAZ
        const resultado = await nfe.enviarNFe();

        if (resultado.cStat === '100' || resultado.cStat === '150') {
             await updateSaleStatus('AUTORIZADA', resultado.nProt, 'NFC-e emitida com sucesso.');
             res.status(200).json({ status: 'autorizada', message: 'NFC-e emitida!', protocolo: resultado.nProt });
        } else {
             await updateSaleStatus('ERRO', null, `${resultado.cStat} - ${resultado.xMotivo}`);
             res.status(400).json({ status: 'rejeitada', message: 'NFC-e rejeitada pela SEFAZ.', detalhes: `${resultado.cStat} - ${resultado.xMotivo}` });
        }
    } catch (error) {
        console.error('--- ERRO CRÍTICO AO TENTAR EMITIR NFC-e ---');
        console.error('Timestamp:', new Date().toISOString());
        console.error('Detalhes do Erro:', error.message || error);
        await updateSaleStatus('ERRO', null, error.message);
        res.status(500).json({
            status: 'erro',
            message: 'Falha crítica no servidor ao tentar emitir NFC-e.',
            detalhes: error.message || 'Erro desconhecido. Verifique os logs do servidor.'
        });
    }
});

// (As outras rotas de produtos e vendas continuam as mesmas)
app.get('/', (req, res) => res.status(200).send('Servidor do PDV está a funcionar!'));
// ... (rotas /api/products e /api/sales) ...

// --- Inicialização do Servidor (COM TIMEOUT AUMENTADO) ---
const PORT = process.env.PORT || 3001;

initializeDatabase().then(() => { 
    const server = http.createServer(app);
    // Aumentamos o timeout para 2 minutos (120000 ms) para dar tempo ao servidor de "acordar"
    server.setTimeout(120000); 
    server.listen(PORT, () => console.log(`Servidor a escutar na porta ${PORT}`));
});