/**
 * Moteur de prédiction Baccarat
 */
const db  = require('./db');
const { fetchGames } = require('./games');
const { sendPredictionToTargets } = require('./telegram-service');

const ALL_SUITS   = ['♠', '♥', '♦', '♣'];
const SUIT_DISPLAY = { '♠': '♠️', '♥': '❤️', '♦': '♦️', '♣': '♣️' };

const C1_B = 5;  const C1_MAP = { '♣':'♦','♦':'♣','♠':'♥','♥':'♠' };
const C2_B = 8;  const C2_MAP = { '♥':'♣','♣':'♥','♠':'♦','♦':'♠' };
const C3_B = 5;  const C3_MAP = { '♥':'♣','♣':'♥','♠':'♦','♦':'♠' };

const RAW_TO_SUIT = { '♠️':'♠','♣️':'♣','♦️':'♦','♥️':'♥','❤️':'♥' };

function normalizeSuit(s) {
  return RAW_TO_SUIT[s] || s.replace(/\ufe0f/g, '').replace('❤', '♥');
}

function extractSuits(playerCards) {
  const suits = new Set();
  for (const c of playerCards) {
    const n = normalizeSuit(c.S || '');
    if (ALL_SUITS.includes(n)) suits.add(n);
  }
  return [...suits];
}

async function savePrediction(strategy, gameNumber, predictedSuit, triggeredBy) {
  try {
    await db.createPrediction({ strategy, game_number: gameNumber, predicted_suit: predictedSuit, triggered_by: triggeredBy || null });
    console.log(`[${strategy}] Prédiction #${gameNumber} ${SUIT_DISPLAY[predictedSuit] || predictedSuit}`);
  } catch (e) { console.error('savePrediction error:', e.message); }
}

async function resolvePrediction(strategy, gameNumber, predictedSuit, status, rattrapage, playerCards, bankerCards) {
  try {
    await db.updatePrediction(
      { strategy, game_number: gameNumber, predicted_suit: predictedSuit, status_filter: 'en_cours' },
      { status, rattrapage, resolved_at: new Date().toISOString(),
        player_cards: playerCards ? JSON.stringify(playerCards) : null,
        banker_cards: bankerCards ? JSON.stringify(bankerCards) : null,
      }
    );
  } catch (e) { console.error('resolvePrediction error:', e.message); }
}

class Engine {
  constructor() {
    this.running  = false;
    this.interval = null;

    this.c1 = { absences: {}, processed: new Set(), pending: {}, consecLosses: 0 };
    this.c2 = { absences: {}, processed: new Set(), pending: {}, hadFirstLoss: false };
    this.c3 = { absences: {}, processed: new Set(), pending: {}, consecLosses: 0 };
    this.dc = { pending: {} };
    this.custom = {};  // id → { config, pending, counts, processed }

    for (const s of ALL_SUITS) {
      this.c1.absences[s] = 0;
      this.c2.absences[s] = 0;
      this.c3.absences[s] = 0;
    }
  }

  _makeCustomState() {
    const counts = {};
    for (const s of ALL_SUITS) counts[s] = 0;
    return { counts, processed: new Set(), pending: {} };
  }

  reloadCustomStrategies(list) {
    for (const cfg of list) {
      if (!this.custom[cfg.id]) this.custom[cfg.id] = this._makeCustomState();
      this.custom[cfg.id].config = cfg;
      for (const s of ALL_SUITS) this.custom[cfg.id].counts[s] = 0;
      console.log(`[S${cfg.id}] "${cfg.name}" rechargée: mode=${cfg.mode}, B=${cfg.threshold}, enabled=${cfg.enabled}`);
    }
    const ids = new Set(list.map(c => c.id));
    for (const id of Object.keys(this.custom)) {
      if (!ids.has(parseInt(id))) delete this.custom[id];
    }
  }

