const TelegramBot = require('node-telegram-bot-api');
const fetch       = require('node-fetch');
const db          = require('../db');

let TOKEN = process.env.BOT_TOKEN || null;

async function loadToken() {
  try {
    const val = await db.getSetting('bot_token');
    if (val) TOKEN = val;
  } catch {}
  return TOKEN;
}

async function saveToken(token) {
  await db.setSetting('bot_token', token);
  TOKEN = token;
}

let bot     = null;
let botInfo = null;

// Map: telegramChannelId (string) → { dbId, name, messages[] }
const channelStore = new Map();

// SSE clients
const sseClients = [];

// ── SSE broadcast ──────────────────────────────────────────────────

function broadcast(channelDbId, eventData) {
  const payload = `data: ${JSON.stringify({ channelDbId, ...eventData })}\n\n`;
  for (const client of sseClients) {
    if (!clientCanSee(client, channelDbId)) continue;
    try { client.res.write(payload); } catch {}
  }
}

function clientCanSee(client, channelDbId) {
  if (client.isAdmin) return true;
  const hidden = client.hiddenSet;
  return !hidden || !hidden.has(channelDbId);
}

function formatMessage(msg, channelDbId) {
  return {
    id: msg.message_id,
    text: msg.text || msg.caption || null,
    date: msg.date * 1000,
    channel: msg.chat.title || msg.chat.username || 'Canal',
    channelDbId,
    photo: !!(msg.photo || msg.video || msg.document),
  };
}

function normalizeTgId(id) { return String(id).replace('@', '').toLowerCase(); }

function matchesChannel(msg, tgChannelId) {
  const chatId   = String(msg.chat.id);
  const username = (msg.chat.username || '').toLowerCase();
  const cfg      = normalizeTgId(tgChannelId);
  return chatId === cfg || chatId === `-100${cfg}` || username === cfg || `-100${chatId}` === cfg;
}

// ── Bot ────────────────────────────────────────────────────────────

async function startBot() {
  if (!TOKEN) { console.warn('⚠️  BOT_TOKEN manquant — Telegram désactivé'); return; }
  if (bot) { try { await bot.stopPolling(); } catch {} bot = null; }
  if (channelStore.size === 0) return;

  try { const tmp = new TelegramBot(TOKEN); await tmp.deleteWebhook({ drop_pending_updates: false }); } catch {}
  await new Promise(r => setTimeout(r, 2000));

  bot = new TelegramBot(TOKEN, {
    polling: { allowedUpdates: ['channel_post', 'message'], interval: 3000, params: { timeout: 10 } },
  });

  bot.getMe().then(info => {
    botInfo = info;
    console.log(`🤖 Bot Telegram connecté : @${info.username}`);
  }).catch(err => console.error('Bot getMe error:', err.message));

  function handleIncoming(msg) {
    const chatId   = String(msg.chat.id);
    const chatType = msg.chat.type;
    const text     = msg.text || msg.caption || '(media)';
    console.log(`🔍 Bot reçu [${chatType}] id=${chatId} : ${text.slice(0, 80)}`);
    if (chatType === 'private') return;
    for (const [tgId, ch] of channelStore.entries()) {
      if (matchesChannel(msg, tgId)) {
        const entry = formatMessage(msg, ch.dbId);
        ch.messages.unshift(entry);
        if (ch.messages.length > 100) ch.messages.pop();
        broadcast(ch.dbId, { type: 'new_message', message: entry });
        console.log(`📨 Telegram [${ch.name}]: ${text.slice(0, 60)}`);
        return;
      }
    }
    console.log(`⚠️  Message reçu — aucun canal correspondant (chatId=${chatId})`);
  }

  bot.on('channel_post', handleIncoming);
  bot.on('message', handleIncoming);
  bot.on('polling_error', err => { if (!err.message?.includes('ETELEGRAM')) return; console.error('Telegram polling error:', err.message); });

  console.log(`📡 Bot actif sur ${channelStore.size} canal(aux)`);
}

async function loadConfig() {
  try {
    await loadToken();
    const rows = await db.getTelegramConfigs(true);
    for (const cfg of rows) {
      channelStore.set(cfg.channel_id, { dbId: cfg.id, name: cfg.channel_name || cfg.channel_id, messages: [] });
    }
    if (channelStore.size > 0) await startBot();
  } catch (e) { console.error('Telegram loadConfig error:', e.message); }
}

