import os
import json
from flask import Flask, request, jsonify
from flask_cors import CORS
import psycopg2
from psycopg2 import pool

# --- Importação da PyNFe ---
# (A biblioteca pode ter uma estrutura de importação diferente dependendo da versão, esta é a mais comum)
# Assumimos que a biblioteca está instalada e configurada no ambiente
from pynfe.processamento.nfe import ProcessarNFe
from pynfe.entidades.cliente import Cliente
from pynfe.entidades.emitente import Emitente
from pynfe.entidades.produto import Produto
from pynfe.entidades.transporte import Transporte
from pynfe.utils.flags import CODIGO_UF

# --- Configuração Inicial ---
app = Flask(__name__)
CORS(app)  # Habilita o CORS para a nossa aplicação

# --- Conexão com o Banco de Dados (PostgreSQL) ---
# Usamos um "pool" de conexões para eficiência
db_pool = psycopg2.pool.SimpleConnectionPool(
    1, 10, dsn=os.environ.get('DATABASE_URL')
)

def get_db_connection():
    return db_pool.getconn()

def put_db_connection(conn):
    db_pool.putconn(conn)

# --- Inicialização das Tabelas ---
def initialize_database():
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS products (
                    codigo TEXT PRIMARY KEY,
                    nome TEXT NOT NULL,
                    preco REAL NOT NULL
                );
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS sales (
                    id SERIAL PRIMARY KEY,
                    data TIMESTAMPTZ NOT NULL,
                    total REAL NOT NULL,
                    valorPago REAL NOT NULL,
                    troco REAL NOT NULL,
                    itens JSONB NOT NULL
                );
            """)
            conn.commit()
            print("Banco de dados conectado e tabelas verificadas!")
    except Exception as e:
        print(f"Erro fatal ao inicializar o banco de dados: {e}")
    finally:
        put_db_connection(conn)

# --- Rotas da API ---

@app.route('/')
def health_check():
    return "Servidor do PDV em Python está a funcionar!"

# Rotas de Produtos
@app.route('/api/products', methods=['GET', 'POST'])
def handle_products():
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            if request.method == 'GET':
                cur.execute('SELECT * FROM products ORDER BY nome;')
                products = [dict((cur.description[i][0], value) \
                           for i, value in enumerate(row)) for row in cur.fetchall()]
                return jsonify(products)

            if request.method == 'POST':
                data = request.json
                cur.execute('INSERT INTO products (codigo, nome, preco) VALUES (%s, %s, %s);',
                            (data['codigo'], data['nome'], data['preco']))
                conn.commit()
                return jsonify({'message': 'Produto criado com sucesso.'}), 201
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        put_db_connection(conn)

@app.route('/api/products/<string:codigo>', methods=['DELETE'])
def handle_single_product(codigo):
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute('DELETE FROM products WHERE codigo = %s;', (codigo,))
            conn.commit()
            if cur.rowcount == 0:
                return jsonify({'error': 'Produto não encontrado.'}), 404
            return jsonify({'message': 'Produto removido com sucesso.'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        put_db_connection(conn)

# Rota de Vendas
@app.route('/api/sales', methods=['POST'])
def handle_sales():
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            data = request.json
            cur.execute('INSERT INTO sales (data, total, valorPago, troco, itens) VALUES (NOW(), %s, %s, %s, %s);',
                        (data['total'], data['valorPago'], data['troco'], json.dumps(data['itens'])))
            conn.commit()
            return jsonify({'message': 'Venda registada com sucesso.'}), 201
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        put_db_connection(conn)


# --- Rota de Emissão de NFC-e com PyNFe ---
@app.route('/api/emitir-nfce', methods=['POST'])
def emitir_nfce():
    venda = request.json
    try:
        # 1. Carregar certificado do Secret File do Render
        cert_path = '/etc/secrets/certificado.pfx'
        cert_password = os.environ.get('CERTIFICATE_PASSWORD')

        # 2. Configurar o emitente com dados das variáveis de ambiente
        emitente = Emitente(
            razao_social=os.environ.get('EMIT_RAZAO_SOCIAL'),
            cnpj=os.environ.get('EMIT_CNPJ'),
            inscricao_estadual=os.environ.get('EMIT_IE'),
            rua=os.environ.get('EMIT_LOGRADOURO'),
            numero=os.environ.get('EMIT_NUMERO'),
            bairro=os.environ.get('EMIT_BAIRRO'),
            cidade=os.environ.get('EMIT_MUN_CODE'), # PyNFe usa o código IBGE
            estado=os.environ.get('EMIT_UF'),
            cep=os.environ.get('EMIT_CEP'),
        )

        # 3. Mapear os produtos do carrinho para o formato da PyNFe
        produtos_pynfe = []
        for index, item in enumerate(venda['itens']):
            produto = Produto(
                item=index + 1,
                codigo=item['codigo'],
                descricao=item['nome'],
                ncm='22021000', # ATENÇÃO: Usar o NCM correto
                cfop='5102',
                unidade='UN',
                quantidade=item['quantidade'],
                valor_unitario=item['preco'],
                impostos=None # Em um sistema real, os impostos seriam calculados
            )
            produtos_pynfe.append(produto)

        # 4. Configurar e processar a nota
        # A PyNFe lida internamente com a montagem do XML e comunicação
        nota = ProcessarNFe(
            certificado_pfx=cert_path,
            senha=cert_password,
            uf=CODIGO_UF[os.environ.get('EMIT_UF')],
            ambiente=2,  # 2=Homologação
            emitente=emitente,
            produtos=produtos_pynfe,
            # Em um sistema real, você adicionaria o cliente (destinatário)
            cliente=Cliente(nome='NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO'),
            transporte=Transporte(), # Transporte padrão
            modelo=65, # 65 = NFC-e
            csc_id=os.environ.get('CSC_ID'),
            csc=os.environ.get('CSC_TOKEN')
        )
        
        # O método .enviar() retorna o resultado da SEFAZ
        resultado = nota.enviar()

        if resultado['cStat'] == '100': # 100 = Autorizado o uso da NF-e
            return jsonify({
                'status': 'autorizada',
                'message': 'NFC-e emitida com sucesso em ambiente de homologação!',
                'protocolo': resultado['nProt'],
                'xml': resultado['xml']
            })
        else:
            return jsonify({
                'status': 'rejeitada',
                'message': 'NFC-e foi rejeitada pela SEFAZ.',
                'detalhes': resultado['xMotivo']
            }), 400

    except Exception as e:
        print(f"--- ERRO AO EMITIR NFC-e COM PyNFe ---: {e}")
        return jsonify({
            'status': 'erro',
            'message': 'Falha crítica ao tentar emitir NFC-e.',
            'detalhes': str(e)
        }), 500


# --- Inicialização ---
if __name__ == '__main__':
    initialize_database()
    # A porta é definida pelo Render
    port = int(os.environ.get("PORT", 5000))
    app.run(host='0.0.0.0', port=port)