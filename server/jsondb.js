/**
 * Base de données JSON locale — stockage dans data/db.json
 * Utilisée quand DATABASE_URL n'est pas configuré.
 */
const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const DB_FILE  = path.join(DATA_DIR, 'db.json');

const DEFAULTS = {
  meta: { next_user_id: 1, next_pred_id: 1, next_tg_id: 1 },
  users: [],
  predictions: [],
  telegram_config: [],
  user_channel_hidden: [],
  settings: {},
};

let _data = null;
let _saveTimer = null;

function _load() {
  if (_data) return _data;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    _data = JSON.parse(JSON.stringify(DEFAULTS));
    _persist();
  } else {
    try {
      _data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      for (const k of Object.keys(DEFAULTS)) {
        if (_data[k] === undefined) _data[k] = JSON.parse(JSON.stringify(DEFAULTS[k]));
      }
    } catch {
      _data = JSON.parse(JSON.stringify(DEFAULTS));
      _persist();
    }
  }
  return _data;
}

function _persist() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DB_FILE, JSON.stringify(_data, null, 2));
    } catch (e) { console.error('[jsondb] save error:', e.message); }
  }, 80);
}

const d = () => _load();

// ── USERS ──────────────────────────────────────────────────────────

function getUser(id) { return d().users.find(u => u.id === id) || null; }

function getUserByLogin(login) {
  const l = String(login).trim().toLowerCase();
  return d().users.find(u =>
    u.username.toLowerCase() === l ||
    (u.email && u.email.toLowerCase() === l)
  ) || null;
}

function getUserByUsername(username) {
  return d().users.find(u => u.username.toLowerCase() === username.toLowerCase()) || null;
}

function getAllUsers() { return d().users.slice(); }

function createUser(data) {
  const row = {
    id: d().meta.next_user_id++,
    username: data.username,
    email: data.email || null,
    password_hash: data.password_hash,
    first_name: data.first_name || null,
    last_name: data.last_name || null,
    is_admin: data.is_admin || false,
    is_approved: data.is_approved || false,
    subscription_expires_at: data.subscription_expires_at || null,
    subscription_duration_minutes: data.subscription_duration_minutes || null,
    created_at: new Date().toISOString(),
  };
  d().users.push(row);
  _persist();
  return row;
}

function updateUser(id, updates) {
  const idx = d().users.findIndex(u => u.id === id);
  if (idx === -1) return null;
  Object.assign(d().users[idx], updates);
  _persist();
  return d().users[idx];
}

function deleteUser(id) {
  const before = d().users.length;
  d().users = d().users.filter(u => u.id !== id);
  _persist();
  return d().users.length < before;
}

function usernameTaken(username, excludeId) {
  return d().users.some(u => u.username.toLowerCase() === username.toLowerCase() && u.id !== excludeId);
}

function emailTaken(email, excludeId) {
  if (!email) return false;
  return d().users.some(u => u.email && u.email.toLowerCase() === email.toLowerCase() && u.id !== excludeId);
}

// ── PREDICTIONS ────────────────────────────────────────────────────

function getPredictions({ strategy, status, limit = 100 } = {}) {
  let rows = d().predictions.slice();
  if (strategy) rows = rows.filter(p => p.strategy === strategy);
  if (status)   rows = rows.filter(p => p.status   === status);
  rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return limit ? rows.slice(0, limit) : rows;
}

function createPrediction({ strategy, game_number, predicted_suit, triggered_by }) {
  // UNIQUE(strategy, game_number, predicted_suit)
  const dup = d().predictions.find(p =>
    p.strategy === strategy && p.game_number === game_number && p.predicted_suit === predicted_suit
  );
  if (dup) return null;

  const row = {
    id: d().meta.next_pred_id++,
    strategy, game_number, predicted_suit,
    triggered_by: triggered_by || null,
    status: 'en_cours',
    rattrapage: 0,
    created_at: new Date().toISOString(),
    resolved_at: null,
    player_cards: null,
    banker_cards: null,
  };
  d().predictions.push(row);
  _persist();
  return row;
}

