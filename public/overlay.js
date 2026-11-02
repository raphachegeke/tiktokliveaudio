/**
 * TikTok TTS Overlay — client
 * ---------------------------
 * Receives events from the server over Socket.IO and:
 *   1. Speaks them aloud (free built-in browser voice, Web Speech API)
 *   2. Shows animated visuals (gift banners, comment bubbles, join toasts)
 *
 * Test mode: add ?test=1 to the URL to simulate events without being live.
 */

(function () {
  'use strict';

  // ------------------------------------------------------------------
  // Fixed spoken phrases (edit here if you ever want different wording)
  // ------------------------------------------------------------------
  const PHRASES = {
    comment: (n, text) => `${n} says: ${text}`,
    giftOne: (n, g) => `Thank you ${n} for the ${g}!`,
    giftMany: (n, g, c) => `Thank you ${n} for the ${g}, sent ${c} times!`,
    follow: (n) => `Welcome aboard ${n}, thanks for following!`,
    share: (n) => `Thanks for sharing the stream, ${n}!`,
    join: (n) => `Welcome to the room, ${n}!`,
    streamEnd: () => `The stream has ended. See you next time!`,
    testIntro: () => `Test mode active. The text to speech is working.`,
  };

  const COMMENT_VISIBLE_MS = 9000;
  const ALERT_VISIBLE_MS = 6500;
  const JOIN_VISIBLE_MS = 5000;
  const MAX_QUEUE = 12;

  // ------------------------------------------------------------------
  // Speech synthesis setup
  // ------------------------------------------------------------------
  const synth = window.speechSynthesis || null;
  let chosenVoice = null;
  let audioUnlocked = false;

  function pickVoice() {
    if (!synth) return;
    const voices = synth.getVoices() || [];
    const english = voices.filter((v) => /^en(-|_|$)/i.test(v.lang));
    chosenVoice =
      english.find((v) => /google us english/i.test(v.name)) ||
      english.find((v) => /natural|neural|aria|jenny|guy/i.test(v.name)) ||
      english.find((v) => /en[-_]us/i.test(v.lang)) ||
      english[0] ||
      voices[0] ||
      null;
  }
  if (synth) {
    pickVoice();
    synth.onvoiceschanged = pickVoice;
  }

  // Browsers block audio until there has been some user interaction in the
  // page. We attempt a silent unlock immediately and again on any click/tap.
  function unlockAudio() {
    if (!synth || audioUnlocked) return;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      u.onend = () => { audioUnlocked = true; };
      synth.speak(u);
    } catch (_) { /* not fatal */ }
  }
  unlockAudio();
  window.addEventListener('click', unlockAudio);
  window.addEventListener('keydown', unlockAudio);

  // ------------------------------------------------------------------
  // TTS queue with priorities  (1 = highest)
  //   gift 1 | follow 2 | share 2 | comment 3 | join 4
  // ------------------------------------------------------------------
  const queue = [];
  let speaking = false;
  let watchdog = null;

  function speak(text, priority) {
    if (!text) return;
    const item = { text: text.slice(0, 300), priority: priority || 3 };

    if (queue.length >= MAX_QUEUE) {
      // Queue is full: drop the OLDEST low-priority item to make room,
      // so gifts and follows are never the ones being dropped.
      const idx = queue.findIndex((q) => q.priority >= 3);
      queue.splice(idx === -1 ? 0 : idx, 1);
    }

    if (priority && priority < 2) {
      // Gifts / follows jump the line ahead of queued comments
      const firstLow = queue.findIndex((q) => q.priority > item.priority);
      if (firstLow === -1) queue.push(item); else queue.splice(firstLow, 0, item);
    } else {
      queue.push(item);
    }
    processQueue();
  }

  function processQueue() {
    if (speaking || queue.length === 0) return;

    // If speech is unavailable, drain the queue instantly (visuals still work)
    if (!synth) {
      queue.splice(0, queue.length);
      return;
    }

    const next = queue.shift();
    speaking = true;

    try {
      synth.cancel(); // clear anything stale
      const u = new SpeechSynthesisUtterance(next.text);
      if (chosenVoice) u.voice = chosenVoice;
      u.lang = (chosenVoice && chosenVoice.lang) || 'en-US';
      u.rate = 1.05; // fixed voice settings
      u.pitch = 1.0;
      u.volume = 1.0;

      const done = () => {
        if (watchdog) { clearTimeout(watchdog); watchdog = null; }
        speaking = false;
        setTimeout(processQueue, 150);
      };
      u.onend = done;
      u.onerror = done;

      // Watchdog: never let one bad utterance freeze the whole queue
      const budget = Math.max(8000, next.text.length * 110) + 6000;
      watchdog = setTimeout(() => {
        try { synth.cancel(); } catch (_) { /* noop */ }
        done();
      }, budget);

      synth.speak(u);
    } catch (_) {
      speaking = false;
      setTimeout(processQueue, 150);
    }
  }

  // ------------------------------------------------------------------
  // Visuals
  // ------------------------------------------------------------------
  const commentsBox = document.getElementById('comments');
  const alertsBox = document.getElementById('alerts');
  const joinsBox = document.getElementById('joins');
  const statusBox = document.getElementById('status');
  const statusLabel = document.getElementById('status-label');

  function fadeOutAndRemove(el, delay) {
    setTimeout(() => {
      el.classList.add('fading');
      setTimeout(() => el.remove(), 700);
    }, delay);
  }

  function capChildren(box, max) {
    while (box.children.length > max) box.removeChild(box.firstChild);
  }

  function showComment(nick, text) {
    const div = document.createElement('div');
    div.className = 'comment';
    const nickSpan = document.createElement('span');
    nickSpan.className = 'nick';
    nickSpan.textContent = nick;
    div.appendChild(nickSpan);
    div.appendChild(document.createTextNode(text));
    commentsBox.appendChild(div);
    capChildren(commentsBox, 5);
    fadeOutAndRemove(div, COMMENT_VISIBLE_MS);
  }

  function showAlert(kind, nick, iconHtml, subText) {
    const div = document.createElement('div');
    div.className = 'alert ' + kind;
    const icon = document.createElement('div');
    icon.className = 'icon';
    icon.innerHTML = iconHtml;
    const label = document.createElement('div');
    label.className = 'label';
    label.appendChild(document.createTextNode(kindText(kind, nick)));
    if (subText) {
      const sub = document.createElement('span');
      sub.className = 'sub';
      sub.textContent = subText;
      label.appendChild(sub);
    }
    div.appendChild(icon);
    div.appendChild(label);
    alertsBox.appendChild(div);
    capChildren(alertsBox, 3);
    fadeOutAndRemove(div, ALERT_VISIBLE_MS);
  }

  function kindText(kind, nick) {
    if (kind === 'gift') return `Thank you ${nick}!`;
    if (kind === 'follow') return `New follower: ${nick}!`;
    return `Thanks for sharing, ${nick}!`;
  }

  function showJoin(nick) {
    const div = document.createElement('div');
    div.className = 'join-toast';
    const b = document.createElement('b');
    b.textContent = nick;
    div.appendChild(b);
    div.appendChild(document.createTextNode(' joined the live'));
    joinsBox.appendChild(div);
    capChildren(joinsBox, 4);
    fadeOutAndRemove(div, JOIN_VISIBLE_MS);
  }

  function setStatus(s) {
    const map = {
      connected: 'status connected',
      disconnected: 'status retrying',
      retrying: 'status retrying',
      connecting: 'status retrying',
      starting: 'status offline',
      error: 'status error',
      streamEnd: 'status retrying',
    };
    statusBox.className = map[s.type] || 'status offline';
    statusLabel.textContent = s.message || 'Idle';
  }

  // ------------------------------------------------------------------
  // Event routing: speak + show
  // ------------------------------------------------------------------
  let lastStreamEndSpokenAt = 0;

  function handleEvent(evt) {
    const n = evt.nickname || 'someone';
    switch (evt.type) {
      case 'chat': {
        showComment(n, evt.text);
        speak(PHRASES.comment(n, evt.text), 3);
        break;
      }
      case 'gift': {
        const g = evt.gift || {};
        const count = g.count || 1;
        const icon = g.image
          ? `<img src="${g.image}" alt="" />`
          : '&#127873;'; // gift box
        showAlert('gift', n, icon, g.name ? `${g.name}${count > 1 ? ' x' + count : ''}` : '');
        speak(count > 1 ? PHRASES.giftMany(n, g.name || 'gift', count) : PHRASES.giftOne(n, g.name || 'gift'), 1);
        break;
      }
      case 'follow': {
        showAlert('follow', n, '&#11088;'); // star
        speak(PHRASES.follow(n), 2);
        break;
      }
      case 'share': {
        showAlert('share', n, '&#128640;'); // rocket
        speak(PHRASES.share(n), 2);
        break;
      }
      case 'join': {
        showJoin(n);
        speak(PHRASES.join(n), 4);
        break;
      }
      case 'streamEnd': {
        if (Date.now() - lastStreamEndSpokenAt > 5 * 60 * 1000) {
          lastStreamEndSpokenAt = Date.now();
          speak(PHRASES.streamEnd(), 1);
        }
        break;
      }
    }
  }

  // ------------------------------------------------------------------
  // Socket connection
  // ------------------------------------------------------------------
  const isTestMode = /[?&]test=1/.test(location.search);

  if (!isTestMode) {
    const socket = io();
    socket.on('tiktok-event', handleEvent);
    socket.on('status', setStatus);
    socket.on('connect', () => unlockAudio());
  } else {
    setStatus({ type: 'connected', message: 'TEST MODE — simulated events' });
    runTestMode();
  }

  // ------------------------------------------------------------------
  // Test mode: realistic simulated events, no live stream required
  // ------------------------------------------------------------------
  function runTestMode() {
    speak(PHRASES.testIntro(), 1);

    const scenarios = [
      () => handleEvent({ type: 'join', nickname: 'Jessy' }),
      () => handleEvent({ type: 'chat', nickname: 'Mike', text: 'Where are you streaming from today?' }),
      () => handleEvent({ type: 'follow', nickname: 'Sara99' }),
      () => handleEvent({ type: 'chat', nickname: 'DanTheMan', text: 'That is amazing, first time watching and I love it!' }),
      () => handleEvent({ type: 'gift', nickname: 'Maria', gift: { name: 'Rose', count: 1, image: null } }),
      () => handleEvent({ type: 'share', nickname: 'Lolzzz' }),
      () => handleEvent({ type: 'gift', nickname: 'BigFan', gift: { name: 'TikTok Universe', count: 5, image: null } }),
      () => handleEvent({ type: 'chat', nickname: 'QuietViewer', text: 'Say hi to my mom, she is watching with me!' }),
    ];

    let i = 0;
    setInterval(() => {
      scenarios[i % scenarios.length]();
      i += 1;
    }, 4500);
  }
})();
