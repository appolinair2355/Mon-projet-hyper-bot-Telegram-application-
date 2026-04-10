const express = require('express');
const bcrypt  = require('bcryptjs');
const db      = require('../db');
const router  = express.Router();

// ── Helpers ───────────────────────────────────────────────────────

function genPassword(len = 10) {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: len }, () => c[Math.floor(Math.random() * c.length)]).join('');
}

function requireAdmin(req, res, next) {
  if (!req.session.userId || !req.session.isAdmin)
    return res.status(403).json({ error: 'Accès admin requis' });
  next();
}

function getUserStatus(user) {
  if (user.is_admin) return 'active';
  if (!user.is_approved) return 'pending';
  if (!user.subscription_expires_at) return 'expired';
  return new Date(user.subscription_expires_at) > new Date() ? 'active' : 'expired';
}

function fmtDuration(mins) {
  if (mins < 60) return `${Math.round(mins)} min`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

// ── USERS ─────────────────────────────────────────────────────────

router.get('/users', requireAdmin, async (req, res) => {
  try {
    const users = await db.getAllUsers();
    res.json(users.map(u => ({ ...u, status: getUserStatus(u) })));
  } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

router.post('/users/:id/approve', requireAdmin, async (req, res) => {
  const id   = parseInt(req.params.id);
  const mins = parseFloat(req.body.minutes);
  if (!req.body.minutes || isNaN(mins) || mins < 10 || mins > 45000)
    return res.status(400).json({ error: 'Durée invalide (10 min à 750 h)' });
  try {
    const expires = new Date(Date.now() + mins * 60 * 1000);
    const user = await db.updateUser(id, { is_approved: true, subscription_expires_at: expires.toISOString(), subscription_duration_minutes: Math.round(mins) });
    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    res.json({ message: `Accès accordé pour ${fmtDuration(mins)}`, user });
  } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

router.post('/users/:id/extend', requireAdmin, async (req, res) => {
  const id   = parseInt(req.params.id);
  const mins = parseFloat(req.body.minutes);
  if (!req.body.minutes || isNaN(mins) || mins < 10 || mins > 45000)
    return res.status(400).json({ error: 'Durée invalide (10 min à 750 h)' });
  try {
    const current = await db.getUser(id);
    if (!current) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    const base   = current.subscription_expires_at
      ? new Date(Math.max(new Date(current.subscription_expires_at), Date.now()))
      : new Date();
    const expires  = new Date(base.getTime() + mins * 60 * 1000);
    const totalMins = (current.subscription_duration_minutes || 0) + Math.round(mins);
    const user = await db.updateUser(id, { subscription_expires_at: expires.toISOString(), subscription_duration_minutes: totalMins });
    res.json({ message: `Prolongé de ${fmtDuration(mins)}`, user });
  } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

router.post('/users/:id/reject', requireAdmin, async (req, res) => {
  try {
    await db.updateUser(parseInt(req.params.id), { is_approved: false, subscription_expires_at: null });
    res.json({ message: 'Accès révoqué' });
  } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

router.put('/users/:id', requireAdmin, async (req, res) => {
  const { first_name, last_name } = req.body;
  try {
    const user = await db.updateUser(parseInt(req.params.id), { first_name: first_name || null, last_name: last_name || null });
    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    res.json({ ok: true, user });
  } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

router.delete('/users/:id', requireAdmin, async (req, res) => {
  try {
    const u = await db.getUser(parseInt(req.params.id));
    if (u?.is_admin) return res.status(400).json({ error: 'Impossible de supprimer un admin' });
    await db.deleteUser(parseInt(req.params.id));
    res.json({ message: 'Utilisateur supprimé' });
  } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// ── STATS ─────────────────────────────────────────────────────────

router.get('/stats', requireAdmin, async (req, res) => {
  try {
    const [users, predictions] = await Promise.all([db.getUserStats(), db.getPredictionStats()]);
    res.json({ users, predictions });
  } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// ── COMPTES PREMIUM ───────────────────────────────────────────────

router.post('/generate-premium', requireAdmin, async (req, res) => {
  try {
    const accounts = [];
    for (let i = 1; i <= 5; i++) {
      const username  = `premium${i}`;
      const password  = genPassword(10);
      const hash      = await bcrypt.hash(password, 10);
      const expiresAt = new Date(Date.now() + 750 * 60 * 60 * 1000);
      await db.createUser({
        username, email: null, password_hash: hash,
        first_name: 'Premium', last_name: String(i),
        is_approved: true, subscription_expires_at: expiresAt.toISOString(),
        subscription_duration_minutes: 45000,
      });
      accounts.push({ username, password, expires_at: expiresAt });
    }
    res.json({ ok: true, accounts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── STRATÉGIES PERSONNALISÉES ─────────────────────────────────────

const SUITS = ['♠', '♥', '♦', '♣'];

async function getStrategies() {
  const v = await db.getSetting('custom_strategies');
  return v ? JSON.parse(v) : [];
}

async function saveStrategies(list) {
  await db.setSetting('custom_strategies', JSON.stringify(list));
}

function validateStrategyBody(body) {
  const { name, threshold, mode, mappings, visibility } = body;
  const B = parseInt(threshold);
  if (!name || !name.trim())                            return 'Nom requis';
  if (isNaN(B) || B < 1 || B > 50)                     return 'Seuil B invalide (1–50)';
  if (!['manquants', 'apparents'].includes(mode))       return 'Mode invalide';
  if (!['admin', 'all'].includes(visibility))           return 'Visibilité invalide';
  for (const s of SUITS) {
    if (!SUITS.includes(mappings?.[s])) return `Mapping invalide pour ${s}`;
  }
  return null;
}

// Valide et nettoie les cibles Telegram (tableau)
function parseTgTargets(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(t => ({
      bot_token:  String(t.bot_token  || '').trim(),
      channel_id: String(t.channel_id || '').trim(),
    }))
    .filter(t => t.bot_token && t.channel_id);
}

// GET /api/admin/strategies
router.get('/strategies', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Non connecté' });
  try {
    const list = await getStrategies();
    if (!req.session.isAdmin) {
      return res.json(
        list.filter(s => s.enabled && s.visibility === 'all')
            .map(s => ({ id: s.id, name: s.name, enabled: s.enabled, visibility: s.visibility, threshold: s.threshold, mode: s.mode }))
      );
    }
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/strategies
router.post('/strategies', requireAdmin, async (req, res) => {
  try {
    const err = validateStrategyBody(req.body);
    if (err) return res.status(400).json({ error: err });

    const { name, threshold, mode, mappings, visibility, enabled } = req.body;
    const tg_targets = parseTgTargets(req.body.tg_targets);

    const list   = await getStrategies();
    const nextId = list.length > 0 ? Math.max(...list.map(s => s.id)) + 1 : 7;
    const strat  = {
      id: nextId,
      name: name.trim().slice(0, 40),
      threshold: parseInt(threshold),
      mode, mappings,
      visibility: visibility || 'admin',
      enabled: enabled !== false,
      tg_targets,
    };
    list.push(strat);
    await saveStrategies(list);
    require('../engine').reloadCustomStrategies(list);
    res.json({ ok: true, strategy: strat });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/admin/strategies/:id
router.put('/strategies/:id', requireAdmin, async (req, res) => {
  try {
    const id  = parseInt(req.params.id);
    const err = validateStrategyBody(req.body);
    if (err) return res.status(400).json({ error: err });

    const list = await getStrategies();
    const idx  = list.findIndex(s => s.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Stratégie introuvable' });

    const { name, threshold, mode, mappings, visibility, enabled } = req.body;
    const tg_targets = parseTgTargets(req.body.tg_targets);

    list[idx] = {
      ...list[idx],
      name: name.trim().slice(0, 40),
      threshold: parseInt(threshold),
      mode, mappings,
      visibility: visibility || 'admin',
      enabled: enabled !== false,
      tg_targets,
    };
    await saveStrategies(list);
    require('../engine').reloadCustomStrategies(list);
    res.json({ ok: true, strategy: list[idx] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/admin/strategies/:id
router.delete('/strategies/:id', requireAdmin, async (req, res) => {
  try {
    const id   = parseInt(req.params.id);
    let list   = await getStrategies();
    const before = list.length;
    list = list.filter(s => s.id !== id);
    if (list.length === before) return res.status(404).json({ error: 'Stratégie introuvable' });
    await saveStrategies(list);
    require('../engine').reloadCustomStrategies(list);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
