// Importa as bibliotecas necessárias
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { Dfe, TipoDfe, TipoAmbiente, Csc, Emitente } = require('node-dfe');
const fs = require('fs'); // <--- IMPORTANTE: Adicionámos o módulo de ficheiros

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
      CREATE TABLE IF NOT EXISTS sales ( id SERIAL PRIMARY KEY, data TIMESTAMPTZ NOT NULL, total REAL NOT NULL, valorPago REAL NOT NULL, troco REAL NOT NULL, itens JSONB NOT NULL );
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
    const { total, itens, valorPago, troco } = req.body;

    try {
        // ... (configuração do emitente e csc continua igual)
        const emitente = Emitente.new({
            razaoSocial: process.env.EMIT_RAZAO_SOCIAL,
            cnpj: process.env.EMIT_CNPJ,
            inscricaoEstadual: process.env.EMIT_IE,
            endereco: {
                logradouro: process.env.EMIT_LOGRADOURO,
                numero: process.env.EMIT_NUMERO,
                bairro: process.env.EMIT_BAIRRO,
                municipio: process.env.EMIT_MUNICIPIO,
                uf: process.env.EMIT_UF,
                cep: process.env.EMIT_CEP,
            },
        });
        const csc = Csc.new(process.env.CSC_ID, process.env.CSC_TOKEN);
        
        // --- ALTERAÇÃO IMPORTANTE AQUI ---
        // Em vez de ler da variável de ambiente, lemos o conteúdo do Secret File
        // O Render disponibiliza os secret files no caminho /etc/secrets/
        const certificateBase64 = fs.readFileSync('/etc/secrets/cert-base64', 'utf8');
        // E depois convertemos de Base64 (texto) de volta para binário
        const certificate = Buffer.from(certificateBase64, 'base64');

        // Configurar o DFE (continua igual)
        const dfe = Dfe.new({
            tipoDfe: TipoDfe.NFCE,
            tipoAmbiente: TipoAmbiente.HOMOLOGACAO,
            cUf: process.env.EMIT_UF,
            emitente: emitente,
            csc: csc,
            certificado: {
                pfx: certificate,
                senha: process.env.CERTIFICATE_PASSWORD,
            },
        });

        // Montar os dados da nota (continua igual)
        const produtosNFCe = itens.map(item => ({
            codigo: item.codigo,
            descricao: item.nome,
            quantidade: item.quantidade,
            unidade: 'UN',
            valor: item.preco,
            ncm: '22021000',
            cfop: '5102',
        }));
        const pagamentos = [{ formaPagamento: '01', valor: valorPago, troco: troco }];

        // Gerar e enviar a nota (continua igual)
        const nfce = await dfe.gerarNfce({
            produtos: produtosNFCe,
            pagamentos: pagamentos,
            valorTotal: total,
        });

        res.status(200).json({
            status: 'autorizada',
            message: 'NFC-e emitida com sucesso em ambiente de homologação!',
            protocolo: nfce.retorno.nProt,
            xml: nfce.getXml(),
        });

    } catch (error) {
        console.error('--- ERRO AO EMITIR NFC-e ---', error);
        res.status(500).json({
            status: 'erro',
            message: 'Falha ao emitir NFC-e.',
            detalhes: error.message || 'Erro desconhecido.'
        });
    }
});

// (As outras rotas continuam iguais: /, /api/products, /api/sales)
app.get('/', (req, res) => res.status(200).send('Servidor do PDV está a funcionar!'));
app.get('/api/products', async (req, res) => { try { const { rows } = await pool.query('SELECT * FROM products ORDER BY nome'); res.status(200).json(rows); } catch (e) { res.status(500).json({ m: 'Erro' }); } });
app.post('/api/products', async (req, res) => { const { codigo, nome, preco } = req.body; try { await pool.query('INSERT INTO products (codigo, nome, preco) VALUES ($1, $2, $3)', [codigo, nome, preco]); res.status(201).json({ m: 'OK' }); } catch (e) { res.status(500).json({ m: 'Erro' }); } });
app.delete('/api/products/:codigo', async (req, res) => { const { codigo } = req.params; try { await pool.query('DELETE FROM products WHERE codigo = $1', [codigo]); res.status(200).json({ m: 'OK' }); } catch (e) { res.status(500).json({ m: 'Erro' }); } });
app.post('/api/sales', async (req, res) => { const { total, valorPago, troco, itens } = req.body; try { await pool.query('INSERT INTO sales (data, total, valorPago, troco, itens) VALUES ($1, $2, $3, $4, $5)', [new Date(), total, valorPago, troco, itens]); res.status(201).json({ m: 'OK' }); } catch (e) { res.status(500).json({ m: 'Erro' }); } });

// --- Inicialização do Servidor ---
const PORT = process.env.PORT || 3001;
initializeDatabase().then(() => { app.listen(PORT, () => console.log(`Servidor a escutar na porta ${PORT}`)); });