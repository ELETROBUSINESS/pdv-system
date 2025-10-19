// Importa as bibliotecas necessárias
const express = require('express');
const cors = require('cors');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');

const app = express();

// Configurações do servidor
app.use(cors()); // Habilita o CORS para aceitar requisições do seu HTML
app.use(express.json()); // Permite que o servidor entenda JSON

let db;

// Função assíncrona para conectar e preparar o banco de dados
async function initializeDatabase() {
  try {
    // Abre a conexão com o banco de dados. O arquivo será salvo em .data/ para ser persistente no Glitch
    db = await open({
      filename: './.data/pdv.db',
      driver: sqlite3.Database
    });

    // Cria as tabelas de produtos e vendas se elas ainda não existirem
    await db.exec(`
      CREATE TABLE IF NOT EXISTS products (
        codigo TEXT PRIMARY KEY,
        nome TEXT NOT NULL,
        preco REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sales (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        data TEXT NOT NULL,
        total REAL NOT NULL,
        valorPago REAL NOT NULL,
        troco REAL NOT NULL,
        itens TEXT NOT NULL
      );
    `);
    console.log('Banco de dados conectado e tabelas verificadas com sucesso!');
  } catch (error) {
    console.error('Erro ao inicializar o banco de dados:', error);
  }
}

// --- Endpoints da API ---

// Rota para buscar todos os produtos
app.get('/api/products', async (req, res) => {
  try {
    const products = await db.all('SELECT * FROM products');
    res.json(products);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar produtos.' });
  }
});

// Rota para criar um novo produto
app.post('/api/products', async (req, res) => {
  const { codigo, nome, preco } = req.body;
  if (!codigo || !nome || !preco) {
    return res.status(400).json({ error: 'Dados do produto incompletos.' });
  }
  try {
    await db.run('INSERT INTO products (codigo, nome, preco) VALUES (?, ?, ?)', [codigo, nome, preco]);
    res.status(201).json({ success: true, message: 'Produto criado com sucesso.' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao criar o produto.' });
  }
});

// Rota para deletar um produto
app.delete('/api/products/:codigo', async (req, res) => {
  const { codigo } = req.params;
  try {
    const result = await db.run('DELETE FROM products WHERE codigo = ?', codigo);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Produto não encontrado.' });
    }
    res.json({ success: true, message: 'Produto removido com sucesso.' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao deletar o produto.' });
  }
});

// Rota para registrar uma venda
app.post('/api/sales', async (req, res) => {
  const { total, valorPago, troco, itens } = req.body;
  try {
    const dataVenda = new Date().toISOString();
    const itensJson = JSON.stringify(itens);
    await db.run('INSERT INTO sales (data, total, valorPago, troco, itens) VALUES (?, ?, ?, ?, ?)', 
      [dataVenda, total, valorPago, troco, itensJson]);
    res.status(201).json({ success: true, message: 'Venda registrada com sucesso.' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao registrar a venda.' });
  }
});

// Inicia o servidor e o banco de dados
app.listen(process.env.PORT || 3000, async () => {
  await initializeDatabase();
  console.log(`Servidor rodando na porta ${process.env.PORT || 3000}`);
});
