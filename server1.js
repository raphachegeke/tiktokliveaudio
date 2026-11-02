/**
 * TikTok LIVE Text-to-Speech Overlay — Server
 * --------------------------------------------
 * Connects to a TikTok LIVE stream (no login needed), listens for
 * comments / gifts / follows / shares / joins, applies your filters,
 * and pushes clean events to the overlay webpage via Socket.IO.
 *
 * Run:  node server.js            (uses config.json)
 *   or  node server.js someuser   (overrides the username)
 *
 * The overlay page is served at:  http://localhost:8383
 * Test mode (no live stream needed): http://localhost:8383/?test=1
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { TikTokLiveConnection, WebcastEvent } = require('tiktok-live-connector');

// ---------------------------------------------------------------------------
// 1. Configuration
// ---------------------------------------------------------------------------

const CONFIG_PATH = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

// Priority: command-line argument > TIKTOK_USERNAME env var > config.json
const username = (
  process.argv[2] ||
  process.env.TIKTOK_USERNAME ||
  config.username ||
  ''
)
  .trim()
  .replace(/^@/, '')
  .replace(/^https?:\/\/(www\.)?tiktok\.com\/@?/i, '')
  .replace(/\/live\/?$/i, '');

const PORT = Number(process.env.PORT || config.port || 8383);

const bannedWords = (config.bannedWords || []).map((w) => String(w).toLowerCase());
const ignoredUsers = (config.ignoredUsers || []).map((u) =>
  String(u).toLowerCase().replace(/^@/, '')
);

// Human-readable (masked) description of the Euler API key state, used in the
// startup banner and on quota errors so you can SEE whether the key was read.
function describeApiKey() {
  const k = String(config.signApiKey || '').trim();
  if (!k) return 'NOT SET (using shared anonymous allowance)';
  if (/[\s'"]/.test(k)) {
    return 'SET BUT MALFORMED — it contains spaces/quotes. Re-copy the key exactly.';
  }
  return `loaded (${k.slice(0, 4)}…${k.slice(-3)})`;
}

// ---------------------------------------------------------------------------
// 2. Text cleaning helpers (the "Basic" filters)
// ---------------------------------------------------------------------------

const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{E000}-\u{F8FF}]/gu;

function cleanText(raw, maxLen) {
  if (!raw) return '';
  let text = String(raw);

  // Remove links (never speak a URL aloud)
  text = text.replace(/(https?:\/\/|www\.)\S+/gi, '');

  // Remove emojis / symbols / dingbats
  text = text.replace(EMOJI_RE, '');

  // Remove zero-width & control characters
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u200B-\u200F\u202A-\u202E\u2060\u200D\u0000-\u0008\u000B-\u001F]/g, '');

  // Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim();

  // Cap length at a word boundary
  if (text.length > maxLen) {
    const cut = text.slice(0, maxLen);
    const lastSpace = cut.lastIndexOf(' ');
    text = (lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut) + '...';
  }
  return text;
}

function cleanNickname(raw) {
  return cleanText(raw, 40) || 'someone';
}

// ---------------------------------------------------------------------------
// 3. Anti-spam state
// ---------------------------------------------------------------------------

const lastSeenMessage = new Map(); // "user:text" -> timestamp (dedupe)
const lastJoinPerUser = new Map(); // uniqueId -> timestamp
let lastJoinGlobal = 0;

// Periodically clear the dedupe map so it never grows forever
setInterval(() => {
  const now = Date.now();
  const ttl = Math.max(config.dedupeSeconds || 10, 10) * 1000 * 5;
  for (const [key, ts] of lastSeenMessage) {
    if (now - ts > ttl) lastSeenMessage.delete(key);
  }
  for (const [key, ts] of lastJoinPerUser) {
    if (now - ts > (config.joinCooldownSeconds || 30) * 1000 * 5) lastJoinPerUser.delete(key);
  }
}, 60 * 1000);

// ---------------------------------------------------------------------------
// 4. HTTP + Socket.IO server
// ---------------------------------------------------------------------------

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    username,
    connected: connectionState.connected,
    signKeyLoaded: Boolean(String(config.signApiKey || '').trim()),
  });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

io.on('connection', (socket) => {
  // Tell every newly opened browser tab the current connection status
  socket.emit('status', connectionState);
});

function broadcastEvent(evt) {
  io.emit('tiktok-event', evt);
}

function broadcastStatus(partial) {
  connectionState = { ...connectionState, ...partial, ts: Date.now() };
  io.emit('status', connectionState);
}

let connectionState = {
  type: 'starting',
  message: 'Connecting to TikTok...',
  username,
  connected: false,
};

// ---------------------------------------------------------------------------
// 5. Normalizers — turn raw library payloads into simple, safe objects.
//    Defensive on purpose: this is an unofficial API and field shapes vary
//    a little between library versions.
// ---------------------------------------------------------------------------

function getUser(data) {
  if (!data) return null;

  if (data.user) return data.user;

  if (data.member) return data.member;

  if (Array.isArray(data.memberList) && data.memberList.length) {
    return data.memberList[data.memberList.length - 1];
  }

  if (data.uniqueId || data.nickname) {
    return data;
  }

  return null;
}

function giftNameOf(data) {
  return (
    data.extendedGiftInfo?.name ||
    data.giftDetails?.gift_name ||
    data.giftDetails?.giftName ||
    data.giftName ||
    'a special gift'
  );
}

function giftImageOf(data) {
  const candidates = [
    data.giftDetails?.giftImage?.url?.[0],
    data.giftDetails?.giftImage?.url_list?.[0],
    data.extendedGiftInfo?.image?.url_list?.[0],
    data.extendedGiftInfo?.image?.urls?.[0],
    data.extendedGiftInfo?.images?.[0]?.url_list?.[0],
    data.giftDetails?.gift_image?.url_list?.[0],
  ];
  return candidates.find((c) => typeof c === 'string' && c.startsWith('http')) || null;
}

// ---------------------------------------------------------------------------
// 6. Event handlers
// ---------------------------------------------------------------------------

function shouldIgnoreUser(uniqueId) {
  return ignoredUsers.includes(String(uniqueId || '').toLowerCase());
}

function isBanned(text) {
  if (!bannedWords.length) return false;
  const lower = ` ${text.toLowerCase()} `;
  return bannedWords.some((word) => lower.includes(word));
}

function handleChat(data) {
  const user = getUser(data);
  if (!user) return;
  if (shouldIgnoreUser(user.uniqueId)) return;

  const text = cleanText(data.comment, config.maxCommentLength || 150);
  if (!text) return; // was only emojis/links
  if (isBanned(text)) return;

  // Duplicate-spam guard: same user + same text within dedupeSeconds
  const key = `${String(user.uniqueId).toLowerCase()}:${text.toLowerCase()}`;
  const now = Date.now();
  const dedupeMs = (config.dedupeSeconds || 10) * 1000;
  if (lastSeenMessage.has(key) && now - lastSeenMessage.get(key) < dedupeMs) return;
  lastSeenMessage.set(key, now);

  console.log(`[chat] ${user.uniqueId}: ${text}`);
  broadcastEvent({
    type: 'chat',
    nickname: cleanNickname(user.nickname || user.uniqueId),
    uniqueId: user.uniqueId,
    text,
  });
}

function handleGift(data) {
  const user = getUser(data);
  if (!user) return;
  if (shouldIgnoreUser(user.uniqueId)) return;

  // Gift streaks: while a user is tap-tap-tapping the same gift, the library
  // fires many events with repeatEnd = false. Only announce the FINAL event,
  // which carries the full streak count. Non-streak gifts come with
  // repeatEnd === true (or undefined) right away.
  if (data.repeatEnd === false) return;

  const count = Number(data.repeatCount || 1);
  const name = cleanText(giftNameOf(data), 40) || 'a special gift';

  console.log(`[gift] ${user.uniqueId} -> ${name} x${count}`);
  broadcastEvent({
    type: 'gift',
    nickname: cleanNickname(user.nickname || user.uniqueId),
    uniqueId: user.uniqueId,
    gift: { name, count, image: giftImageOf(data) },
  });
}

function handleJoin(data) {
  const user = getUser(data);
  if (!user) return;
  if (shouldIgnoreUser(user.uniqueId)) return;

  const now = Date.now();
  const key = String(user.uniqueId || '').toLowerCase();

  // Per-user cooldown (people bounce in and out of the room)
  const perUserMs = (config.joinCooldownSeconds || 30) * 1000;
  if (lastJoinPerUser.has(key) && now - lastJoinPerUser.get(key) < perUserMs) return;
  lastJoinPerUser.set(key, now);

  // Global cooldown (big rooms = join floods)
  const globalMs = (config.joinGlobalCooldownSeconds || 2) * 1000;
  if (now - lastJoinGlobal < globalMs) return;
  lastJoinGlobal = now;

  console.log(`[join] ${user.uniqueId}`);
  broadcastEvent({
    type: 'join',
    nickname: cleanNickname(user.nickname || user.uniqueId),
    uniqueId: user.uniqueId,
  });
}

function handleFollow(data) {
  const user = getUser(data);
  if (!user) return;
  if (shouldIgnoreUser(user.uniqueId)) return;
  console.log(`[follow] ${user.uniqueId}`);
  broadcastEvent({
    type: 'follow',
    nickname: cleanNickname(user.nickname || user.uniqueId),
    uniqueId: user.uniqueId,
  });
}

function handleShare(data) {
  const user = getUser(data);
  if (!user) return;
  if (shouldIgnoreUser(user.uniqueId)) return;
  console.log(`[share] ${user.uniqueId}`);
  broadcastEvent({
    type: 'share',
    nickname: cleanNickname(user.nickname || user.uniqueId),
    uniqueId: user.uniqueId,
  });
}

// ---------------------------------------------------------------------------
// 7. TikTok connection with automatic retry
//    (start it before going live — it keeps trying until you're live,
//     reconnects after drops, and starts over when your stream ends)
// ---------------------------------------------------------------------------

let connection = null;
let retryTimer = null;
let streamEndCooldown = false;
let quotaHintShown = false;

// Errors from the signing service (Euler Stream) fall into 3 buckets, each
// with its own message and retry speed:
//   offline -> you're simply not live yet (normal, cheap to retry)
//   quota   -> shared free signing allowance exhausted (retry slowly,
//              recommend a free Euler API key)
//   error   -> anything else (transient network/TikTok issues)
function classifyConnectError(err, msg) {
  const name = String(err?.name || '');
  if (name === 'UserOfflineError' || /isn.?t online|is offline|not (currently )?live/i.test(msg)) {
    return 'offline';
  }
  if (/business plan|rate.?limit|429|too many requests/i.test(msg)) {
    return 'quota';
  }
  return 'error';
}

function buildConnection() {
  const options = {
    // Ignore the first batch of "old" chat history on connect so the overlay
    // doesn't read out a burst of messages from before the page opened
    processInitialData: false,
    // IMPORTANT: enableExtendedGiftInfo is deliberately OFF. It triggers an
    // extra signed HTTP call (gift/list) through Euler Stream, whose generic
    // request-signing endpoint now requires a Business plan — that failure
    // aborts the ENTIRE connection. Gift names and images still arrive
    // natively in the WebSocket payload via data.giftDetails. Only turn this
    // on (config.json -> "extendedGiftInfo": true) if you have a Business key.
  };
  if (config.extendedGiftInfo === true) options.enableExtendedGiftInfo = true;
  if (config.signApiKey) options.signApiKey = config.signApiKey;

  const conn = new TikTokLiveConnection(username, options);

  conn.on(WebcastEvent.CONNECTED, (state) => {
    console.log(`\n✅ Connected to TikTok LIVE for @${username} (roomId ${state.roomId})`);
    console.log('   Open the overlay:  http://localhost:' + PORT);
    console.log('   Test the overlay:  http://localhost:' + PORT + '/?test=1\n');
    broadcastStatus({ type: 'connected', connected: true, message: 'LIVE — listening', roomId: state.roomId });
  });

  conn.on(WebcastEvent.DISCONNECTED, () => {
    console.log('⚠️  Disconnected from TikTok. Reconnecting...');
    broadcastStatus({ type: 'disconnected', connected: false, message: 'Reconnecting...' });
    scheduleRetry(3000);
  });

  conn.on(WebcastEvent.ERROR, (err) => {
    console.error('[connector error]', err?.message || err);
  });

  conn.on(WebcastEvent.STREAM_END, () => {
    console.log('ℹ️  The TikTok stream ended. Waiting for your next live...');
    broadcastStatus({ type: 'streamEnd', connected: false, message: 'Stream ended — waiting for next live' });
    if (!streamEndCooldown) {
      streamEndCooldown = true;
      broadcastEvent({ type: 'streamEnd' });
      setTimeout(() => (streamEndCooldown = false), 60 * 1000);
    }
    try { conn.disconnect(); } catch (_) { /* noop */ }
    scheduleRetry(15000);
  });

  conn.on(WebcastEvent.CHAT, handleChat);
  conn.on(WebcastEvent.GIFT, handleGift);
  conn.on(WebcastEvent.MEMBER, handleJoin);
  conn.on(WebcastEvent.FOLLOW, handleFollow);
  conn.on(WebcastEvent.SHARE, handleShare);

  return conn;
}

