// Importa as bibliotecas necessárias
const express = require('express');
const cors = require('cors');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const path = require('path');

// Inicializa a aplicação Express
const app = express();

// --- Configurações (Middlewares) ---
// Habilita o CORS para permitir que o seu ficheiro HTML comunique com este servidor
app.use(cors());
// Habilita o servidor a entender e processar dados no formato JSON
app.use(express.json());

// Variável para guardar a conexão com o banco de dados
let db;

// O Render fornece um disco persistente (que não apaga) no caminho '/var/data'
// Usaremos este caminho para guardar o nosso ficheiro de banco de dados.
const dbPath = '/var/data/pdv.db';

// --- Inicialização do Banco de Dados ---
// Função que conecta ao banco de dados e cria as tabelas se não existirem
async function initializeDatabase() {
  try {
    db = await open({
      filename: dbPath,
      driver: sqlite3.Database
    });

    // Executa o comando SQL para criar as tabelas
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
    console.log(`Banco de dados conectado com sucesso em: ${dbPath}`);
  } catch (error) {
    console.error('Erro fatal ao inicializar o banco de dados:', error);
    // Se o banco de dados não iniciar, o servidor não deve continuar
    process.exit(1); 
  }
}

// --- Definição das Rotas da API ---

// Rota principal para verificar se o servidor está online
app.get('/', (req, res) => {
  res.status(200).send('Servidor do PDV está a funcionar corretamente!');
});

// Rota para BUSCAR todos os produtos
app.get('/api/products', async (req, res) => {
  try {
    const products = await db.all('SELECT * FROM products ORDER BY nome');
    res.status(200).json(products);
  } catch (error) {
    console.error('Erro ao buscar produtos:', error);
    res.status(500).json({ message: 'Erro interno ao buscar produtos.' });
  }
});

// Rota para CRIAR um novo produto
app.post('/api/products', async (req, res) => {
  const { codigo, nome, preco } = req.body;
  if (!codigo || !nome || preco === undefined) {
    return res.status(400).json({ message: 'Dados do produto incompletos ou inválidos.' });
  }
  try {
    await db.run('INSERT INTO products (codigo, nome, preco) VALUES (?, ?, ?)', [codigo, nome, preco]);
    res.status(201).json({ message: 'Produto criado com sucesso.' });
  } catch (error) {
    console.error('Erro ao criar produto:', error);
    res.status(500).json({ message: 'Erro interno ao criar o produto.' });
  }
});

// Rota para DELETAR um produto
app.delete('/api/products/:codigo', async (req, res) => {
  const { codigo } = req.params;
  try {
    const result = await db.run('DELETE FROM products WHERE codigo = ?', codigo);
    if (result.changes === 0) {
      return res.status(404).json({ message: 'Produto não encontrado.' });
    }
    res.status(200).json({ message: 'Produto removido com sucesso.' });
  } catch (error) {
    console.error('Erro ao deletar produto:', error);
    res.status(500).json({ message: 'Erro interno ao deletar o produto.' });
  }
});

// Rota para REGISTAR uma nova venda
app.post('/api/sales', async (req, res) => {
  const { total, valorPago, troco, itens } = req.body;
  if (total === undefined || valorPago === undefined || !itens) {
      return res.status(400).json({ message: 'Dados da venda incompletos.' });
  }
  try {
    const dataVenda = new Date().toISOString();
    const itensJson = JSON.stringify(itens);
    await db.run('INSERT INTO sales (data, total, valorPago, troco, itens) VALUES (?, ?, ?, ?, ?)', 
      [dataVenda, total, valorPago, troco, itensJson]);
    res.status(201).json({ message: 'Venda registada com sucesso.' });
  } catch (error) {
    console.error('Erro ao registar venda:', error);
    res.status(500).json({ message: 'Erro interno ao registar a venda.' });
  }
});


// --- Inicialização do Servidor ---
// O Render define a porta automaticamente através da variável de ambiente PORT
const PORT = process.env.PORT || 3001;

// Inicia o banco de dados primeiro e, depois, o servidor
initializeDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`Servidor a escutar na porta ${PORT}`);
    });
});