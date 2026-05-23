const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
app.use(express.json());

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));

const PORT = process.env.PORT || 3000;

// Simple in-memory session history (not persistent)
const sessions = new Map();

app.post('/api/chat', async (req, res) => {
  const { message, sessionId } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });

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

    res.json({ reply: bot });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Admia backend running on http://localhost:${PORT}`);
});