function scheduleRetry(delayMs) {
  if (retryTimer) return;
  retryTimer = setTimeout(async () => {
    retryTimer = null;
    await connectTikTok();
  }, delayMs);
}

async function connectTikTok() {
  if (!username) {
    console.error(
      '\n❌ No TikTok username set!\n' +
        '   Edit config.json and put your username in "username",\n' +
        '   or run:  node server.js yourusername\n'
    );
    broadcastStatus({ type: 'error', connected: false, message: 'No username set in config.json' });
    return;
  }

  try {
    broadcastStatus({ type: 'connecting', connected: false, message: `Connecting to @${username}...` });
    connection = buildConnection();
    await connection.connect();
  } catch (err) {
    const msg = String(err?.message || err);
    const kind = classifyConnectError(err, msg);
    try { connection?.disconnect(); } catch (_) { /* noop */ }

    if (kind === 'offline') {
      console.log(`ℹ️  @${username} is not live right now — this is normal.`);
      console.log('   Leave this window open: it checks every ' +
        (config.retryOfflineSeconds || 60) + 's and connects the');
      console.log('   moment you start your stream. (If this never changes,');
      console.log('   double-check the username in config.json, no "@".)');
      broadcastStatus({ type: 'offline', connected: false, message: 'Not live yet — waiting for you to go live' });
      scheduleRetry((config.retryOfflineSeconds || 60) * 1000);
    } else if (kind === 'quota') {
      console.log(`⚠️  Euler signing error: ${msg}`);
      console.log(`   API key attached: ${String(config.signApiKey || '').trim() ? 'YES' : 'NO'} — key state: ${describeApiKey()}`);
      if (!quotaHintShown) {
        quotaHintShown = true;
        console.log('\n   This endpoint (generic HTTP request signing) needs Euler\'s');
        console.log('   Business plan. The overlay already avoids it — you should only');
        console.log('   see this error if:');
        console.log('     • config.json has "extendedGiftInfo": true  → set it to false');
        console.log('       (you are running an old server.js — re-download the latest)');
        console.log('     • Euler Stream itself is rate-limiting or briefly down →');
        console.log('       waiting usually fixes it; the tool retries every 2 minutes.\n');
      }
      broadcastStatus({ type: 'retrying', connected: false, message: 'Signing quota reached — retrying in 2 min (see console)' });
      scheduleRetry(120000);
    } else {
      console.error(`❌ Could not connect (${msg})`);
      console.error('   Retrying in 45 seconds... (leave this running — it will');
      console.error('   connect automatically once you go live)');
      broadcastStatus({ type: 'retrying', connected: false, message: 'Connection issue — retrying' });
      scheduleRetry(45000);
    }
  }
}

// ---------------------------------------------------------------------------
// 8. Start everything
// ---------------------------------------------------------------------------

server.listen(PORT, () => {
  console.log('----------------------------------------------');
  console.log('  TikTok LIVE Text-to-Speech Overlay');
  console.log('----------------------------------------------');
  console.log(`  Overlay URL : http://localhost:${PORT}`);
  console.log(`  Test mode   : http://localhost:${PORT}/?test=1`);
  console.log(`  TikTok user : @${username || '(not set yet!)'}`);
  console.log(`  Euler API key: ${describeApiKey()}`);
  console.log('----------------------------------------------\n');
  connectTikTok();
});

// Graceful shutdown
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\nShutting down...');
    try { connection?.disconnect(); } catch (_) { /* noop */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  });
}

