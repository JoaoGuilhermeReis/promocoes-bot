const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { nanoid } = require('nanoid');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ============================================
// BANCO DE DADOS
// ============================================
const db = new sqlite3.Database('promocoes.db');

db.serialize(() => {
  db.run(`
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

  db.run(`
    CREATE TABLE IF NOT EXISTS cliques (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      link_id TEXT,
      data_hora DATETIME DEFAULT CURRENT_TIMESTAMP,
      ip TEXT,
      user_agent TEXT,
      FOREIGN KEY (link_id) REFERENCES links(id)
    )
  `);
});

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
  db.all(`
    SELECT 
      l.id,
      l.produto,
      l.preco,
      l.cupom,
      l.grupo,
      l.url_original,
      l.criado_em,
      COUNT(c.id) as cliques
    FROM links l
    LEFT JOIN cliques c ON c.link_id = l.id
    GROUP BY l.id
    ORDER BY l.criado_em DESC
    LIMIT 50
  `, (err, rows) => {
    if (err) {
      console.error('Erro ao listar:', err);
      return res.status(500).json({ erro: 'Erro ao listar links' });
    }
    res.json(rows);
  });
});

// 2. CRIAR LINK
app.post('/api/criar', (req, res) => {
  const { url_original, produto, preco, cupom, grupo } = req.body;

  if (!url_original) {
    return res.status(400).json({ erro: 'URL original é obrigatória' });
  }

  // Validação do preço
  let precoFormatado = '';
  if (preco && preco.trim() !== '') {
    const precoLimpo = preco.replace(',', '.').replace(/[^0-9.]/g, '');
    
    if (!/^\d+(\.\d{1,2})?$/.test(precoLimpo)) {
      return res.status(400).json({ erro: 'Formato de preço inválido' });
    }
    
    precoFormatado = `R$ ${parseFloat(precoLimpo).toFixed(2).replace('.', ',')}`;
  }

  const id = nanoid(8);

  db.run(
    'INSERT INTO links (id, url_original, produto, preco, cupom, grupo) VALUES (?, ?, ?, ?, ?, ?)',
    [id, url_original, produto || '', precoFormatado, cupom || '', grupo || ''],
    function(err) {
      if (err) {
        console.error('Erro ao criar:', err);
        return res.status(500).json({ erro: 'Erro ao criar link' });
      }

      const link_curto = `${req.protocol}://${req.get('host')}/${id}`;
      res.json({
        sucesso: true,
        link_curto: link_curto,
        id: id
      });
    }
  );
});

// 3. ESTATÍSTICAS DE UM LINK ESPECÍFICO
app.get('/api/stats/:id', (req, res) => {
  const { id } = req.params;

  db.get('SELECT * FROM links WHERE id = ?', [id], (err, link) => {
    if (err || !link) {
      return res.status(404).json({ erro: 'Link não encontrado' });
    }

    db.get('SELECT COUNT(*) as total FROM cliques WHERE link_id = ?', [id], (err, result) => {
      db.get('SELECT COUNT(DISTINCT ip) as unicos FROM cliques WHERE link_id = ?', [id], (err, unicos) => {
        res.json({
          produto: link.produto,
          preco: link.preco,
          grupo: link.grupo,
          link_curto: `${req.protocol}://${req.get('host')}/${id}`,
          cliques_total: result.total,
          cliques_unicos: unicos.unicos,
          criado_em: link.criado_em
        });
      });
    });
  });
});

// 4. EDITAR LINK
app.put('/api/editar/:id', (req, res) => {
  const { id } = req.params;
  const { url_original, produto, preco, cupom, grupo } = req.body;

  // Validação do preço
  let precoFormatado = '';
  if (preco && preco.trim() !== '') {
    const precoLimpo = preco.replace(',', '.').replace(/[^0-9.]/g, '');
    
    if (!/^\d+(\.\d{1,2})?$/.test(precoLimpo)) {
      return res.status(400).json({ erro: 'Formato de preço inválido' });
    }
    
    precoFormatado = `R$ ${parseFloat(precoLimpo).toFixed(2).replace('.', ',')}`;
  }

  db.run(
    `UPDATE links 
     SET url_original = ?, produto = ?, preco = ?, cupom = ?, grupo = ?
     WHERE id = ?`,
    [url_original, produto, precoFormatado, cupom, grupo, id],
    function(err) {
      if (err) {
        console.error('Erro ao editar:', err);
        return res.status(500).json({ erro: 'Erro ao editar link' });
      }
      
      if (this.changes === 0) {
        return res.status(404).json({ erro: 'Link não encontrado' });
      }

      res.json({ sucesso: true, mensagem: 'Link atualizado com sucesso' });
    }
  );
});

