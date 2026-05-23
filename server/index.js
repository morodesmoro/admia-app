const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const bcrypt = require('bcrypt');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(express.json());

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));

const PORT = process.env.PORT || 3000;

// Simple in-memory session history (not persistent)
const sessions = new Map();
// sessionId -> email
const sessionUsers = new Map();

const USERS_FILE = path.join(__dirname, '..', 'server_users.json');

async function loadUsers() {
  try {
    const txt = await fs.readFile(USERS_FILE, 'utf8');
    return JSON.parse(txt);
  } catch (e) {
    return [];
  }
}

async function saveUsers(users) {
  await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
}

function makeSessionId() {
  return crypto.randomBytes(16).toString('hex');
}

// --- Vector store (SQLite) ---
const Database = require('better-sqlite3');
const DB_FILE = path.join(__dirname, '..', 'server_data.db');
const db = new Database(DB_FILE);

db.exec(`
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  owner TEXT,
  content TEXT,
  embedding TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sessionId TEXT,
  role TEXT,
  content TEXT,
  created_at INTEGER
);
`);

async function getEmbedding(text) {
  const model = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
  const resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({ model, input: text })
  });
  if (!resp.ok) throw new Error('Embedding request failed');
  const data = await resp.json();
  return data.data?.[0]?.embedding || null;
}

function storeDocument(id, owner, content, embedding) {
  const stmt = db.prepare('INSERT OR REPLACE INTO documents (id, owner, content, embedding, created_at) VALUES (?, ?, ?, ?, ?)');
  stmt.run(id, owner, content, JSON.stringify(embedding), Date.now());
}

function storeMessage(sessionId, role, content) {
  const stmt = db.prepare('INSERT INTO messages (sessionId, role, content, created_at) VALUES (?, ?, ?, ?)');
  stmt.run(sessionId, role, content, Date.now());
}

function allDocuments() {
  const stmt = db.prepare('SELECT id, owner, content, embedding, created_at FROM documents');
  return stmt.all();
}

function cosine(a, b) {
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function searchDocsByEmbedding(queryEmbedding, topK = 3) {
  const docs = allDocuments();
  const scored = [];
  for (const d of docs) {
    try {
      const emb = JSON.parse(d.embedding);
      const score = cosine(queryEmbedding, emb);
      scored.push({ id: d.id, owner: d.owner, content: d.content, score });
    } catch (e) { continue; }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

app.post('/api/chat', async (req, res) => {
  const { message, sessionId } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });

  const users = await loadUsers();
  const email = sessionUsers.get(sessionId) || null;
  const user = users.find(u => u.email === email);

  // Rate limiting / message limit handled server-side
  if (user) {
    if (user.lockUntil && Date.now() < user.lockUntil) {
      return res.status(403).json({ error: 'locked', lockUntil: user.lockUntil });
    }
  }

  const history = sessions.get(sessionId) || [];
  history.push({ role: 'user', content: message });

  // Keep last 10 messages from DB
  const recentStmt = db.prepare('SELECT role, content FROM messages WHERE sessionId = ? ORDER BY id DESC LIMIT 10');
  const recent = recentStmt.all(sessionId).reverse().map(r => ({ role: r.role, content: r.content }));

  // RAG: retrieve relevant documents
  let ragContext = '';
  try {
    const qEmb = await getEmbedding(message);
    const hits = searchDocsByEmbedding(qEmb, 3);
    if (hits.length) {
      ragContext = 'Contexte pertinent trouv\u00e9 :\n' + hits.map((h, i) => `${i+1}. ${h.content.substring(0, 500)} (score:${h.score.toFixed(3)})`).join('\n');
    }
  } catch (e) {
    console.error('RAG error', e.message);
  }

  const systemPrompt = 'Vous êtes Admia, une assistante administrative professionnelle et concise en fran\u00e7ais. Toujours fournissez des instructions claires, proposez des modèles de lettres, et mentionnez les sources si vous utilisez des documents fournis.' + (ragContext ? '\n' + ragContext : '');

  const messages = [ { role: 'system', content: systemPrompt }, ...recent, { role: 'user', content: message } ];

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages,
        max_tokens: 800,
        temperature: 0.2
      })
    });

    if (!resp.ok) {
      const text = await resp.text();
      return res.status(500).json({ error: text });
    }

    const data = await resp.json();
    const bot = data.choices?.[0]?.message?.content || 'Désolé, je ne peux pas répondre pour le moment.';

    history.push({ role: 'assistant', content: bot });
    sessions.set(sessionId, history);
    // persist messages
    storeMessage(sessionId, 'user', message);
    storeMessage(sessionId, 'assistant', bot);

    // increment messageCount if we have a user
    if (user) {
      user.messageCount = (user.messageCount || 0) + 1;
      if (user.messageCount >= (process.env.MESSAGE_LIMIT ? parseInt(process.env.MESSAGE_LIMIT) : 8)) {
        user.lockUntil = Date.now() + (process.env.LOCK_TIME_MS ? parseInt(process.env.LOCK_TIME_MS) : (10 * 60 * 60 * 1000));
      }
      await saveUsers(users);
    }

    res.json({ reply: bot });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Register endpoint
app.post('/api/register', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const users = await loadUsers();
  if (users.find(u => u.email === email)) return res.status(409).json({ error: 'exists' });

  const hash = await bcrypt.hash(password, 10);
  const newUser = { email, passwordHash: hash, messageCount: 0, lockUntil: null };
  users.push(newUser);
  await saveUsers(users);

  const sessionId = makeSessionId();
  sessionUsers.set(sessionId, email);

  // create initial user doc table entries (no documents yet)
  res.json({ sessionId, email });
});

// Login endpoint
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const users = await loadUsers();
  const user = users.find(u => u.email === email);
  if (!user) return res.status(401).json({ error: 'invalid' });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'invalid' });

  const sessionId = makeSessionId();
  sessionUsers.set(sessionId, email);

  res.json({ sessionId, email });
});

// Me endpoint
app.get('/api/me', async (req, res) => {
  const sessionId = req.query.sessionId;
  const email = sessionUsers.get(sessionId) || null;
  if (!email) return res.status(401).json({ error: 'not authenticated' });
  const users = await loadUsers();
  const user = users.find(u => u.email === email);
  if (!user) return res.status(404).json({ error: 'not found' });
  res.json({ email: user.email, messageCount: user.messageCount || 0, lockUntil: user.lockUntil || null });
});

// Add document endpoint
app.post('/api/docs', async (req, res) => {
  const { content, sessionId } = req.body || {};
  if (!content) return res.status(400).json({ error: 'content required' });
  const email = sessionUsers.get(sessionId) || null;
  try {
    const emb = await getEmbedding(content);
    const id = crypto.randomBytes(8).toString('hex');
    storeDocument(id, email, content, emb);
    res.json({ id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Search documents
app.post('/api/search', async (req, res) => {
  const { query, topK = 3 } = req.body || {};
  if (!query) return res.status(400).json({ error: 'query required' });
  try {
    const qEmb = await getEmbedding(query);
    const hits = searchDocsByEmbedding(qEmb, topK);
    res.json({ hits });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Admia backend running on http://localhost:${PORT}`);
});
