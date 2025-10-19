// Importa as bibliotecas necessárias
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const NFe = require('node-sped-nfe');
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
    const createTablesQuery = `
      CREATE TABLE IF NOT EXISTS products ( codigo TEXT PRIMARY KEY, nome TEXT NOT NULL, preco REAL NOT NULL );
      CREATE TABLE IF NOT EXISTS sales ( id SERIAL PRIMARY KEY, data TIMESTPTZ NOT NULL, total REAL NOT NULL, valorPago REAL NOT NULL, troco REAL NOT NULL, itens JSONB NOT NULL );
    `;
    await pool.query(createTablesQuery);
    console.log('Banco de dados conectado e tabelas verificadas!');
  } catch (error) {
    console.error('Erro fatal ao inicializar o banco de dados:', error);
    process.exit(1);
  }
}

// --- Rota de Emissão de NFC-e ---
app.post('/api/emitir-nfce', async (req, res) => {
    const { total, itens, valorPago } = req.body;

    try {
        const certPath = '/etc/secrets/certificado.pfx';
        const pfx = fs.readFileSync(certPath);
        const senha = process.env.CERTIFICATE_PASSWORD;

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

        const numeroNFe = Math.floor(Math.random() * 100000) + 1;
        nfe.setInformacoesGerais({
            "modelo": "65", "naturezaOperacao": "VENDA", "dataEmissao": new Date(), "finalidade": "1",
            "consumidorFinal": true, "presenca": "1", "tipo": "1", "numero": numeroNFe, "serie": 1
        });

        nfe.setDestinatario({ "nome": "CONSUMIDOR FINAL" });

        itens.forEach(item => {
            nfe.adicionarProduto({
                "codigo": item.codigo, "descricao": item.nome, "ncm": "22021000", "cfop": "5102",
                "unidade": "UN", "quantidade": item.quantidade, "valor": item.preco,
                "icms": { "origem": "0", "csosn": "102" }, "pis": { "cst": "07" }, "cofins": { "cst": "07" }
            });
        });
        
        nfe.adicionarPagamento({ "forma": "01", "valor": valorPago });
        
        const resultado = await nfe.enviarNFe();

        if (resultado.cStat === '100') {
             res.status(200).json({ status: 'autorizada', message: 'NFC-e emitida!', protocolo: resultado.nProt, xml: resultado.xml });
        } else {
             res.status(400).json({ status: 'rejeitada', message: 'NFC-e rejeitada.', detalhes: resultado.xMotivo });
        }
    } catch (error) {
        console.error('--- ERRO AO EMITIR NFC-e ---', error);
        res.status(500).json({ status: 'erro', message: 'Falha crítica ao emitir NFC-e.', detalhes: error.message });
    }
});

// --- Outras Rotas ---
app.get('/', (req, res) => res.status(200).send('Servidor do PDV está a funcionar!'));
app.get('/api/products', async (req, res) => { try { const { rows } = await pool.query('SELECT * FROM products ORDER BY nome'); res.status(200).json(rows); } catch (e) { res.status(500).json({ m: 'Erro' }); } });
app.post('/api/products', async (req, res) => { const { codigo, nome, preco } = req.body; try { await pool.query('INSERT INTO products (codigo, nome, preco) VALUES ($1, $2, $3)', [codigo, nome, preco]); res.status(201).json({ m: 'OK' }); } catch (e) { res.status(500).json({ m: 'Erro' }); } });
app.delete('/api/products/:codigo', async (req, res) => { const { codigo } = req.params; try { await pool.query('DELETE FROM products WHERE codigo = $1', [codigo]); res.status(200).json({ m: 'OK' }); } catch (e) { res.status(500).json({ m: 'Erro' }); } });

// --- ROTA DE VENDAS CORRIGIDA ---
app.post('/api/sales', async (req, res) => { 
    const { total, valorPago, troco, itens } = req.body; 
    try { 
        // A correção está aqui: garantimos que 'itens' é uma string JSON antes de guardar
        const itensJson = JSON.stringify(itens);
        await pool.query('INSERT INTO sales (data, total, valorPago, troco, itens) VALUES ($1, $2, $3, $4, $5)', [new Date(), total, valorPago, troco, itensJson]); 
        res.status(201).json({ m: 'OK' }); 
    } catch (e) { 
        console.error("Erro ao inserir venda:", e); // Log de erro melhorado
        res.status(500).json({ m: 'Erro ao registar venda no banco de dados.' }); 
    } 
});

// --- Inicialização do Servidor ---
const PORT = process.env.PORT || 3001;
initializeDatabase().then(() => { app.listen(PORT, () => console.log(`Servidor a escutar na porta ${PORT}`)); });