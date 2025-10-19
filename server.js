// Importa as bibliotecas necessárias
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg'); // Biblioteca para conectar ao PostgreSQL

// Inicializa a aplicação Express
const app = express();
app.use(cors());
app.use(express.json());

// --- Conexão com o Banco de Dados Neon ---
let pool;
try {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
  });
} catch (error) {
    console.error("Erro ao criar o Pool de conexão:", error);
    process.exit(1);
}

// --- Inicialização das Tabelas ---
async function initializeDatabase() {
  try {
    const createTablesQuery = `
      CREATE TABLE IF NOT EXISTS products (
        codigo TEXT PRIMARY KEY,
        nome TEXT NOT NULL,
        preco REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sales (
        id SERIAL PRIMARY KEY,
        data TIMESTAMPTZ NOT NULL,
        total REAL NOT NULL,
        valorPago REAL NOT NULL,
        troco REAL NOT NULL,
        itens JSONB NOT NULL
      );
    `;
    await pool.query(createTablesQuery);
    console.log('Banco de dados conectado e tabelas verificadas com sucesso!');
  } catch (error) {
    console.error('Erro fatal ao inicializar o banco de dados:', error);
    process.exit(1);
  }
}

// --- Definição das Rotas da API ---

app.get('/', (req, res) => {
  res.status(200).send('Servidor do PDV está a funcionar corretamente com PostgreSQL!');
});

app.get('/api/products', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM products ORDER BY nome');
    res.status(200).json(rows);
  } catch (error) {
    console.error('Erro ao buscar produtos:', error);
    res.status(500).json({ message: 'Erro interno ao buscar produtos.' });
  }
});

app.post('/api/products', async (req, res) => {
  const { codigo, nome, preco } = req.body;
  if (!codigo || !nome || preco === undefined) {
    return res.status(400).json({ message: 'Dados do produto incompletos ou inválidos.' });
  }
  try {
    await pool.query('INSERT INTO products (codigo, nome, preco) VALUES ($1, $2, $3)', [codigo, nome, preco]);
    res.status(201).json({ message: 'Produto criado com sucesso.' });
  } catch (error) {
    console.error('Erro ao criar produto:', error);
    res.status(500).json({ message: 'Erro interno ao criar o produto.' });
  }
});

app.delete('/api/products/:codigo', async (req, res) => {
  const { codigo } = req.params;
  try {
    const result = await pool.query('DELETE FROM products WHERE codigo = $1', [codigo]);
    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Produto não encontrado.' });
    }
    res.status(200).json({ message: 'Produto removido com sucesso.' });
  } catch (error) {
    console.error('Erro ao deletar produto:', error);
    res.status(500).json({ message: 'Erro interno ao deletar o produto.' });
  }
});

// Rota de Vendas ATUALIZADA com melhor log de erros
app.post('/api/sales', async (req, res) => {
  const { total, valorPago, troco, itens } = req.body;
  if (total === undefined || valorPago === undefined || !itens) {
    return res.status(400).json({ message: 'Dados da venda incompletos.' });
  }
  try {
    const dataVenda = new Date();
    // A biblioteca 'pg' lida com a conversão do array 'itens' para JSONB automaticamente.
    await pool.query('INSERT INTO sales (data, total, valorPago, troco, itens) VALUES ($1, $2, $3, $4, $5)', 
      [dataVenda, total, valorPago, troco, itens]);
    res.status(201).json({ message: 'Venda registada com sucesso.' });
  } catch (error) {
    console.error('--- DETALHES DO ERRO AO REGISTAR VENDA ---');
    console.error('Timestamp:', new Date().toISOString());
    console.error('Dados recebidos (body):', req.body);
    console.error('Erro completo:', error);
    res.status(500).json({ 
        message: 'Erro interno no servidor ao registar a venda.',
        error: error.message
    });
  }
});

// --- Inicialização do Servidor ---
const PORT = process.env.PORT || 3001;
initializeDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`Servidor a escutar na porta ${PORT}`);
  });
});