  async loadCustomStrategies() {
    try {
      const v = await db.getSetting('custom_strategies');
      if (!v) return;
      const list = JSON.parse(v);
      for (const cfg of list) {
        this.custom[cfg.id] = this._makeCustomState();
        this.custom[cfg.id].config = cfg;
        console.log(`[S${cfg.id}] "${cfg.name}" chargée (mode=${cfg.mode}, B=${cfg.threshold})`);
      }
    } catch (e) { console.error('loadCustomStrategies error:', e.message); }
  }

  async processGame(gn, suits, pCards, bCards) {
    await this._processC1(gn, suits, pCards, bCards);
    await this._processC2(gn, suits, pCards, bCards);
    await this._processC3(gn, suits, pCards, bCards);
    await this._processDC(gn, suits, pCards, bCards);
    for (const [id, state] of Object.entries(this.custom)) {
      if (state.config?.enabled) {
        await this._processCustomStrategy(parseInt(id), state, state.config, gn, suits, pCards, bCards);
      }
    }
  }

  async _resolvePending(pending, strategy, gn, suits, pCards, bCards, onLoss) {
    for (const [pg, info] of Object.entries(pending)) {
      const pgNum = parseInt(pg);
      const ps    = info.suit;
      if (pgNum > gn) continue;

      if (gn > pgNum + 2) {
        await resolvePrediction(strategy, pgNum, ps, 'perdu', 2, pCards, bCards);
        delete pending[pg];
        if (onLoss) onLoss(false, ps, pgNum);
        continue;
      }

      if (suits.includes(ps)) {
        const rattrapage = gn - pgNum;
        await resolvePrediction(strategy, pgNum, ps, 'gagne', rattrapage, pCards, bCards);
        delete pending[pg];
        if (onLoss) onLoss(true, ps, pgNum);
      } else if (gn === pgNum + 2) {
        await resolvePrediction(strategy, pgNum, ps, 'perdu', 2, pCards, bCards);
        delete pending[pg];
        if (onLoss) onLoss(false, ps, pgNum);
      }
    }
  }

  async _processC1(gn, suits, pCards, bCards) {
    if (this.c1.processed.has(gn)) return;
    this.c1.processed.add(gn);
    await this._resolvePending(this.c1.pending, 'C1', gn, suits, pCards, bCards, (won, suit, pg) => {
      if (won) { this.c1.consecLosses = 0; return; }
      this.c1.consecLosses++;
      if (this.c1.consecLosses >= 2) {
        this.c1.consecLosses = 0;
        const next = gn + 1;
        savePrediction('DC', next, suit, suit);
        this.dc.pending[next] = { suit, rattrapage: 0 };
      }
    });
    for (const suit of ALL_SUITS) {
      if (suits.includes(suit)) { this.c1.absences[suit] = 0; continue; }
      this.c1.absences[suit] = (this.c1.absences[suit] || 0) + 1;
      if (this.c1.absences[suit] === C1_B) {
        const ps = C1_MAP[suit]; const next = gn + 1;
        await savePrediction('C1', next, ps, suit);
        this.c1.pending[next] = { suit: ps, rattrapage: 0 };
        this.c1.absences[suit] = 0;
      }
    }
  }

  async _processC2(gn, suits, pCards, bCards) {
    if (this.c2.processed.has(gn)) return;
    this.c2.processed.add(gn);
    await this._resolvePending(this.c2.pending, 'C2', gn, suits, pCards, bCards, (won, suit, pg) => {
      if (won) { this.c2.hadFirstLoss = false; return; }
      if (!this.c2.hadFirstLoss) { this.c2.hadFirstLoss = true; return; }
      this.c2.hadFirstLoss = false;
      const next = gn + 1;
      savePrediction('DC', next, suit, suit);
      this.dc.pending[next] = { suit, rattrapage: 0 };
    });
    for (const suit of ALL_SUITS) {
      if (suits.includes(suit)) { this.c2.absences[suit] = 0; continue; }
      this.c2.absences[suit] = (this.c2.absences[suit] || 0) + 1;
      if (this.c2.absences[suit] === C2_B) {
        const ps = C2_MAP[suit]; const next = gn + 1;
        await savePrediction('C2', next, ps, suit);
        this.c2.pending[next] = { suit: ps, rattrapage: 0 };
        this.c2.absences[suit] = 0;
      }
    }
  }

