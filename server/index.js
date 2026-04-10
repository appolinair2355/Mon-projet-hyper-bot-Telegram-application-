require('dotenv').config();
const express  = require('express');
const session  = require('express-session');
const cors     = require('cors');
const path     = require('path');
const compression = require('compression');

const { initDB, USE_PG, pool } = require('./db');
const authRoutes        = require('./auth');
const adminRoutes       = require('./admin');
const predictionsRoutes = require('./predictions');
const { router: gamesRouter } = require('./games');
const telegramRoutes    = require('./telegram-route');
const telegramService   = require('./telegram-service');
const engine            = require('./engine');

const app     = express();
const IS_PROD = process.env.NODE_ENV === 'production';
const PORT    = process.env.PORT || (IS_PROD ? 3000 : 5000);

app.use(compression({
  filter: (req, res) => {
    if (req.headers.accept === 'text/event-stream' || req.path.endsWith('/stream')) return false;
    return compression.filter(req, res);
  },
}));

app.use(cors({ origin: false, credentials: true }));
app.use(express.json());

// ── Session store ──────────────────────────────────────────────────
let sessionStore;
if (USE_PG && pool) {
  const PgSession = require('connect-pg-simple')(session);
  sessionStore = new PgSession({ pool, createTableIfMissing: true });
  console.log('🔑 Sessions stockées en PostgreSQL');
} else {
  const MemoryStore = require('memorystore')(session);
  sessionStore = new MemoryStore({ checkPeriod: 86_400_000 });
  console.log('🔑 Sessions en mémoire (JSON mode)');
}

app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'baccarat-pro-secret-2025',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: IS_PROD,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: IS_PROD ? 'none' : 'lax',
  },
}));

// ── Routes API ─────────────────────────────────────────────────────
app.use('/api/auth',        authRoutes);
app.use('/api/admin',       adminRoutes);
app.use('/api/predictions', predictionsRoutes);
app.use('/api/games',       gamesRouter);
app.use('/api/telegram',    telegramRoutes);
app.get('/api/health', (req, res) => res.json({ status: 'ok', mode: USE_PG ? 'postgresql' : 'json', time: new Date() }));

// ── Client statique ────────────────────────────────────────────────
// Cherche le dossier contenant index.html :
// 1) client/dist/  → build Vite complet (dev Replit + Render avec rebuild)
// 2) client/       → fichiers pré-compilés plats (déploiement ZIP)
const fs = require('fs');
const distPath = [
  path.join(__dirname, '../client/dist'),
  path.join(__dirname, '../client'),
].find(p => fs.existsSync(path.join(p, 'index.html')));

if (distPath) {
  console.log(`📁 Fichiers client servis depuis : ${distPath}`);
  app.use(express.static(distPath, { maxAge: IS_PROD ? '1h' : 0 }));
  app.use((req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(distPath, 'index.html'));
  });
} else {
  app.use((req, res) => res.send('<p>Build en cours... Rafraîchissez dans quelques secondes.</p>'));
}

// ── Démarrage ─────────────────────────────────────────────────────
async function main() {
  await initDB();
  engine.start(5000);
  await telegramService.loadConfig();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Serveur démarré sur le port ${PORT} (${IS_PROD ? 'production' : 'développement'}) — DB: ${USE_PG ? 'PostgreSQL' : 'JSON'}`);
  });
}

main().catch(err => {
  console.error('Erreur démarrage:', err);
  process.exit(1);
});
