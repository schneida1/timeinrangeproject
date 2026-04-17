// server.js — Betawise API proxy
// Run: ANTHROPIC_API_KEY=sk-ant-... node server.js
// Then open http://localhost:3000

const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));

// Serve your static HTML
app.use(express.static(path.join(__dirname, 'public')));

// Proxy to Anthropic API
app.post('/api/claude', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: { message: 'ANTHROPIC_API_KEY not set' } });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Anthropic API error:', err);
    res.status(502).json({ error: { message: 'Failed to reach Anthropic API' } });
  }
});

app.listen(PORT, () => {
  console.log(`Betawise running at http://localhost:${PORT}`);
});