  async _processC3(gn, suits, pCards, bCards) {
    if (this.c3.processed.has(gn)) return;
    this.c3.processed.add(gn);
    await this._resolvePending(this.c3.pending, 'C3', gn, suits, pCards, bCards, (won, suit, pg) => {
      if (won) { this.c3.consecLosses = 0; return; }
      this.c3.consecLosses++;
      if (this.c3.consecLosses >= 2) {
        this.c3.consecLosses = 0;
        const next = gn + 1;
        savePrediction('DC', next, suit, suit);
        this.dc.pending[next] = { suit, rattrapage: 0 };
      }
    });
    for (const suit of ALL_SUITS) {
      if (suits.includes(suit)) { this.c3.absences[suit] = 0; continue; }
      this.c3.absences[suit] = (this.c3.absences[suit] || 0) + 1;
      if (this.c3.absences[suit] === C3_B) {
        const ps = C3_MAP[suit]; const next = gn + 1;
        await savePrediction('C3', next, ps, suit);
        this.c3.pending[next] = { suit: ps, rattrapage: 0 };
        this.c3.absences[suit] = 0;
      }
    }
  }

  async _processDC(gn, suits, pCards, bCards) {
    for (const [pg, info] of Object.entries(this.dc.pending)) {
      const pgNum = parseInt(pg);
      if (gn < pgNum) continue;
      const ps = info.suit;
      if (suits.includes(ps)) {
        await resolvePrediction('DC', pgNum, ps, 'gagne', info.rattrapage, pCards, bCards);
        delete this.dc.pending[pg];
      } else if (gn > pgNum) {
        if (info.rattrapage < 2) { info.rattrapage++; }
        else { await resolvePrediction('DC', pgNum, ps, 'perdu', info.rattrapage, pCards, bCards); delete this.dc.pending[pg]; }
      }
    }
  }

  async _processCustomStrategy(id, state, cfg, gn, suits, pCards, bCards) {
    if (state.processed.has(gn)) return;
    state.processed.add(gn);

    const channelId = `S${id}`;
    await this._resolvePending(state.pending, channelId, gn, suits, pCards, bCards, null);

    const { threshold: B, mode, mappings, tg_targets, name } = cfg;

    const emitPrediction = async (next, ps, suit) => {
      await savePrediction(channelId, next, ps, suit);
      state.pending[next] = { suit: ps, rattrapage: 0 };
      // Envoi vers tous les canaux Telegram configurés pour cette stratégie
      if (Array.isArray(tg_targets) && tg_targets.length > 0) {
        sendPredictionToTargets(tg_targets, name, next, ps).catch(() => {});
      }
    };

    if (mode === 'manquants') {
      for (const suit of ALL_SUITS) {
        if (suits.includes(suit)) { state.counts[suit] = 0; continue; }
        state.counts[suit] = (state.counts[suit] || 0) + 1;
        if (state.counts[suit] === B) {
          const ps = mappings[suit];
          if (ps) await emitPrediction(gn + 1, ps, suit);
          state.counts[suit] = 0;
        }
      }
    } else if (mode === 'apparents') {
      for (const suit of ALL_SUITS) {
        if (suits.includes(suit)) {
          state.counts[suit] = (state.counts[suit] || 0) + 1;
          if (state.counts[suit] === B) {
            const ps = mappings[suit];
            if (ps) await emitPrediction(gn + 1, ps, suit);
            state.counts[suit] = 0;
          }
        } else { state.counts[suit] = 0; }
      }
    }
  }

