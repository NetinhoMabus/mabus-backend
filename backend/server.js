require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('./database');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
app.use(cors({ origin: '*' }));
app.use(express.json());

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'mabus-secret-2026';
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || 'mabus2026';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDINHO_MCP_URL = process.env.CLAUDINHO_MCP_URL || 'https://mcp.mabus.com.br/mcp';

const BOARD_ACOMP = 79;
const BOARD_VENCIDOS = 132;
const STACK_HOMOLOGADO = 545;

// AUTH
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password !== PANEL_PASSWORD) return res.status(401).json({ error: 'Senha incorreta' });
  const token = jwt.sign({ role: 'equipe' }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token });
});

function auth(req, res, next) {
  try {
    req.user = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Token inválido' }); }
}

// CLAUDE + CLAUDINHO MCP
async function callClaudeWithMCP(prompt) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'mcp-client-2025-04-04'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      mcp_servers: [{ type: 'url', url: CLAUDINHO_MCP_URL, name: 'claudinho' }],
      system: 'Você é um assistente que lê dados do Nextcloud Deck da Mabus via MCP. Retorne APENAS JSON válido, sem markdown, sem texto adicional. O JSON deve começar com { e terminar com }.',
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) throw new Error(`Anthropic API ${response.status}: ${await response.text()}`);
  const data = await response.json();
  const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Sem JSON na resposta: ' + text.substring(0, 300));
  return JSON.parse(match[0]);
}

// SYNC via Claude + Claudinho
app.post('/api/sync', auth, async (req, res) => {
  try {
    const result = await callClaudeWithMCP(`
Use as ferramentas do MCP claudinho (deck_get_stacks e deck_get_cards) para:

1. Buscar todas as colunas do board ${BOARD_ACOMP} com deck_get_stacks board_id=${BOARD_ACOMP}
2. Para cada coluna retornada, buscar os cards com deck_get_cards board_id=${BOARD_ACOMP} stack_id=<id da coluna>
3. Buscar os cards homologados com deck_get_cards board_id=${BOARD_VENCIDOS} stack_id=${STACK_HOMOLOGADO}

Retorne APENAS este JSON exato:
{
  "acomp": [{"id": <number>, "title": "<string>", "stack": "<string>", "stackId": <number>, "duedate": "<string|null>", "createdAt": <number|null>, "labels": ["<string>"], "assignedUsers": ["<displayname>"]}],
  "homCards": [{"id": <number>, "title": "<string>", "stack": "Homologado", "stackId": ${STACK_HOMOLOGADO}, "duedate": "<string|null>", "createdAt": <number|null>, "labels": ["<string>"], "assignedUsers": ["<displayname>"]}],
  "syncedAt": "<ISO datetime>"
}
`);

    db.prepare(`INSERT INTO sync_cache (key, data, updated_at) VALUES ('last_sync', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`)
      .run(JSON.stringify(result));

    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('Sync error:', e.message);
    const cache = db.prepare('SELECT data FROM sync_cache WHERE key=?').get('last_sync');
    if (cache) return res.json({ ok: true, fromCache: true, ...JSON.parse(cache.data) });
    res.status(500).json({ error: e.message });
  }
});

// SYNC CACHE
app.get('/api/sync/cache', auth, (req, res) => {
  const cache = db.prepare('SELECT data, updated_at FROM sync_cache WHERE key=?').get('last_sync');
  if (!cache) return res.json({ acomp: [], homCards: [], syncedAt: null });
  res.json({ ...JSON.parse(cache.data), syncedAt: cache.updated_at });
});

// FINANCEIRO
app.get('/api/fin', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM financeiro').all();
  const fin = {};
  rows.forEach(r => { fin[r.card_id] = JSON.parse(r.data); });
  res.json(fin);
});
app.post('/api/fin/:cardId', auth, (req, res) => {
  db.prepare(`INSERT INTO financeiro (card_id, data, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(card_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`)
    .run(req.params.cardId, JSON.stringify(req.body));
  res.json({ ok: true });
});
app.delete('/api/fin/:cardId', auth, (req, res) => {
  db.prepare('DELETE FROM financeiro WHERE card_id=?').run(req.params.cardId);
  res.json({ ok: true });
});

// SNAPSHOTS
app.get('/api/snaps', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM snapshots ORDER BY created_at ASC').all().map(r => JSON.parse(r.data)));
});
app.post('/api/snaps', auth, (req, res) => {
  const s = req.body;
  db.prepare(`INSERT INTO snapshots (week_label, data, created_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(week_label) DO UPDATE SET data=excluded.data, created_at=excluded.created_at`)
    .run(s.wl, JSON.stringify(s));
  res.json({ ok: true });
});
app.delete('/api/snaps/:wl', auth, (req, res) => {
  db.prepare('DELETE FROM snapshots WHERE week_label=?').run(decodeURIComponent(req.params.wl));
  res.json({ ok: true });
});

// PLANILHA
app.post('/api/planilha', auth, upload.single('file'), (req, res) => {
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const pfSheet = wb.Sheets['Prosposta Final'] || wb.Sheets[wb.SheetNames.find(n => n.toLowerCase().includes('final')) || wb.SheetNames[0]];
    const pfRaw = XLSX.utils.sheet_to_json(pfSheet, { header: 1, defval: null });
    const municipio = String(pfRaw[0]?.[6] || pfRaw[0]?.[1] || '').trim();
    let totalVenda = 0;
    for (const row of pfRaw) {
      if (row && String(row[1] || '').includes('Total da Proposta')) {
        totalVenda = parseFloat(String(row[3] || '0').replace(',', '.')) || 0; break;
      }
    }
    const ivName = wb.SheetNames.find(n => n.toLowerCase().includes('vencedor'));
    let totalCusto = 0, totalComissao = 0, cotador = '', lances = '';
    if (ivName) {
      for (const row of XLSX.utils.sheet_to_json(wb.Sheets[ivName], { defval: null })) {
        if (String(row['Vencedor'] || '').trim().toUpperCase() !== 'SIM') continue;
        const qty = parseFloat(row['Quantidade '] || row['Quantidade'] || 1) || 1;
        totalCusto += (parseFloat(row['Valor de Compra Previsto'] || 0) || 0) * qty;
        totalComissao += parseFloat(row['R$ Comissão Prevista'] || 0) || 0;
        if (!cotador && row['Responsável Pela Cotação']) cotador = String(row['Responsável Pela Cotação']).trim();
        if (!lances && row['Responsável pelos Lances']) lances = String(row['Responsável pelos Lances']).trim();
      }
    }
    const result = { municipio, filename: req.file.originalname, totalVenda: Math.round(totalVenda), totalCusto: Math.round(totalCusto), totalComissao: Math.round(totalComissao), cotador, lances };
    db.prepare(`INSERT INTO planilhas (filename, municipio, data, updated_at) VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(filename) DO UPDATE SET municipio=excluded.municipio, data=excluded.data, updated_at=excluded.updated_at`)
      .run(req.file.originalname, municipio, JSON.stringify(result));
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/planilhas', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM planilhas').all().map(r => JSON.parse(r.data)));
});
app.delete('/api/planilhas/:filename', auth, (req, res) => {
  db.prepare('DELETE FROM planilhas WHERE filename=?').run(decodeURIComponent(req.params.filename));
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.listen(PORT, () => console.log(`Mabus API rodando na porta ${PORT}`));
