const express = require('express');
const db      = require('../db');
const router  = express.Router();

function requireAccess(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Non connecté' });
  next();
}

async function checkSubscription(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Non connecté' });
  if (req.session.isAdmin) return next();
  try {
    const user = await db.getUser(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Utilisateur non trouvé' });
    if (!user.is_approved)
      return res.status(403).json({ error: 'Compte en attente de validation', code: 'PENDING' });
    if (!user.subscription_expires_at || new Date(user.subscription_expires_at) <= new Date())
      return res.status(403).json({ error: 'Abonnement expiré', code: 'EXPIRED' });
    next();
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
}

router.get('/', checkSubscription, async (req, res) => {
  const { strategy, limit = 50 } = req.query;
  try {
    const rows = await db.getPredictions({ strategy: strategy || undefined, limit: parseInt(limit) || 50 });
    res.json(rows.map(formatPrediction));
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.get('/stats', checkSubscription, async (req, res) => {
  try {
    res.json(await db.getPredictionStats());
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.get('/stream', checkSubscription, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = async () => {
    try {
      const rows = await db.getPredictions({ limit: 100 });
      res.write(`data: ${JSON.stringify(rows.map(formatPrediction))}\n\n`);
      if (res.flush) res.flush();
    } catch (e) { console.error('SSE predictions error:', e.message); }
  };

  send();
  const interval = setInterval(send, 5000);
  req.on('close', () => clearInterval(interval));
});

const SUIT_DISPLAY = { '♠': '♠️', '♥': '❤️', '♦': '♦️', '♣': '♣️' };

function formatPrediction(p) {
  let playerCards = null, bankerCards = null;
  try { playerCards = typeof p.player_cards === 'string' ? JSON.parse(p.player_cards) : p.player_cards; } catch {}
  try { bankerCards = typeof p.banker_cards === 'string' ? JSON.parse(p.banker_cards) : p.banker_cards; } catch {}
  return {
    ...p,
    player_cards: playerCards,
    banker_cards: bankerCards,
    suit_display: SUIT_DISPLAY[p.predicted_suit] || p.predicted_suit,
    triggered_by_display: SUIT_DISPLAY[p.triggered_by] || p.triggered_by || '',
  };
}

module.exports = router;
