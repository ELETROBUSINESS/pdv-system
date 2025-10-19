// Importa as bibliotecas necessárias
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { Configuracao, NFe, Impressao } = require('@sped-nfe/nfe-brasil'); // A biblioteca correta e moderna
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
        // 1. Carregar o certificado a partir do Secret File do Render
        const certPath = '/etc/secrets/certificado.pfx';
        const pfx = fs.readFileSync(certPath);
        const senha = process.env.CERTIFICATE_PASSWORD;

        // 2. Configurar a instância da NFe
        const config = new Configuracao({
            empresa: {
                cnpj: process.env.EMIT_CNPJ,
                razaoSocial: process.env.EMIT_RAZAO_SOCIAL,
                inscricaoEstadual: process.env.EMIT_IE,
                endereco: {
                    logradouro: process.env.EMIT_LOGRADOURO,
                    numero: process.env.EMIT_NUMERO,
                    bairro: process.env.EMIT_BAIRRO,
                    municipio: process.env.EMIT_MUNICIPIO,
                    uf: process.env.EMIT_UF,
                    cep: process.env.EMIT_CEP,
                    codigoMunicipio: process.env.EMIT_MUN_CODE,
                },
            },
            certificado: { pfx, senha },
            producao: false, // false = Homologação (testes)
            codigoSegurancaContribuinte: {
                id: process.env.CSC_ID,
                csc: process.env.CSC_TOKEN,
            },
            impressao: {
                tipo: Impressao.Tipo.NFCe,
            },
        });

        const nfe = new NFe(config);
        
        // 3. Montar os dados da nota
        const numeroNFe = Math.floor(Math.random() * 100000) + 1; // Em um sistema real, seria sequencial
        const corpoNFe = {
            cabecalho: {
                codigoUF: process.env.EMIT_UF_CODE,
                naturezaOperacao: 'VENDA',
                modelo: '65',
                serie: 1,
                numero: numeroNFe,
                dataEmissao: new Date(),
                tipo: '1', // 1=Saída
                municipioOcorrencia: process.env.EMIT_MUN_CODE,
                finalidade: '1', // 1=NF-e normal
                consumidorFinal: '1',
                presencaConsumidor: '1', // 1=Operação presencial
            },
            emitente: {}, // Os dados já estão na configuração
            destinatario: {
                 nome: 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL'
            },
            produtos: itens.map((item, index) => ({
                numeroItem: index + 1,
                codigo: item.codigo,
                descricao: item.nome,
                ncm: '22021000', // ATENÇÃO: Usar o NCM correto de cada produto
                cfop: '5102',
                unidadeComercial: 'UN',
                quantidadeComercial: item.quantidade,
                valorUnitarioComercial: item.preco,
                unidadeTributavel: 'UN',
                quantidadeTributavel: item.quantidade,
                valorUnitarioTributavel: item.preco,
                icms: {
                    origem: '0', // Nacional
                    csosn: '102', // Tributada pelo Simples Nacional sem permissão de crédito
                },
                pis: { cst: '07' },
                cofins: { cst: '07' },
            })),
            pagamento: [{
                forma: '01', // 01=Dinheiro
                valor: valorPago,
            }],
        };

        // 4. Envia a nota para a SEFAZ
        const resultado = await nfe.enviar(corpoNFe);
        
        if (resultado.retorno.autorizado) {
             res.status(200).json({
                status: 'autorizada',
                message: 'NFC-e emitida com sucesso em ambiente de homologação!',
                protocolo: resultado.retorno.protocolo,
                xml: resultado.xml,
            });
        } else {
             res.status(400).json({
                status: 'rejeitada',
                message: 'NFC-e foi rejeitada pela SEFAZ.',
                detalhes: resultado.retorno.motivo,
            });
        }
    } catch (error) {
        console.error('--- ERRO AO EMITIR NFC-e ---', error);
        res.status(500).json({
            status: 'erro',
            message: 'Falha crítica ao tentar emitir NFC-e.',
            detalhes: error.message || 'Erro desconhecido.'
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