function updatePrediction({ strategy, game_number, predicted_suit, status_filter }, updates) {
  let count = 0;
  for (const p of d().predictions) {
    if (strategy       && p.strategy       !== strategy)       continue;
    if (game_number    !== undefined && p.game_number    !== game_number)    continue;
    if (predicted_suit && p.predicted_suit !== predicted_suit) continue;
    if (status_filter  && p.status         !== status_filter)  continue;
    Object.assign(p, updates);
    count++;
  }
  if (count) _persist();
  return count;
}

function getPredictionStats() {
  const map = {};
  for (const p of d().predictions) {
    if (!map[p.strategy]) map[p.strategy] = { strategy: p.strategy, total: 0, wins: 0, losses: 0, pending: 0 };
    map[p.strategy].total++;
    if (p.status === 'gagne')    map[p.strategy].wins++;
    else if (p.status === 'perdu')   map[p.strategy].losses++;
    else if (p.status === 'en_cours') map[p.strategy].pending++;
  }
  return Object.values(map).sort((a, b) => a.strategy.localeCompare(b.strategy));
}

function getMaxResolvedGame() {
  let mx = 0;
  for (const p of d().predictions) {
    if ((p.status === 'gagne' || p.status === 'perdu') && p.game_number > mx) mx = p.game_number;
  }
  return mx;
}

function expireStaleByGame(threshold) {
  let count = 0;
  for (const p of d().predictions) {
    if (p.status === 'en_cours' && p.game_number <= threshold) {
      Object.assign(p, { status: 'perdu', rattrapage: 2, resolved_at: new Date().toISOString() });
      count++;
    }
  }
  if (count) _persist();
  return count;
}

// ── TELEGRAM CONFIG ────────────────────────────────────────────────

function getTelegramConfigs(enabledOnly = false) {
  let rows = d().telegram_config.slice();
  if (enabledOnly) rows = rows.filter(r => r.enabled);
  return rows;
}

function upsertTelegramConfig({ channel_id, channel_name }) {
  const existing = d().telegram_config.find(r => r.channel_id === channel_id);
  if (existing) {
    Object.assign(existing, { channel_name: channel_name || existing.channel_name, enabled: true, updated_at: new Date().toISOString() });
    _persist();
    return existing;
  }
  const row = { id: d().meta.next_tg_id++, channel_id, channel_name: channel_name || channel_id, enabled: true, updated_at: new Date().toISOString() };
  d().telegram_config.push(row);
  _persist();
  return row;
}

function deleteTelegramConfig(id) {
  const before = d().telegram_config.length;
  d().telegram_config = d().telegram_config.filter(r => r.id !== id);
  _persist();
  return d().telegram_config.length < before;
}

// ── USER CHANNEL HIDDEN ────────────────────────────────────────────

function getHiddenChannels(userId) {
  return d().user_channel_hidden.filter(r => r.user_id === userId).map(r => r.channel_id);
}

function setHiddenChannels(userId, channelIds) {
  d().user_channel_hidden = d().user_channel_hidden.filter(r => r.user_id !== userId);
  for (const cid of channelIds) d().user_channel_hidden.push({ user_id: userId, channel_id: cid });
  _persist();
}

// ── SETTINGS ───────────────────────────────────────────────────────

function getSetting(key)        { return d().settings[key] ?? null; }
function setSetting(key, value) { d().settings[key] = value; _persist(); }
function deleteSetting(key)     { delete d().settings[key]; _persist(); }

// ── ADMIN STATS ────────────────────────────────────────────────────

function getUserStats() {
  const now = new Date();
  const users = d().users.filter(u => !u.is_admin);
  return {
    total:   users.length,
    pending: users.filter(u => !u.is_approved).length,
    active:  users.filter(u => u.is_approved && u.subscription_expires_at && new Date(u.subscription_expires_at) > now).length,
    expired: users.filter(u => u.is_approved && (!u.subscription_expires_at || new Date(u.subscription_expires_at) <= now)).length,
  };
}

module.exports = {
  getUser, getUserByLogin, getUserByUsername, getAllUsers,
  createUser, updateUser, deleteUser, usernameTaken, emailTaken,
  getPredictions, createPrediction, updatePrediction, getPredictionStats,
  getMaxResolvedGame, expireStaleByGame,
  getTelegramConfigs, upsertTelegramConfig, deleteTelegramConfig,
  getHiddenChannels, setHiddenChannels,
  getSetting, setSetting, deleteSetting,
  getUserStats,
};
