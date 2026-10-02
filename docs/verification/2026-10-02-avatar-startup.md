# Avatar startup isolation — 2026-10-02

## Scope

Keep the text/speech interface usable when Live2D dependencies are slow or unavailable. This is progress on the device-performance objective, not proof of natural speech, human-rated conversation, physical-phone performance, or phoneme-level lip sync.

Baseline: `1bc248b`. Previously the HTML synchronously loaded the official Cubism Core script, and App statically imported Pixi/Live2D. The installed plugin checks Core during module evaluation, so the App's mount catch could not isolate a missing Core.

## Implementation

- Remove the parser-blocking Core script from the app HTML.
- Initialize chat, settings, speech and provider health independently.
- Load the same fixed official Core URL asynchronously with a 15-second deadline; validate the methods the installed plugin needs, then import the avatar module.
- Share a pending Core request; cancel only each consumer's wait. Observe late success/failure, remove listeners/timers, and allow a failed load to retry.
- After import, check the current stage, view disposal and abort signal before creating the renderer. Preserve late-instance destruction and latest mouth/activity/context synchronization.
- Show a character-unavailable notice without disabling text or speech.

Removing a tag does not prove a fetched classic script can never execute later. Dynamic import is not network-abortable. These limits are explicit in source comments.

## Build and tests

`pnpm test`: **346 passed, 0 failed**. `pnpm build`: TypeScript and Vite successful. The existing large avatar/Kokoro chunk warning remains; it is not suppressed.

| App entry | Before | After |
| --- | ---: | ---: |
| Uncompressed JS bytes | 752,841 | 136,879 |
| Gzip bytes, Node gzipSync with default options in both measurements | 218,989 | 51,594 |

After entry: `index-DBoSWb_I.js`, SHA-256 `367f00117cac55c2c06b1e090264ca0ead87e788ca018eafb9ff872f37360bc3`.

Live2D is now `live2d-C52Qzspp.js` (about 617 KB); Kokoro remains a separate approximately 2.19 MB chunk plus approximately 26.9 MB WASM. HTML contains neither a Core script nor an avatar preload. These are bundle measurements, not measured first-input/paint times or reduced total avatar download size.

The 29 new runtime/startup tests cover ordering, Core failure preventing import, pre-abort, canceled consumers, shared requests, timeout, invalid Core, retry, old callbacks, late import rejection, same-turn abort and undefined rejection/throw. An independent read-only code review ran those 29 tests and found no required repair. Existing avatar lifecycle/render/actor tests remain part of the full suite; they do not prove every browser/dependency cleanup case.

## Browser checks — loopback mock, no paid calls

Using the existing dev-only mock with a locally encoded 44.1 kHz stereo synthetic tone MP3:

```sh
node scripts/mock-voice-app.mjs /absolute/path/synthetic.mp3 elevenlabs blocked-core
```

`blocked-core` adds a test-only CSP that blocks the external Core script. Observed in the real in-app browser:

- Character failure notice visible; no avatar canvas.
- Settings and voice settings open normally.
- A synthetic message can be submitted and receives the explicitly labelled canned response.
- Clicking replay plays decoded audio: observed `paused=false`, `currentTime=0.341149`, duration `1.149388`, no media error.

This proves a usable text/codec/playback path with a missing character. The sound is a synthetic tone, not ElevenLabs speech or listener-rated voice quality. The mock never loads environment credentials or calls a real LLM/TTS provider.

Restarting with `normal` restored the real Hiyori character from the same official Core URL, with a single canvas (observed 672×682 CSS pixels and 1344×1364 buffer). Input remained editable; no new Core error followed normal loading. Desktop screenshots were captured locally for the handoff. No mobile viewport or physical-phone claim is made.

During mode switching, an HTTP 304 retained the old test document's CSP. A fresh document isolated this test-cache effect from Core availability. The mock now removes conditional-request headers before Vite so mode switches return a fresh document; a subsequent same-path browser load returned to the normal loading state and displayed the character. This affects only the loopback mock, not production headers.

## Deployment

Published the built assets and switched `index.html` last on the existing personal VPS. No backend restart or source/configuration change was needed; old hashed assets, model files, credentials and quota ledgers were preserved. The previous HTML/assets were backed up before publication.

The HTTPS page serves `index-DBoSWb_I.js`; local, server and public-download SHA-256 match the value above. The avatar chunk returns HTTP 200 with a JavaScript content type. Systemd remains active; public health still reports configured `deepseek-flash`, protected access, and MiniMax speech **unconfigured**. No paid TTS activation or real synthesis occurred.

A fresh public-page browser check displayed one real Hiyori canvas, no remaining model-status notice, and no console warnings/errors. The interface was visible while the character was still loading. The experience-code gate was left locked; this release check made no real chat generation request. The desktop release screenshot is `/private/tmp/airi-startup-online-20261002.png` in the local handoff environment, not a redistributed model artifact.