async function addChannel(tgId, name) {
  if (channelStore.size >= 10) throw new Error('Maximum 10 canaux atteint');
  const row = await db.upsertTelegramConfig({ channel_id: String(tgId), channel_name: name });
  channelStore.set(String(tgId), { dbId: row.id, name, messages: [] });
  await startBot();
  return row;
}

async function removeChannel(dbId) {
  const entry = [...channelStore.entries()].find(([, ch]) => ch.dbId === dbId);
  if (entry) channelStore.delete(entry[0]);
  await db.deleteTelegramConfig(dbId);
  if (channelStore.size === 0 && bot) { try { await bot.stopPolling(); } catch {} bot = null; }
  else if (channelStore.size > 0) await startBot();
}

async function testChannel(channelId) {
  if (!TOKEN) throw new Error('BOT_TOKEN manquant');
  const testBot = new TelegramBot(TOKEN);
  const chat = await testBot.getChat(channelId);
  return { id: String(chat.id), name: chat.title || chat.username || channelId };
}

function getChannels() {
  return [...channelStore.entries()].map(([tgId, ch]) => ({
    dbId: ch.dbId, tgId, name: ch.name, messageCount: ch.messages.length,
  }));
}

function getMessages(dbId) {
  const entry = [...channelStore.values()].find(ch => ch.dbId === dbId);
  return entry ? entry.messages : [];
}

function getStatus() {
  return { connected: !!bot, channelCount: channelStore.size, bot_username: botInfo?.username || null, channels: getChannels() };
}

async function addSSEClient(res, userId, isAdmin) {
  let hiddenSet = null;
  if (!isAdmin) {
    const hidden = await db.getHiddenChannels(userId);
    hiddenSet = new Set(hidden);
  }
  sseClients.push({ res, userId, isAdmin: !!isAdmin, hiddenSet });
}

function removeSSEClient(res) {
  const i = sseClients.findIndex(c => c.res === res);
  if (i !== -1) sseClients.splice(i, 1);
}

// ── Envoi de prédiction vers plusieurs cibles Telegram ─────────────

const SUIT_EMOJI = { '♠': '♠️', '♥': '❤️', '♦': '♦️', '♣': '♣️' };
const SUIT_NAME  = { '♠': 'Pique', '♥': 'Cœur', '♦': 'Carreau', '♣': 'Trèfle' };

async function sendPredictionToTelegram(botToken, tgChannelId, strategyName, gameNumber, predictedSuit) {
  if (!botToken || !tgChannelId) return;
  try {
    const emoji = SUIT_EMOJI[predictedSuit] || predictedSuit;
    const name  = SUIT_NAME[predictedSuit]  || predictedSuit;
    const text  =
      `🎰 *BACCARAT PRO — ${strategyName}*\n\n` +
      `⚡ *Nouvelle prédiction détectée*\n` +
      `🎯 Partie *#${gameNumber}*\n` +
      `🃏 Couleur attendue : *${emoji} ${name}*\n\n` +
      `_Algorithme temps réel · Baccarat Pro_`;

    const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tgChannelId, text, parse_mode: 'Markdown' }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      console.error(`[TG Pred] Erreur → ${tgChannelId}: ${err.slice(0, 120)}`);
    } else {
      console.log(`[TG Pred] #${gameNumber} → ${tgChannelId} (${strategyName})`);
    }
  } catch (e) { console.error(`[TG Pred] Exception: ${e.message}`); }
}

// Envoie vers TOUS les tg_targets d'une stratégie
async function sendPredictionToTargets(targets, strategyName, gameNumber, predictedSuit) {
  if (!Array.isArray(targets) || targets.length === 0) return;
  for (const { bot_token, channel_id } of targets) {
    if (bot_token && channel_id) {
      sendPredictionToTelegram(bot_token, channel_id, strategyName, gameNumber, predictedSuit).catch(() => {});
    }
  }
}

module.exports = {
  loadConfig, addChannel, removeChannel, testChannel,
  getChannels, getMessages, getStatus,
  addSSEClient, removeSSEClient,
  saveToken, loadToken,
  getToken: () => TOKEN,
  startBotPublic: startBot,
  sendPredictionToTelegram,
  sendPredictionToTargets,
};
