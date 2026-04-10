/**
 * Couche d'accès aux données — PostgreSQL si DATABASE_URL est défini, sinon JSON local.
 */
const USE_PG = !!process.env.DATABASE_URL;

let pgPool = null;
if (USE_PG) {
  const { Pool } = require('pg');
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('sslmode=require')
      ? { rejectUnauthorized: false }
      : false,
  });
}

const jsondb = require('./jsondb');

// ── Initialisation ─────────────────────────────────────────────────

async function initDB() {
  if (USE_PG) {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(80) UNIQUE NOT NULL,
        email VARCHAR(120) UNIQUE,
        password_hash VARCHAR(256) NOT NULL,
        first_name TEXT,
        last_name TEXT,
        is_admin BOOLEAN DEFAULT FALSE,
        is_approved BOOLEAN DEFAULT FALSE,
        subscription_expires_at TIMESTAMPTZ,
        subscription_duration_minutes INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_duration_minutes INTEGER;
      ALTER TABLE users ALTER COLUMN email DROP NOT NULL;

      CREATE TABLE IF NOT EXISTS predictions (
        id SERIAL PRIMARY KEY,
        strategy VARCHAR(10) NOT NULL,
        game_number INTEGER NOT NULL,
        predicted_suit VARCHAR(5) NOT NULL,
        triggered_by VARCHAR(5),
        status VARCHAR(20) DEFAULT 'en_cours',
        rattrapage INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        resolved_at TIMESTAMPTZ,
        player_cards TEXT,
        banker_cards TEXT,
        UNIQUE(strategy, game_number, predicted_suit)
      );
      ALTER TABLE predictions ADD COLUMN IF NOT EXISTS player_cards TEXT;
      ALTER TABLE predictions ADD COLUMN IF NOT EXISTS banker_cards TEXT;

      CREATE TABLE IF NOT EXISTS telegram_config (
        id SERIAL PRIMARY KEY,
        channel_id TEXT NOT NULL UNIQUE,
        channel_name TEXT,
        enabled BOOLEAN DEFAULT TRUE,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE telegram_config ADD COLUMN IF NOT EXISTS channel_name TEXT;

      CREATE TABLE IF NOT EXISTS user_channel_hidden (
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        channel_id INTEGER REFERENCES telegram_config(id) ON DELETE CASCADE,
        PRIMARY KEY(user_id, channel_id)
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    // Compte admin
    const check = await pgPool.query(`SELECT id FROM users WHERE username = 'buzzinfluence' LIMIT 1`);
    if (check.rows.length === 0) {
      const bcrypt = require('bcryptjs');
      const hash = await bcrypt.hash('arrow2025', 10);
      await pgPool.query(
        `INSERT INTO users (username, email, password_hash, is_admin, is_approved)
         VALUES ($1, $2, $3, TRUE, TRUE)
         ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_admin = TRUE, is_approved = TRUE`,
        ['buzzinfluence', 'admin@baccarat.pro', hash]
      );
      console.log('✅ Compte admin créé: buzzinfluence');
    }
    console.log('✅ Base de données PostgreSQL initialisée');
  } else {
    // JSON mode: créer admin si absent
    const existing = jsondb.getUserByUsername('buzzinfluence');
    if (!existing) {
      const bcrypt = require('bcryptjs');
      const hash = await bcrypt.hash('arrow2025', 10);
      jsondb.createUser({
        username: 'buzzinfluence',
        email: 'admin@baccarat.pro',
        password_hash: hash,
        is_admin: true,
        is_approved: true,
      });
      console.log('✅ Compte admin créé: buzzinfluence');
    }
    console.log('✅ Base de données JSON locale initialisée');
  }
}

// ── Pool PostgreSQL (peut être null en mode JSON) ──────────────────
const pool = pgPool;

// ── Helpers PostgreSQL + JSON unifiés ─────────────────────────────

// USERS
async function getUser(id) {
  if (USE_PG) {
    const r = await pgPool.query('SELECT * FROM users WHERE id = $1', [id]);
    return r.rows[0] || null;
  }
  return jsondb.getUser(id);
}

async function getUserByLogin(login) {
  if (USE_PG) {
    const r = await pgPool.query('SELECT * FROM users WHERE username = $1 OR email = $1', [login.trim()]);
    return r.rows[0] || null;
  }
  return jsondb.getUserByLogin(login);
}

async function getUserByUsername(username) {
  if (USE_PG) {
    const r = await pgPool.query('SELECT * FROM users WHERE username = $1', [username]);
    return r.rows[0] || null;
  }
  return jsondb.getUserByUsername(username);
}

async function getAllUsers() {
  if (USE_PG) {
    const r = await pgPool.query(
      'SELECT id, username, email, first_name, last_name, is_admin, is_approved, subscription_expires_at, subscription_duration_minutes, created_at FROM users ORDER BY created_at DESC'
    );
    return r.rows;
  }
  return jsondb.getAllUsers().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

async function createUser(data) {
  if (USE_PG) {
    const r = await pgPool.query(
      `INSERT INTO users (username, email, password_hash, first_name, last_name, is_admin, is_approved, subscription_expires_at, subscription_duration_minutes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (username) DO UPDATE SET
         password_hash = EXCLUDED.password_hash, first_name = EXCLUDED.first_name,
         last_name = EXCLUDED.last_name, is_admin = EXCLUDED.is_admin, is_approved = EXCLUDED.is_approved,
         subscription_expires_at = EXCLUDED.subscription_expires_at, subscription_duration_minutes = EXCLUDED.subscription_duration_minutes
       RETURNING *`,
      [data.username, data.email || null, data.password_hash, data.first_name || null, data.last_name || null,
       data.is_admin || false, data.is_approved || false, data.subscription_expires_at || null,
       data.subscription_duration_minutes || null]
    );
    return r.rows[0];
  }
  if (jsondb.usernameTaken(data.username)) throw Object.assign(new Error('username taken'), { code: '23505', field: 'username' });
  if (data.email && jsondb.emailTaken(data.email)) throw Object.assign(new Error('email taken'), { code: '23505', field: 'email' });
  return jsondb.createUser(data);
}

async function updateUser(id, updates) {
  if (USE_PG) {
    const sets = [];
    const vals = [];
    let i = 1;
    for (const [k, v] of Object.entries(updates)) { sets.push(`${k} = $${i++}`); vals.push(v); }
    vals.push(id);
    const r = await pgPool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
    return r.rows[0] || null;
  }
  return jsondb.updateUser(id, updates);
}

async function deleteUser(id) {
  if (USE_PG) {
    await pgPool.query('DELETE FROM users WHERE id = $1', [id]);
    return true;
  }
  return jsondb.deleteUser(id);
}

// PREDICTIONS
async function getPredictions(opts = {}) {
  if (USE_PG) {
    const { strategy, status, limit = 100 } = opts;
    const conds = []; const vals = [];
    if (strategy) { conds.push(`strategy = $${vals.length + 1}`); vals.push(strategy); }
    if (status)   { conds.push(`status = $${vals.length + 1}`);   vals.push(status); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const r = await pgPool.query(
      `SELECT * FROM predictions ${where} ORDER BY created_at DESC LIMIT ${parseInt(limit) || 100}`,
      vals
    );
    return r.rows;
  }
  return jsondb.getPredictions(opts);
}

async function createPrediction(data) {
  if (USE_PG) {
    try {
      await pgPool.query(
        `INSERT INTO predictions (strategy, game_number, predicted_suit, triggered_by)
         VALUES ($1,$2,$3,$4) ON CONFLICT (strategy, game_number, predicted_suit) DO NOTHING`,
        [data.strategy, data.game_number, data.predicted_suit, data.triggered_by || null]
      );
    } catch (e) { console.error('createPrediction error:', e.message); }
    return;
  }
  return jsondb.createPrediction(data);
}

async function updatePrediction(filter, updates) {
  if (USE_PG) {
    const { strategy, game_number, predicted_suit, status_filter } = filter;
    const { status, rattrapage, resolved_at, player_cards, banker_cards } = updates;
    await pgPool.query(
      `UPDATE predictions SET status=$1, rattrapage=$2, resolved_at=$3, player_cards=$4, banker_cards=$5
       WHERE strategy=$6 AND game_number=$7 AND predicted_suit=$8 AND status=$9`,
      [status, rattrapage, resolved_at || new Date().toISOString(),
       player_cards ? JSON.stringify(player_cards) : null,
       banker_cards ? JSON.stringify(banker_cards) : null,
       strategy, game_number, predicted_suit, status_filter || 'en_cours']
    );
    return;
  }
  return jsondb.updatePrediction(filter, updates);
}

async function getPredictionStats() {
  if (USE_PG) {
    const r = await pgPool.query(`
      SELECT strategy,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status='gagne') as wins,
        COUNT(*) FILTER (WHERE status='perdu') as losses,
        COUNT(*) FILTER (WHERE status='en_cours') as pending
      FROM predictions GROUP BY strategy ORDER BY strategy
    `);
    return r.rows;
  }
  return jsondb.getPredictionStats();
}

async function getMaxResolvedGame() {
  if (USE_PG) {
    const r = await pgPool.query(
      `SELECT COALESCE(MAX(game_number),0) AS mx FROM predictions WHERE status IN ('gagne','perdu')`
    );
    return parseInt(r.rows[0]?.mx || 0);
  }
  return jsondb.getMaxResolvedGame();
}

async function expireStaleByGame(threshold) {
  if (USE_PG) {
    const r = await pgPool.query(
      `UPDATE predictions SET status='perdu', rattrapage=2, resolved_at=NOW()
       WHERE status='en_cours' AND game_number <= $1`,
      [threshold]
    );
    return r.rowCount;
  }
  return jsondb.expireStaleByGame(threshold);
}

// SETTINGS
async function getSetting(key) {
  if (USE_PG) {
    const r = await pgPool.query(`SELECT value FROM settings WHERE key=$1`, [key]);
    return r.rows[0]?.value ?? null;
  }
  return jsondb.getSetting(key);
}

async function setSetting(key, value) {
  if (USE_PG) {
    await pgPool.query(
      `INSERT INTO settings (key,value,updated_at) VALUES($1,$2,NOW())
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
      [key, value]
    );
    return;
  }
  jsondb.setSetting(key, value);
}

async function deleteSetting(key) {
  if (USE_PG) { await pgPool.query(`DELETE FROM settings WHERE key=$1`, [key]); return; }
  jsondb.deleteSetting(key);
}

// TELEGRAM CONFIG
async function getTelegramConfigs(enabledOnly = false) {
  if (USE_PG) {
    const r = await pgPool.query(
      enabledOnly
        ? 'SELECT * FROM telegram_config WHERE enabled=TRUE ORDER BY updated_at DESC'
        : 'SELECT * FROM telegram_config ORDER BY updated_at DESC'
    );
    return r.rows;
  }
  return jsondb.getTelegramConfigs(enabledOnly);
}

async function upsertTelegramConfig({ channel_id, channel_name }) {
  if (USE_PG) {
    const r = await pgPool.query(
      `INSERT INTO telegram_config (channel_id,channel_name,enabled,updated_at) VALUES($1,$2,TRUE,NOW())
       ON CONFLICT (channel_id) DO UPDATE SET channel_name=EXCLUDED.channel_name, enabled=TRUE, updated_at=NOW()
       RETURNING *`,
      [channel_id, channel_name]
    );
    return r.rows[0];
  }
  return jsondb.upsertTelegramConfig({ channel_id, channel_name });
}

async function deleteTelegramConfig(id) {
  if (USE_PG) { await pgPool.query('DELETE FROM telegram_config WHERE id=$1', [id]); return; }
  jsondb.deleteTelegramConfig(id);
}

// USER CHANNEL HIDDEN
async function getHiddenChannels(userId) {
  if (USE_PG) {
    const r = await pgPool.query('SELECT channel_id FROM user_channel_hidden WHERE user_id=$1', [userId]);
    return r.rows.map(r => r.channel_id);
  }
  return jsondb.getHiddenChannels(userId);
}

async function setHiddenChannels(userId, channelIds) {
  if (USE_PG) {
    await pgPool.query('DELETE FROM user_channel_hidden WHERE user_id=$1', [userId]);
    for (const cid of channelIds) {
      await pgPool.query(
        'INSERT INTO user_channel_hidden (user_id,channel_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [userId, cid]
      );
    }
    return;
  }
  jsondb.setHiddenChannels(userId, channelIds);
}

// ADMIN STATS
async function getUserStats() {
  if (USE_PG) {
    const r = await pgPool.query(`
      SELECT
        COUNT(*) FILTER (WHERE NOT is_approved) as pending,
        COUNT(*) FILTER (WHERE is_approved AND subscription_expires_at > NOW()) as active,
        COUNT(*) FILTER (WHERE is_approved AND (subscription_expires_at IS NULL OR subscription_expires_at <= NOW())) as expired,
        COUNT(*) as total
      FROM users WHERE NOT is_admin
    `);
    return r.rows[0];
  }
  return jsondb.getUserStats();
}

module.exports = {
  pool,          // null en mode JSON — garder pour compat
  USE_PG,
  initDB,
  // Users
  getUser, getUserByLogin, getUserByUsername, getAllUsers,
  createUser, updateUser, deleteUser,
  // Predictions
  getPredictions, createPrediction, updatePrediction,
  getPredictionStats, getMaxResolvedGame, expireStaleByGame,
  // Settings
  getSetting, setSetting, deleteSetting,
  // Telegram
  getTelegramConfigs, upsertTelegramConfig, deleteTelegramConfig,
  // User Channel Hidden
  getHiddenChannels, setHiddenChannels,
  // Admin stats
  getUserStats,
};
