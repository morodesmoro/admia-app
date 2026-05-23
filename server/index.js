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

  // Keep last 10 messages
  const messages = [
    { role: 'system', content: 'Vous êtes Admia, une assistante administrative professionnelle et concise en français.' },
    ...history.slice(-10)
  ];

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

app.listen(PORT, () => {
  console.log(`Admia backend running on http://localhost:${PORT}`);
});
