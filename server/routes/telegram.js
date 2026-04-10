const express = require('express');
const router  = express.Router();
const tg      = require('../services/telegram');
const db      = require('../db');

function requireAdmin(req, res, next) {
  if (!req.session.userId || !req.session.isAdmin) return res.status(403).json({ error: 'Admin requis' });
  next();
}
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Non connecté' });
  next();
}

// GET /channels
router.get('/channels', requireAuth, async (req, res) => {
  try {
    const all = tg.getChannels();
    if (req.session.isAdmin) return res.json(all);
    const hidden = new Set(await db.getHiddenChannels(req.session.userId));
    res.json(all.filter(ch => !hidden.has(ch.dbId)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /channels
router.post('/channels', requireAdmin, async (req, res) => {
  const { channel_id } = req.body;
  if (!channel_id) return res.status(400).json({ error: 'channel_id requis' });
  if (tg.getChannels().length >= 10)
    return res.status(400).json({ error: 'Maximum 10 canaux atteint' });
  try {
    const info = await tg.testChannel(channel_id);
    const row  = await tg.addChannel(info.id, info.name);
    res.json({ ok: true, channel: { dbId: row.id, tgId: info.id, name: info.name } });
  } catch (e) {
    res.status(400).json({ error: `Impossible de joindre le canal : ${e.message}` });
  }
});

// DELETE /channels/:id
router.delete('/channels/:id', requireAdmin, async (req, res) => {
  const dbId = parseInt(req.params.id);
  if (isNaN(dbId)) return res.status(400).json({ error: 'ID invalide' });
  try { await tg.removeChannel(dbId); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /messages
router.get('/messages', requireAuth, async (req, res) => {
  const dbId = parseInt(req.query.channel_db_id);
  if (isNaN(dbId)) return res.status(400).json({ error: 'channel_db_id requis' });
  if (!req.session.isAdmin) {
    const hidden = new Set(await db.getHiddenChannels(req.session.userId));
    if (hidden.has(dbId)) return res.status(403).json({ error: 'Canal non autorisé' });
  }
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  res.json(tg.getMessages(dbId).slice(0, limit));
});

// GET /status
router.get('/status', requireAuth, (req, res) => {
  res.json({ ...tg.getStatus(), token_set: !!tg.getToken() });
});

// GET /bot-token
router.get('/bot-token', requireAdmin, (req, res) => {
  const t = tg.getToken();
  res.json({ token_set: !!t, token_preview: t ? `${t.slice(0, 6)}…${t.slice(-4)}` : null });
});

// POST /bot-token
router.post('/bot-token', requireAdmin, async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string' || token.trim().length < 20)
    return res.status(400).json({ error: 'Token invalide (format: 1234567890:ABC...)' });
  try {
    await tg.saveToken(token.trim());
    if (tg.getChannels().length > 0) tg.startBotPublic();
    const t = token.trim();
    res.json({ ok: true, token_preview: `${t.slice(0, 6)}…${t.slice(-4)}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /bot-token
router.delete('/bot-token', requireAdmin, async (req, res) => {
  try { await db.deleteSetting('bot_token'); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /stream (SSE)
router.get('/stream', requireAuth, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const userId  = req.session.userId;
  const isAdmin = req.session.isAdmin;
  const all     = tg.getChannels();
  let visible;
  if (isAdmin) {
    visible = all;
  } else {
    const hidden = new Set(await db.getHiddenChannels(userId));
    visible = all.filter(ch => !hidden.has(ch.dbId));
  }

  const init = visible.map(ch => ({ dbId: ch.dbId, name: ch.name, messages: tg.getMessages(ch.dbId).slice(0, 50) }));
  res.write(`data: ${JSON.stringify({ type: 'init', channels: init })}\n\n`);
  if (res.flush) res.flush();

  await tg.addSSEClient(res, userId, isAdmin);
  req.on('close', () => tg.removeSSEClient(res));
});

// GET /users/:userId/visibility
router.get('/users/:userId/visibility', requireAdmin, async (req, res) => {
  const userId = parseInt(req.params.userId);
  try {
    res.json({ hidden: await db.getHiddenChannels(userId) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /users/:userId/visibility
router.put('/users/:userId/visibility', requireAdmin, async (req, res) => {
  const userId = parseInt(req.params.userId);
  const { hidden_channel_ids } = req.body;
  if (!Array.isArray(hidden_channel_ids))
    return res.status(400).json({ error: 'hidden_channel_ids doit être un tableau' });
  try {
    await db.setHiddenChannels(userId, hidden_channel_ids);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