// 5. EXCLUIR LINK
app.delete('/api/excluir/:id', (req, res) => {
  const { id } = req.params;

  db.run('DELETE FROM cliques WHERE link_id = ?', [id], (err) => {
    if (err) {
      console.error('Erro ao excluir cliques:', err);
      return res.status(500).json({ erro: 'Erro ao excluir cliques do link' });
    }

    db.run('DELETE FROM links WHERE id = ?', [id], function(err) {
      if (err) {
        console.error('Erro ao excluir link:', err);
        return res.status(500).json({ erro: 'Erro ao excluir link' });
      }

      if (this.changes === 0) {
        return res.status(404).json({ erro: 'Link não encontrado' });
      }

      res.json({ sucesso: true, mensagem: 'Link excluído com sucesso' });
    });
  });
});

// ============================================
// BOT DO WHATSAPP
// ============================================
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');

let sock = null;
let botPronto = false;

async function iniciarBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_bot');
  
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, qr, lastDisconnect } = update;
    
    if (qr) {
      console.log('\n🤖 ESCANEIE O QR CODE ABAIXO COM O WHATSAPP DO BOT:\n');
      qrcode.generate(qr, { small: true });
    }
    
    if (connection === 'open') {
      botPronto = true;
      console.log('✅ Bot conectado ao WhatsApp!');
    }
    
    if (connection === 'close') {
      botPronto = false;
      const motivo = lastDisconnect?.error?.output?.statusCode;
      
      if (motivo !== DisconnectReason.loggedOut) {
        console.log('🔄 Reconectando...');
        iniciarBot();
      } else {
        console.log('❌ Bot desconectado. Delete a pasta auth_bot e reinicie.');
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

async function publicarNoGrupo(linkId) {
  return new Promise((resolve, reject) => {
    if (!botPronto || !sock) {
      return reject(new Error('Bot não está conectado ao WhatsApp'));
    }

    db.get('SELECT * FROM links WHERE id = ?', [linkId], async (err, link) => {
      if (err || !link) {
        return reject(new Error('Link não encontrado'));
      }

      try {
        const grupos = await sock.groupFetchAllParticipating();
        const gruposLista = Object.values(grupos);
        
        if (gruposLista.length === 0) {
          return reject(new Error('Bot não está em nenhum grupo. Adicione o número do bot ao grupo primeiro.'));
        }

        const grupoAlvo = gruposLista[0];
        const grupoId = grupoAlvo.id;

        const linkCurto = `http://localhost:3000/${link.id}`;
        let mensagem = `*${link.produto}*\n\n`;
        
        if (link.preco) {
          mensagem += `💰 ${link.preco}\n\n`;
        }
        
        if (link.cupom) {
          mensagem += `🎟️ Resgate todos os cupons aqui:\n${link.cupom}\n\n`;
        }
        
        mensagem += `✅ Link do produto: 👇\n➡️ ${linkCurto}`;

        await sock.sendMessage(grupoId, { 
          text: mensagem,
          linkPreview: false
        });

        console.log(`✅ Publicado no grupo "${grupoAlvo.subject}": ${link.produto}`);
        
        resolve({
          sucesso: true,
          grupo: grupoAlvo.subject,
          mensagem: 'Publicado com sucesso!'
        });

      } catch (erro) {
        console.error('Erro ao publicar:', erro);
        reject(new Error('Erro ao enviar mensagem para o grupo'));
      }
    });
  });
}

// Rota para publicar
app.post('/api/publicar/:id', async (req, res) => {
  try {
    const resultado = await publicarNoGrupo(req.params.id);
    res.json(resultado);
  } catch (erro) {
    res.status(500).json({ 
      erro: erro.message,
      dica: 'Verifique se o bot está conectado e no grupo'
    });
  }
});

// Rota para verificar status do bot
app.get('/api/bot/status', (req, res) => {
  res.json({
    conectado: botPronto,
    mensagem: botPronto ? 'Bot online e pronto para publicar' : 'Bot desconectado'
  });
});

// Iniciar bot ao ligar servidor
iniciarBot();

// ============================================
// REDIRECIONAMENTO - DEVE SER A ÚLTIMA ROTA!
// ============================================
app.get('/:id', (req, res) => {
  const { id } = req.params;

  if (id === 'favicon.ico') {
    return res.status(404).end();
  }

  console.log(`🔗 Redirecionando ID: ${id}`);

  db.get('SELECT * FROM links WHERE id = ?', [id], (err, link) => {
    if (err) {
      console.error('Erro no banco:', err);
      return res.status(500).send('Erro interno');
    }
    
    if (!link) {
      console.log('❌ Link não encontrado:', id);
      return res.status(404).send('Link não encontrado');
    }

    db.run(
      'INSERT INTO cliques (link_id, ip, user_agent) VALUES (?, ?, ?)',
      [id, req.ip, req.get('user-agent') || ''],
      (err) => {
        if (err) {
          console.error('Erro ao registrar clique:', err);
        } else {
          console.log(`✅ Clique registrado para: ${link.produto}`);
        }
      }
    );

    console.log(`➡️ Redirecionando para: ${link.url_original}`);
    res.redirect(link.url_original);
  });
});

// ============================================
// INICIAR SERVIDOR
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
  console.log(`📊 Painel: http://localhost:${PORT}`);
});