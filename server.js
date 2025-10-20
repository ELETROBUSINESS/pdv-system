// Importa as bibliotecas necessárias
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
// --- A forma correta de importar a classe principal ---
const { NFe } = require('node-sped-nfe'); 
const fs = require('fs');

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

// --- Rota de Emissão de NFC-e ---
app.post('/api/emitir-nfce', async (req, res) => {
    const { total, itens, valorPago, sale_id, formaPagamento } = req.body;

    const updateSaleStatus = async (status, protocolo, detalhes) => {
        const conn = await pool.connect();
        try { await conn.query('UPDATE sales SET nfce_status = $1, nfce_protocolo = $2, nfce_detalhes = $3 WHERE id = $4', [status, protocolo, detalhes, sale_id]); } finally { conn.release(); }
    };

    try {
        // --- VERIFICAÇÃO DE SEGURANÇA ---
        const requiredEnvVars = [ 'EMIT_RAZAO_SOCIAL', 'EMIT_CNPJ', 'EMIT_UF', 'EMIT_IE', 'EMIT_LOGRADOURO', 'EMIT_NUMERO', 'EMIT_BAIRRO', 'EMIT_MUNICIPIO', 'EMIT_CEP', 'EMIT_MUN_CODE', 'CERTIFICATE_PASSWORD', 'CSC_ID', 'CSC_TOKEN' ];
        for (const varName of requiredEnvVars) { if (!process.env[varName]) { throw new Error(`Configuração em falta: A variável de ambiente '${varName}' não está definida.`); } }
        
        const certPath = '/etc/secrets/certificado.pfx';
        if (!fs.existsSync(certPath)) { throw new Error("Configuração em falta: O ficheiro do certificado 'certificado.pfx' não foi encontrado."); }
        const pfx = fs.readFileSync(certPath);
        const senha = process.env.CERTIFICATE_PASSWORD;

        // --- FORMA CORRETA DE INSTANCIAR E CONFIGURAR ---
        const nfe = new NFe();
        nfe.configure({
            "empresa": { "razaoSocial": process.env.EMIT_RAZAO_SOCIAL, "cnpj": process.env.EMIT_CNPJ, "uf": process.env.EMIT_UF, "inscricaoEstadual": process.env.EMIT_IE, "codigoRegimeTributario": 1, "endereco": { "logradouro": process.env.EMIT_LOGRADOURO, "numero": process.env.EMIT_NUMERO, "bairro": process.env.EMIT_BAIRRO, "cidade": process.env.EMIT_MUNICIPIO, "cep": process.env.EMIT_CEP, "codigoCidade": process.env.EMIT_MUN_CODE }},
            "producao": false, 
            "certificado": { "pfx": pfx, "senha": senha },
            "codigoSeguranca": { "id": process.env.CSC_ID, "csc": process.env.CSC_TOKEN },
            "informacoesAdicionais": "DOCUMENTO EMITIDO POR ME OU EPP OPTANTE PELO SIMPLES NACIONAL."
        });

        const numeroNFe = Math.floor(Date.now() / 1000); 
        nfe.setInformacoesGerais({ "modelo": "65", "naturezaOperacao": "VENDA", "dataEmissao": new Date(), "finalidade": "1", "consumidorFinal": true, "presenca": "1", "tipo": "1", "numero": numeroNFe, "serie": 1 });
        nfe.setDestinatario({ "nome": "CONSUMIDOR FINAL" });
        itens.forEach(item => { nfe.adicionarProduto({ "codigo": item.codigo, "descricao": item.nome, "ncm": "22021000", "cfop": "5102", "unidade": "UN", "quantidade": item.quantidade, "valor": item.preco, "icms": { "origem": "0", "csosn": "102" }, "pis": { "cst": "07" }, "cofins": { "cst": "07" } }); });
        nfe.adicionarPagamento({ "forma": formaPagamento, "valor": valorPago });
        
        const resultado = await nfe.enviarNFe({ timeout: 30000 });

        if (resultado.cStat === '100' || resultado.cStat === '150') { 
             await updateSaleStatus('AUTORIZADA', resultado.nProt, 'NFC-e emitida com sucesso.');
             res.status(200).json({ status: 'autorizada', message: 'NFC-e emitida!', protocolo: resultado.nProt });
        } else {
             await updateSaleStatus('ERRO', null, `${resultado.cStat} - ${resultado.xMotivo}`);
             res.status(400).json({ status: 'rejeitada', message: 'NFC-e rejeitada pela SEFAZ.', detalhes: `${resultado.cStat} - ${resultado.xMotivo}` });
        }
    } catch (error) {
        console.error('--- ERRO CRÍTICO AO TENTAR EMITIR NFC-e ---');
        console.error(error); 
        
        let errorMessage = 'Erro desconhecido. Verifique os logs do servidor.';
        if (error.message) { errorMessage = error.message; } else if (typeof error === 'string') { errorMessage = error; }

        await updateSaleStatus('ERRO', null, errorMessage);
        res.status(500).json({ status: 'erro', message: 'Falha crítica no servidor ao tentar emitir NFC-e.', detalhes: errorMessage });
    }
});

// (As outras rotas de produtos e vendas continuam as mesmas)
app.get('/', (req, res) => res.status(200).send('Servidor do PDV está a funcionar!'));
app.get('/api/products', async (req, res) => { try { const { rows } = await pool.query('SELECT * FROM products ORDER BY nome'); res.status(200).json(rows); } catch (e) { res.status(500).json({ m: 'Erro' }); } });
app.post('/api/products', async (req, res) => { const { codigo, nome, preco } = req.body; try { await pool.query('INSERT INTO products (codigo, nome, preco) VALUES ($1, $2, $3)', [codigo, nome, preco]); res.status(201).json({ m: 'OK' }); } catch (e) { res.status(500).json({ m: 'Erro' }); } });
app.delete('/api/products/:codigo', async (req, res) => { const { codigo } = req.params; try { await pool.query('DELETE FROM products WHERE codigo = $1', [codigo]); res.status(200).json({ m: 'OK' }); } catch (e) { res.status(500).json({ m: 'Erro' }); } });
app.post('/api/sales', async (req, res) => { const { total, valorPago, troco, itens } = req.body; const conn = await pool.connect(); try { const itensJson = JSON.stringify(itens); const result = await conn.query('INSERT INTO sales (data, total, valorPago, troco, itens) VALUES (NOW(), $1, $2, $3, $4) RETURNING id', [total, valorPago, troco, itensJson]); res.status(201).json({ id: result.rows[0].id }); } catch (e) { console.error("Erro ao inserir venda:", e); res.status(500).json({ m: 'Erro ao registar venda no banco de dados.' }); } finally { conn.release(); } });
app.get('/api/sales', async (req, res) => { const conn = await pool.connect(); try { const { rows } = await conn.query('SELECT id, data, total, nfce_status, nfce_detalhes, nfce_protocolo FROM sales ORDER BY data DESC'); res.status(200).json(rows); } catch (e) { console.error("Erro ao buscar histórico de vendas:", e); res.status(500).json({ message: 'Erro ao buscar histórico de vendas.' }); } finally { conn.release(); } });

// --- Inicialização do Servidor ---
const PORT = process.env.PORT || 3001;
initializeDatabase().then(() => { app.listen(PORT, () => console.log(`Servidor a escutar na porta ${PORT}`)); });