  async tick() {
    try {
      const games        = await fetchGames();
      const finished     = games.filter(g => g.is_finished);
      if (finished.length > 0 && finished.some(g => !this.c1.processed.has(g.game_number))) {
        console.log(`[Engine] ${games.length} jeux chargés, ${finished.length} terminés`);
      }
      for (const game of games) {
        if (!game.is_finished) {
          if (!this._lastLiveLog || Date.now() - this._lastLiveLog > 30000) {
            console.log(`[Engine] Jeu ${game.game_number} en cours — phase: ${game.phase || '?'} | ${game.status_label || ''}`);
            this._lastLiveLog = Date.now();
          }
          continue;
        }
        const suits = extractSuits(game.player_cards || []);
        if (!suits.length) continue;
        if (!this.c1.processed.has(game.game_number)) {
          console.log(`[Engine] ✅ Traitement jeu #${game.game_number} | suits: ${suits.join(',')} | gagnant: ${game.winner || '?'}`);
        }
        await this.processGame(game.game_number, suits, game.player_cards, game.banker_cards);
      }
    } catch (e) { console.error('Engine tick error:', e.message); }
  }

  async cleanupStale() {
    try {
      const mx = await db.getMaxResolvedGame();
      if (mx <= 2) return;
      const count = await db.expireStaleByGame(mx - 2);
      if (count > 0) console.log(`🧹 ${count} prédiction(s) hors-fenêtre expirée(s)`);
    } catch (e) { console.error('cleanupStale error:', e.message); }
  }

  async loadExistingPending() {
    try {
      const rows = await db.getPredictions({ status: 'en_cours', limit: 500 });
      for (const row of rows) {
        const { strategy, game_number: gn, predicted_suit: ps, rattrapage: r } = row;
        const entry = { suit: ps, rattrapage: parseInt(r) || 0 };
        if      (strategy === 'C1') this.c1.pending[gn] = entry;
        else if (strategy === 'C2') this.c2.pending[gn] = entry;
        else if (strategy === 'C3') this.c3.pending[gn] = entry;
        else if (strategy === 'DC') this.dc.pending[gn] = entry;
        else if (strategy.startsWith('S') && !isNaN(parseInt(strategy.slice(1)))) {
          const id = parseInt(strategy.slice(1));
          if (!this.custom[id]) this.custom[id] = this._makeCustomState();
          this.custom[id].pending[gn] = entry;
        }
      }
      if (rows.length > 0) console.log(`[Engine] ${rows.length} prédiction(s) en_cours rechargée(s) en mémoire`);
    } catch (e) { console.error('loadExistingPending error:', e.message); }
  }

  async start(intervalMs = 5000) {
    if (this.running) return;
    this.running = true;
    console.log('🚀 Moteur de prédiction démarré');
    await this.loadCustomStrategies();
    await this.cleanupStale();
    await this.loadExistingPending();
    this.tick();
    this.interval = setInterval(() => this.tick(), intervalMs);
    setInterval(() => this.cleanupStale(), 60_000);
  }

  getAbsences(channelId) {
    const THRESHOLDS = { C1: 5, C2: 8, C3: 5 };
    const stateMap   = { C1: this.c1, C2: this.c2, C3: this.c3 };

    if (stateMap[channelId]) {
      const state = stateMap[channelId];
      const threshold = THRESHOLDS[channelId] || 5;
      return ALL_SUITS.map(suit => ({
        suit, display: SUIT_DISPLAY[suit] || suit,
        count: state.absences[suit] || 0, threshold,
      }));
    }

    if (channelId.startsWith('S')) {
      const id    = parseInt(channelId.slice(1));
      const entry = this.custom[id];
      if (!entry?.config) return null;
      const { threshold, mode } = entry.config;
      return ALL_SUITS.map(suit => ({
        suit, display: SUIT_DISPLAY[suit] || suit,
        count: entry.counts[suit] || 0, threshold,
        mode, label: mode === 'apparents' ? 'Apparitions' : 'Absences',
      }));
    }
    return null;
  }

  stop() {
    this.running = false;
    if (this.interval) clearInterval(this.interval);
    console.log('🔴 Moteur arrêté');
  }
}

module.exports = new Engine();
