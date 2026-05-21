const express = require('express');
const Database = require('better-sqlite3');
const { nanoid } = require('nanoid');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ============================================
// BANCO DE DADOS
// ============================================
const db = new Database('promocoes.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS links (
    id TEXT PRIMARY KEY,
    url_original TEXT NOT NULL,
    produto TEXT,
    preco TEXT,
    cupom TEXT,
    grupo TEXT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS cliques (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    link_id TEXT,
    data_hora DATETIME DEFAULT CURRENT_TIMESTAMP,
    ip TEXT,
    user_agent TEXT,
    FOREIGN KEY (link_id) REFERENCES links(id)
  )
`);

// ============================================
// MIDDLEWARE DE LOG
// ============================================
app.use((req, res, next) => {
  console.log(`${new Date().toLocaleTimeString()} - ${req.method} ${req.url}`);
  next();
});

// ============================================
// ROTAS DA API
// ============================================

// 1. LISTAR TODOS OS LINKS
app.get('/api/links', (req, res) => {
  try {
    const links = db.prepare(`
      SELECT 
        l.id, l.produto, l.preco, l.cupom, l.grupo, 
        l.url_original, l.criado_em,
        COUNT(c.id) as cliques
      FROM links l
      LEFT JOIN cliques c ON c.link_id = l.id
      GROUP BY l.id
      ORDER BY l.criado_em DESC
      LIMIT 50
    `).all();
    
    res.json(links);
  } catch (erro) {
    console.error('Erro ao listar:', erro);
    res.status(500).json({ erro: 'Erro ao listar links' });
  }
});

// 2. CRIAR LINK
app.post('/api/criar', (req, res) => {
  const { url_original, produto, preco, cupom, grupo } = req.body;

  if (!url_original) {
    return res.status(400).json({ erro: 'URL original é obrigatória' });
  }

  let precoFormatado = '';
  if (preco && preco.trim() !== '') {
    const precoLimpo = preco.replace(',', '.').replace(/[^0-9.]/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(precoLimpo)) {
      return res.status(400).json({ erro: 'Formato de preço inválido' });
    }
    precoFormatado = `R$ ${parseFloat(precoLimpo).toFixed(2).replace('.', ',')}`;
  }

  const id = nanoid(8);

  try {
    db.prepare(
      'INSERT INTO links (id, url_original, produto, preco, cupom, grupo) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, url_original, produto || '', precoFormatado, cupom || '', grupo || '');

    const link_curto = `${req.protocol}://${req.get('host')}/${id}`;
    res.json({ sucesso: true, link_curto, id });
  } catch (erro) {
    console.error('Erro ao criar:', erro);
    res.status(500).json({ erro: 'Erro ao criar link' });
  }
});

// 3. EDITAR LINK
app.put('/api/editar/:id', (req, res) => {
  const { id } = req.params;
  const { url_original, produto, preco, cupom, grupo } = req.body;

  let precoFormatado = '';
  if (preco && preco.trim() !== '') {
    const precoLimpo = preco.replace(',', '.').replace(/[^0-9.]/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(precoLimpo)) {
      return res.status(400).json({ erro: 'Formato de preço inválido' });
    }
    precoFormatado = `R$ ${parseFloat(precoLimpo).toFixed(2).replace('.', ',')}`;
  }

  try {
    const result = db.prepare(
      'UPDATE links SET url_original = ?, produto = ?, preco = ?, cupom = ?, grupo = ? WHERE id = ?'
    ).run(url_original, produto, precoFormatado, cupom, grupo, id);

    if (result.changes === 0) {
      return res.status(404).json({ erro: 'Link não encontrado' });
    }

    res.json({ sucesso: true, mensagem: 'Link atualizado com sucesso' });
  } catch (erro) {
    console.error('Erro ao editar:', erro);
    res.status(500).json({ erro: 'Erro ao editar link' });
  }
});

// 4. EXCLUIR LINK
app.delete('/api/excluir/:id', (req, res) => {
  const { id } = req.params;

  try {
    db.prepare('DELETE FROM cliques WHERE link_id = ?').run(id);
    const result = db.prepare('DELETE FROM links WHERE id = ?').run(id);

    if (result.changes === 0) {
      return res.status(404).json({ erro: 'Link não encontrado' });
    }

    res.json({ sucesso: true, mensagem: 'Link excluído com sucesso' });
  } catch (erro) {
    console.error('Erro ao excluir:', erro);
    res.status(500).json({ erro: 'Erro ao excluir link' });
  }
});

// ============================================
// BOT DO WHATSAPP (DESABILITADO NO RAILWAY)
// ============================================
let botPronto = false;

// Rota para verificar status do bot
app.get('/api/bot/status', (req, res) => {
  res.json({
    conectado: false,
    mensagem: 'Bot disponível apenas localmente'
  });
});

// Rota simulada para grupos
app.get('/api/bot/grupos', (req, res) => {
  res.json([]);
});

// Rota simulada para publicar
app.post('/api/publicar/:id', (req, res) => {
  res.status(400).json({ 
    erro: 'Bot do WhatsApp não está disponível no servidor online',
    dica: 'Execute localmente para usar o bot'
  });
});

// ============================================
// REDIRECIONAMENTO
// ============================================
app.get('/:id', (req, res) => {
  const { id } = req.params;

  if (id === 'favicon.ico') return res.status(404).end();

  try {
    const link = db.prepare('SELECT * FROM links WHERE id = ?').get(id);
    
    if (!link) {
      return res.status(404).send('Link não encontrado');
    }

    db.prepare('INSERT INTO cliques (link_id, ip, user_agent) VALUES (?, ?, ?)')
      .run(id, req.ip, req.get('user-agent') || '');

    console.log(`✅ Clique registrado: ${link.produto}`);
    res.redirect(link.url_original);
  } catch (erro) {
    console.error('Erro:', erro);
    res.status(500).send('Erro interno');
  }
});

// ============================================
// INICIAR SERVIDOR
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📊 Painel disponível`);
});