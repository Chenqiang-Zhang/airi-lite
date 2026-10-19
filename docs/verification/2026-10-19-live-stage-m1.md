# Live stage M1: console → OBS stage loop — 2026-10-19

First milestone of the AI VTuber stage-1 plan ([plan](../plans/2026-10-19-ai-vtuber-stage1.md)). Branch `live-stage-m1` on top of `8dd7ac6`. The host types a line in a console page; the server opens a turn and pushes it to an OBS-ready stage page, which speaks it with the existing speech controller and Live2D pipeline and reports how it ended. Later milestones only change *who decides what to say* (the brain, danmaku).

No DeepSeek, MiniMax, ElevenLabs or Bilibili request was made. No credential was read, displayed or moved. Nothing was deployed. The independent `deploy/airi-lite.service` edit is untouched and excluded.

## What was built

- **Live runtime** (`server/live/`, enabled only with `AIRI_LIVE=1`; the server refuses to start live mode on a non-loopback `HOST`):
  - `local-request.mjs` — every `/api/live/*` request must come from a loopback socket, carry no proxy header (`X-Real-IP`, `X-Forwarded-For`, `Forwarded`), use a `127.0.0.1`/`localhost`/`[::1]` Host on the socket's own port, match Origin when present, and (for POST) send JSON plus `X-Airi-Live: 1`, which forces a CORS preflight that the server never answers.
  - `sse.mjs` — zero-dependency server-sent events: `retry: 2000`, numbered events, a shared unref'd 15 s ping only while pages are connected, and a slow reader is dropped once 256 KiB is buffered.
  - `stage-bus.mjs` — the newest OBS page holds the only speaking lease; an older one is told to stand by; previews show captions only; closing the primary hands the lease to the most recent remaining OBS page.
  - `utterance.mjs` — the server expands each line with the same splitter and arguments as the stage's `speak()` and keeps a multiset allowance.
  - `runtime.mjs` — turn state machine and routes: `stage/events`, `stage/report`, `stage/speech`, `state`, `control` (say, stop, pause, resume, panic, reload-stage). A watchdog of min(90 s, 15 s + 350 ms × characters) ends turns the stage never reports. A lease change cancels the current turn.
- **Server-gated purchasing**: the stage buys audio only through `POST /api/live/stage/speech`. The server checks the lease, the turn and the allowance before calling the shared speech handler, so each planned sentence is bought at most once, only by the primary. `server/speech.mjs` gained `synthesise()` for trusted in-process callers; it shares the four-slot cap and the daily ledger with `/api/speech`. `/api/speech`'s status table and behaviour are unchanged.
- **Stage page** (`stage.html`, `src/stage/`): transparent background, Hiyori with `autoInteract: false`, captions with a dark outline (`?captions=0` hides them), a permanent "AI 生成内容 · 回复可能出错" badge, a "稍后回来" screen for panic, OBS source/stream events reported back, avatar mount retries with backoff, and its own SSE reconnect with backoff so every reconnect gets a fresh lease. Role defaults to `obs` inside OBS and `preview` elsewhere.
- **Speech controller** (`src/speech.ts`): `speak()` takes an optional `{onEnded}` that fires once per run with `played | partial | failed | cancelled | empty`, deferred with `queueMicrotask` so a callback cannot reenter `cancel()`. `browserFallback: false` skips a failed run instead of retrying with the system voice. App.vue passes neither option, so the chat page behaves as before.
- **Console** (`console.html`, `src/console/`): stage and OBS status, current turn and sentence counts, last outcome, last stage problem, a 200-character input (IME-safe Enter), and stop / pause / resume / panic / reload-stage.
- **Rehearsal** (`scripts/mock-live.mjs`): real handler and runtime, `say` (macOS) as a fake TTS, `envDir: false`, loopback port 4176, prints only character counts. Its WAV clips are deliberately labelled `mp3`; the real MiniMax path validates MPEG frames server-side, which this fake bypasses.
- Build and config: all `.html` responses are now `no-cache` (previously only `index.html`, so a rebuilt `stage.html` would have been cached for a year); Vite builds three pages via `build.rolldownOptions.input`; the test glob is recursive and quoted; `tsconfig` sets `erasableSyntaxOnly` so server-imported `.ts` stays strippable by Node.

## Offline verification

- `node --test 'server/**/*.test.mjs' 'src/**/*.test.mjs' 'shared/**/*.test.mjs' 'scripts/**/*.test.mjs'`: **615 passed** (565 existing + 50 new) after the review fixes below, zero failed, skipped or cancelled. `git diff --check` is clean.
- `vue-tsc --noEmit` passed. `vite build` produced `index.html`, `stage.html` and `console.html`; the existing large-chunk warning remains.
- New tests cover: the local-request guard (proxy headers, DNS-rebinding hosts, foreign origins, missing custom header, body limits, malformed UTF-8); SSE framing, heartbeat lifecycle and slow-reader drop; plan/stage sentence parity including cues, URLs, code blocks and duplicates; runtime routes end to end over HTTP (stage readiness gating, per-sentence one-time purchase, lease takeover and promotion, watchdog, stop/pause/resume/panic/reload, input validation, stable error codes without provider detail, shutdown); `synthesise()` reservation, shared cap, timeout mapping; every page `no-cache`; live mode refused on `HOST=0.0.0.0`, served on loopback, clean SIGTERM exit; speech outcomes (played once, cancelled on replace, failed without fallback, partial, empty, media error, browser engine); `decodeCloudSpeechResponse` on a real collector payload; the stage client (primary vs preview, stale stop/ended never clearing a newer caption, standby, refused purchase, reconnect backoff).

## Browser rehearsal (built-in Chromium pane, mock-live)

