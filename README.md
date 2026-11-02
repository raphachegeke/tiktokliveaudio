# TikTok LIVE Text-to-Speech Overlay

Reads your TikTok LIVE events out loud on a webpage — **comments, gifts, follows, shares and viewer joins** — using the free built-in browser voice. Add the page as a **Web source in TikTok Live Studio** (or OBS) and the audio + visuals go straight into your stream.

## What it does

| Event | Spoken (English) | Visual |
|---|---|---|
| Comment | `Mike says: where are you from?` | Bubble on the left |
| Gift (x1) | `Thank you Maria for the Rose!` | Gold banner + gift icon |
| Gift (streak) | `Thank you BigFan for the TikTok Universe, sent 5 times!` | Gold banner with count |
| Follow | `Welcome aboard Sara99, thanks for following!` | Pink banner |
| Share | `Thanks for sharing the stream, Lolzzz!` | Teal banner |
| Join | `Welcome to the room, Jessy!` | Small toast bottom-left |

Built-in behavior you don't have to configure:

- **Gifts jump the queue** — a gift is spoken before older queued comments.
- **Gift streaks are announced once** with the full count (no "Rose, Rose, Rose...").
- **Spam guards** — emojis and links are stripped, very long comments are cut short, identical messages within 10s are skipped, join announcements are rate-limited.
- If the queue ever backs up, old comments/joins are dropped first — gifts and follows are never dropped.

---

## Setup (5 minutes, one time)

**1. Install Node.js** (v18 or newer): <https://nodejs.org> — choose the **LTS** installer for Windows/Mac.

**2. Put your username in `config.json`:**

```json
"username": "YOUR_TIKTOK_USERNAME"
```

Just the handle, no `@` and no URL (e.g. `charlidamelio`).

**3. Install and start** — open a terminal in this folder:

```
npm install
npm start
```

Leave that window open while you stream. If you're not live yet, it prints
`Not live yet — waiting for you to go live` and checks every 60 seconds,
connecting automatically the moment you go live. You can also pass the
username on the command line: `node server.js yourusername`.

**3b. Strongly recommended: a free Euler API key (2 minutes)**

TikTok connection requests must be cryptographically signed by a third-party
service ([Euler Stream](https://www.eulerstream.com)). Without a key you share
one anonymous allowance with everyone on your IP — when it's busy you'll see
errors like `This endpoint requires a Business plan` or `Too Many Requests`.
A **free** API key gives you your own dedicated quota:

1. Go to <https://www.eulerstream.com> → **Register** (free, no credit card).
2. Open the Dashboard and copy your API key.
3. Paste it into `config.json`:  `"signApiKey": "your-key-here"`
4. Restart `npm start`.

You never need to pay — the free tier is plenty for a personal overlay.

**4. Test before going live** — open this in a normal browser (Chrome/Edge):

```
http://localhost:8383/?test=1
```

You should hear spoken test events and see the banners. The first time, click
once anywhere on the page if you hear nothing (browsers block audio until
there's been one interaction).

---

## Add it to TikTok Live Studio

1. In TikTok Live Studio click **+** to add a source → choose the **Web / Webpage** source type.
2. Paste the URL:

```
http://localhost:8383
```

3. Name it "TTS Overlay" and confirm.

### Getting the audio into your stream

The page speaks with the browser's own voice, so the sound must reach Live Studio through one of these routes — try them in this order:

1. **Web source audio**: if Live Studio offers an audio/volume option on the Web source, enable it and set the source volume above zero.
2. **Desktop audio**: let the page play through your speakers and capture your **desktop/system audio** in Live Studio. Simple, but you'll hear it too (use it for testing).
3. **Virtual audio cable (cleanest)**: install a free virtual cable such as **VB-CABLE**, set it as the page's output device, then add an *Audio Input Capture* source in Live Studio that records "CABLE Output". Only your stream hears the TTS — you don't.

> Tip: click the speaker icon on the Web source in Live Studio to check it isn't muted, and keep the overlay page volume (if shown) at 100%.

### What the visuals look like

- **Comments** — translucent bubbles, left side, fade out after ~9s.
- **Gifts** — big gold banner center-top with the gift's icon, sparkles, streak count.
- **Follows / shares** — pink / teal banners.
- **Joins** — small toasts bottom-left.
- **Status dot** — top-right: green = connected and listening, orange = retrying.

Don't want any visuals on screen? Just crop/resize the Web source to zero, or hide layers — the audio keeps working. The page background is solid black, so it also looks clean if you leave it visible.

---

## Your filters (edit `config.json`, restart `npm start`)

```json
"bannedWords":  ["examplebadword", "anotherone"],
"ignoredUsers": ["somebotuser", "trollname"]
```

- `bannedWords` — comments containing any of these (case-insensitive) are never spoken or shown.
- `ignoredUsers` — TikTok usernames (lowercase, no `@`) whose comments/gifts/joins are completely ignored.
- `maxCommentLength` — max spoken characters per comment (default 150).
- `dedupeSeconds` — skip identical text from the same user within this window.
- `joinCooldownSeconds` / `joinGlobalCooldownSeconds` — join-announcement rate limits.
- `retryOfflineSeconds` — how often to check "am I live yet?" while waiting (default 60).
- `signApiKey` — your free Euler Stream API key (see step 3b above) for a dedicated, steadier connection quota.
- `speakComments` / `speakGifts` / `speakFollows` / `speakShares` / `speakJoins` — set any to `false` to silence that event type.

Spoken phrases are defined at the top of `public/overlay.js` in the `PHRASES` block if you ever want different wording.

---

## Deploy it online later (optional)

The same folder runs unchanged on any Node host (Render, Railway, Fly.io, a VPS):

1. Push the folder to GitHub.
2. Create a **Web Service** on the host, select the repo — the host detects `npm start` (Render/Railway set `PORT` automatically; the server already respects it).
3. Set the environment variable `TIKTOK_USERNAME` to your handle (or keep it in config.json).
4. Use the public URL in Live Studio instead of localhost: `https://your-app.onrender.com`

One warning: a public URL means anyone with the link can open your overlay. That's harmless (it only *displays* events), but keep the URL to yourself.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `No TikTok username set` | Put your handle in `config.json` → `username`, restart. |
| `The requested user isn't online` | **Not an error** — you weren't live at that moment. The tool keeps checking and connects automatically when you start streaming. If you ARE live and still see it, the username in `config.json` is probably misspelled (no `@`). |
| `This endpoint requires a Business plan` / `Too Many Requests (429)` | The shared anonymous signing allowance ran out. Get the **free** Euler API key (step 3b above) — no payment needed. It also usually clears on its own within the hour; nothing is broken. |
| Connected but no comments appear | Post something in your own chat. Also check that only **one** overlay tab is open. |
| No audio in the stream | Work through the three audio routes above. Test first in a normal browser with `?test=1`. |
| Voice sounds robotic | That's the free built-in voice — it works offline and costs nothing. (An ElevenLabs/Google Cloud voice can be swapped in later if you want.) |
| `npm` is not recognized | Node.js isn't installed or the terminal wasn't reopened after installing. |

## Tech notes

- Server: Node.js + Express + Socket.IO, connector library: [tiktok-live-connector](https://github.com/zerodytrash/TikTok-Live-Connector) (unofficial, no login required).
- Speech: browser **Web Speech API** — no API keys, no cost, works offline.
- The overlay expects an English voice; all spoken output is English.
