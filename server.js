// Importa as bibliotecas necessárias
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { NFe } = require('nfe-brasil'); // Nova biblioteca, moderna e mantida
const fs = require('fs'); // Módulo para ler ficheiros

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
    const { total, itens, valorPago } = req.body;

    try {
        // 1. Carregar o certificado a partir do Secret File do Render
        // O Render disponibiliza os secret files no caminho /etc/secrets/
        const certPath = '/etc/secrets/certificado.pfx';
        const certificate = fs.readFileSync(certPath);
        const certPassword = process.env.CERTIFICATE_PASSWORD;

        // 2. Configurar a instância da NFe
        const config = {
            "amb": "2", // 2 = Homologação (testes), 1 = Produção
            "cUF": process.env.EMIT_UF_CODE, // Código IBGE do seu estado (ex: "35" para SP)
            "CNPJ": process.env.EMIT_CNPJ,
            "cert": certificate,
            "pass": certPassword,
            "CSCID": process.env.CSC_ID,
            "CSC": process.env.CSC_TOKEN,
            "versao": "4.00"
        };
        const nfe = new NFe(config);

        // 3. Montar os dados da nota
        let nfceData = {
            "natOp": "VENDA", // Natureza da Operação
            "mod": "65",      // Modelo do Documento Fiscal (65 para NFC-e)
            "serie": "1",     // Série do Documento Fiscal
            "nNF": "1",       // Número do Documento Fiscal (em um sistema real, seria sequencial)
            "dhEmi": new Date().toISOString(),
            "tpNF": "1", // Tipo de Operação (1=Saída)
            "idDest": "1", // Identificador de Local de Destino (1=Operação Interna)
            "tpImp": "4", // Tipo de Impressão do DANFE (4 para NFC-e)
            "tpEmis": "1", // Tipo de Emissão (1=Normal)
            "finNFe": "1", // Finalidade de emissão da NF-e (1=NF-e normal)
            "indFinal": "1", // Indica operação com Consumidor final (1=Sim)
            "indPres": "1", // Indicador de presença do comprador (1=Operação presencial)
            "emit": {
                "CNPJ": process.env.EMIT_CNPJ,
                "xNome": process.env.EMIT_RAZAO_SOCIAL,
                "enderEmit": {
                    "xLgr": process.env.EMIT_LOGRADOURO,
                    "nro": process.env.EMIT_NUMERO,
                    "xBairro": process.env.EMIT_BAIRRO,
                    "cMun": process.env.EMIT_MUN_CODE, // Código IBGE do Município
                    "xMun": process.env.EMIT_MUNICIPIO,
                    "UF": process.env.EMIT_UF,
                    "CEP": process.env.EMIT_CEP,
                },
                "IE": process.env.EMIT_IE,
                "CRT": "1" // Regime Tributário (1=Simples Nacional) - ajuste conforme a sua empresa
            },
            // Para NFC-e, os dados do destinatário não são obrigatórios
            "dest": { "CNPJ": "", "xNome": "NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL" },
            "det": itens.map((item, index) => ({
                "nItem": index + 1,
                "prod": {
                    "cProd": item.codigo,
                    "xProd": item.nome,
                    "NCM": "22021000", // NCM Genérico - ATENÇÃO: Usar o NCM correto de cada produto
                    "CFOP": "5102",    // CFOP Genérico - ATENÇÃO: Usar o CFOP correto
                    "uCom": "UN",
                    "qCom": item.quantidade,
                    "vUnCom": item.preco,
                    "vProd": (item.quantidade * item.preco).toFixed(2),
                    "indTot": "1",
                    "uTrib": "UN",
                    "qTrib": item.quantidade,
                    "vUnTrib": item.preco,
                },
                "imposto": { // Impostos genéricos para Simples Nacional
                    "vTotTrib": "0.00",
                    "ICMS": { "ICMSSN102": { "Orig": "0", "CSOSN": "102" } },
                    "PIS": { "PISNT": { "CST": "07" } },
                    "COFINS": { "COFINSNT": { "CST": "07" } }
                }
            })),
            "total": {
                "ICMSTot": {
                    "vBC": "0.00", "vICMS": "0.00", "vICMSDeson": "0.00", "vFCP": "0.00", "vBCST": "0.00",
                    "vST": "0.00", "vFCPST": "0.00", "vFCPSTRet": "0.00", "vProd": total.toFixed(2),
                    "vFrete": "0.00", "vSeg": "0.00", "vDesc": "0.00", "vII": "0.00", "vIPI": "0.00",
                    "vIPIDevol": "0.00", "vPIS": "0.00", "vCOFINS": "0.00", "vOutro": "0.00", "vNF": total.toFixed(2), "vTotTrib": "0.00"
                }
            },
            "pag": [{ "tPag": "01", "vPag": valorPago.toFixed(2) }] // 01 = Dinheiro
        };

        // 4. Envia a nota para a SEFAZ
        const response = await nfe.send(nfceData);

        res.status(200).json({
            status: 'autorizada',
            message: 'NFC-e emitida com sucesso em ambiente de homologação!',
            protocolo: response.retEnviNFe.protNFe.infProt.nProt,
            xml: response.xml_enviado,
        });

    } catch (error) {
        console.error('--- ERRO AO EMITIR NFC-e ---', error);
        res.status(500).json({
            status: 'erro',
            message: 'Falha ao emitir NFC-e.',
            detalhes: error.message || error.erro || 'Erro desconhecido.'
        });
    }
});

// (As outras rotas de produtos e vendas continuam as mesmas)
app.get('/', (req, res) => res.status(200).send('Servidor do PDV está a funcionar!'));
app.get('/api/products', async (req, res) => { try { const { rows } = await pool.query('SELECT * FROM products ORDER BY nome'); res.status(200).json(rows); } catch (e) { res.status(500).json({ m: 'Erro' }); } });
app.post('/api/products', async (req, res) => { const { codigo, nome, preco } = req.body; try { await pool.query('INSERT INTO products (codigo, nome, preco) VALUES ($1, $2, $3)', [codigo, nome, preco]); res.status(201).json({ m: 'OK' }); } catch (e) { res.status(500).json({ m: 'Erro' }); } });
app.delete('/api/products/:codigo', async (req, res) => { const { codigo } = req.params; try { await pool.query('DELETE FROM products WHERE codigo = $1', [codigo]); res.status(200).json({ m: 'OK' }); } catch (e) { res.status(500).json({ m: 'Erro' }); } });
app.post('/api/sales', async (req, res) => { const { total, valorPago, troco, itens } = req.body; try { await pool.query('INSERT INTO sales (data, total, valorPago, troco, itens) VALUES ($1, $2, $3, $4, $5)', [new Date(), total, valorPago, troco, itens]); res.status(201).json({ m: 'OK' }); } catch (e) { res.status(500).json({ m: 'Erro' }); } });

// --- Inicialização do Servidor ---
const PORT = process.env.PORT || 3001;
initializeDatabase().then(() => { app.listen(PORT, () => console.log(`Servidor a escutar na porta ${PORT}`)); });