`node scripts/mock-live.mjs` with the `Eddy (中文（中国大陆）)` system voice; stage at `/airi/stage.html?role=obs`, console at `/airi/console.html`.

1. Stage connected, took the lease, rendered Hiyori and reported `avatar: ready`. `html`/`body` backgrounds computed as `rgba(0, 0, 0, 0)`.
2. After one click on the page (browser autoplay rule; OBS browser sources do not need it), `say` of a two-sentence line: caption shown, server allowed 2/2 sentences, both clips played back to back, the stage reported `played`, and the turn closed (about 5 s).
3. Mid-sentence screenshot showed the caption and an open mouth.
4. Console UI: status, current turn and last outcome rendered; typing and **说** sent a line; **紧急停止** switched the stage to 「稍后回来」 with audio and caption cleared and disabled **说**; **继续** restored it.
5. `stop` 1.5 s into a long line: outcome `stopped`, stage audio paused with its source removed and caption hidden at once.
6. Server log contained only clip numbers, deliveries, character counts and byte sizes.

This rehearsal (before the review fixes) validates the stage, lease, purchase gating, lip-sync wiring and controls. It does not validate real MiniMax audio, OBS's CEF, or a real stream.

## Needs the user (no cost, about 30 minutes)

In OBS 32.x on the streaming Mac, add a browser source `http://127.0.0.1:4176/airi/stage.html?role=obs` at 1920×1080, enable "Control audio via OBS", disable "Shutdown source when not visible" and "Refresh browser when scene becomes active", and set monitoring to "Monitor and Output". Then report:

- whether the background is transparent and the character renders;
- whether speech plays without any click, and the mixer shows exactly one audio source;
- whether the mouth follows the audio;
- dark fringes with sRGB off/on;
- whether the character freezes after switching scenes and back;
- dropped frames at 1080p30;
- the streaming exit: direct OBS push, or 直播姬 for Mac capturing OBS.

## Independent review

Four reviewers (state and races, security and spending, regressions, OBS and long-running runtime) each produced findings, and a separate skeptic per dimension re-checked them against the code with scratch reproductions. All six findings were confirmed and are fixed, each with a regression test:

1. **High — deploy layout crash.** `server/index.mjs` statically imported the live runtime, which imports `src/speech-sentences.ts`. The documented VPS release syncs only `server/`, `shared/` and `dist/`, so the production service would have exited with `ERR_MODULE_NOT_FOUND` even with live mode off. The runtime is now imported only when `AIRI_LIVE=1`. A new test copies `server/`, `shared/` and `package.json` into an empty directory and starts production from it; it fails with the old import and passes now.
2. **Medium — re-entrant turn end.** If a publish closed a stalled primary (more than 256 KiB unread), the lease change re-entered `endTurn()` and the outer call dereferenced a null turn: stop and panic returned 500 (panic never reached the brb screen), and a watchdog firing at that moment would have thrown out of its timer and exited the process. `endTurn()` now detaches the turn before publishing; SSE `onClose` runs in a microtask instead of inside the publish loop; and a `say` whose publish drops the primary now returns 409 and leaves every page's last event `stop`. Three of the four new tests fail on the old code.
3. **Medium — lease theft by a cross-site GET.** A no-cors GET from another site (an `<img>`, or a third-party overlay inside OBS) sends no Origin, so it could open `stage/events?role=obs`, take the lease and mute the broadcast. Any `Sec-Fetch-Site` other than `same-origin` is now refused. Chromium (including OBS's CEF), Firefox and Safari 16.4+ send it; local non-browser tools do not.
4. **Medium — DNS rebinding of shared speech.** In live mode, `/api/speech` and `/api/chat` had no Host allowlist. A rebinding page could hold all four shared speech slots, starving the stage, and drain the shared daily ledger. In live mode the loopback Host allowlist now covers every route. Without live mode nothing changes, so the deployed proxy Host still works. (This exposure already existed on `main` for an unprotected `pnpm dev`; outside live mode it is unchanged.)
5. **Low — shutdown could leave a ledger lock.** `process.exit(0)` right after closing could cut off an in-flight ledger write and leave `.lock`, after which cloud speech fails closed until someone removes it. Shutdown now lets the event loop drain, bounded by an unref'd 3 s timer. Not a regression: the default SIGINT behaviour had the same window.
6. **Low — captions clamped to two lines.** About 68 characters fit at 1080p while the console allows 200. The clamp is removed; the caption is bottom-anchored and grows upward. Per-sentence captions are left for the brain milestone.

## Browser rerun after the fixes

With mock-live restarted on the fixed code, the real Chromium stage still connected through the new `Sec-Fetch-Site` rule (EventSource and fetch are `same-origin`), took the lease, reported `avatar: ready`, and the control POST succeeded. A 103-character line showed in full: six lines in the 800 px pane, `line-clamp: none`, nothing hidden by overflow.

Full playback of that three-sentence line was **not** confirmed in this rerun. The Claude window was not in view, so the browser pane ran as a background page with media output suspended: the audio element reported `playing` with `readyState 4`, but `currentTime` stayed at 0.032 s. Because the media clock never moved, the controller bought only the playing clip plus one lookahead (2/3) and then stopped buying, and the watchdog ended the turn as `timeout`. The safeguards behaved as designed, but the run is not playback evidence. The earlier pre-fix rehearsal, with the window in view, played complete lines; the fixes did not touch the speech or playback code paths. Rehearse once more with the window visible, or directly in OBS.

Follow-ups noted rather than done here: report a `problem` to the console when the stage's playback clock stalls for several seconds (today the host only sees the turn time out), per-sentence captions, and a pid-aware stale-lock check for the TTS ledger (M3 preflight).
