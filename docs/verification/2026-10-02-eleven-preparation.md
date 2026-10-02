# Eleven v4 preparation — 2026-10-02

Status: inactive adapter and local-only verification. No account was registered, real TTS API called, credit spent, voice cloned, production configuration changed or service deployed during this verification. This is not a voice-quality acceptance report.

## Regression and build

- Full Node test suite: 315 tests, 315 passed, 0 failed/canceled/skipped.
- TypeScript checking and production build passed. Vite retained its existing large-chunk warning; this does not establish performance on a physical phone.
- Main JS: `index-BOHztXAi.js`, SHA-256 `63beafab8af7b1722b075eae3640a91328cd93cef0c86dfa915fc651ba933813`.
- CSS: `index-CuFZj_8n.css`, SHA-256 `ced709360ce8cd36c844c04b6df7b7dd874cf59473ae133ee81ed0aa845430e4`.
- Source whitespace checks passed. The codec preview is a development page and is not an entry point in the production build.

## Real browser codec and player, synthetic provider

A local encoder generated distinct 440/660 Hz stereo tones at 44.1 kHz. The 18,390-byte MP3 fixture had SHA-256 `fbd4bd61af1627b8b77cf4af98b61b8778a03f432c7a248ea43094100417f560`. It contains no speech. `scripts/mock-voice-app.mjs` injected fake credentials, a fake upstream fetch and fixed character timestamps, used a temporary quota ledger, and listened only on `127.0.0.1:4175`. Vite environment-file loading was disabled.

The actual in-app browser decoder reported:

| Field | Result |
| --- | --- |
| Actual sample rate | 44,100 Hz |
| Decoded mono samples after stereo downmix | 50,688 |
| Duration | 1.1493877551020408 s |
| RMS | 0.07784379471723317 |
| Synthetic character intervals | 4 |

The 1.1-second encoder input is longer after frame-based MP3 decoding. This measurement is not provider synthesis latency or a demonstration of natural speech.

The actual AIRI player played a decoded clip without a media error, assembled three canned clips into a 3.448163-second WAV, and paused mid-playback at 0.268684 seconds (`paused=true`, `ended=false`, media error `null`). Native-player replay/pause did not make another mock-provider request. Six upstream mock fetches were observed across the codec probe, preview and canned conversation. Hiyori was rendered in the application; console warning/error capture was empty before the separate provider-switch exercise. These observations do not validate real-provider alignment, sound quality, or phoneme mouth shapes.

## Confirmation and vendor mismatch

- A legacy saved `cloud` mode without vendor confirmation kept actual playback in lightweight browser mode. The voice editor distinguished an unsaved draft and an explicit potentially chargeable audition.
- An explicit cloud save confirmed ElevenLabs on the test origin. After the local server was restarted as a MiniMax mock, refreshed health selected MiniMax but the stored ElevenLabs confirmation did not apply: the editor showed **当前云端供应商尚未确认**, with actual **轻量浏览器语音**. No new upstream mock fetch appeared during this exercise.
- Vite reconnection refreshed the development application during the restart. Therefore this browser exercise proves the refreshed-health confirmation fallback, **not** the already-open stale-health 409 path.
- Separate server/client tests prove that every client request sends a pinned `expectedProvider`, legacy requests mean MiniMax, and a mismatch returns 409 before quota reservation or provider fetch. The client cancels that response body without decoding/retrying and exposes a fixed `provider_changed` message.
- The codec probe refused the MiniMax mock before requesting speech, displaying **不是 ElevenLabs loopback mock，拒绝请求音频**.
- Storage-failure review confirmed that applying settings first cancels speech and clears in-memory cloud consent; a write failure leaves this page using browser speech. Multi-key localStorage writes are not atomic across reloads, and the UI explicitly asks users to recheck after refresh.

## Remaining acceptance gates

1. User selects an account, authorized Mandarin voice and spending limit. Keep `ELEVENLABS_TTS_ENABLED=0` until approved.
2. Audition actual short Chinese lines with neutral, bright and curious delivery; compare youthful conversational delivery, pronunciation, voice consistency and response time.
3. Validate actual provider MP3 framing, normalized character alignment and decoded timing. Character timestamps are not phonemes/visemes; current mouth motion remains driven by the decoded waveform.
4. Confirm applicable account/voice license and attribution before public or commercial use. Free-plan availability does not by itself grant production/commercial permission.
5. Validate real network failure/cancel behavior and physical mobile playback/performance. Local mocks and CSS viewports do not establish these results.

The adapter supports fixed `eleven_v4` Text to Dialogue HTTP, not v4 Turbo WebSocket/full-duplex streaming. Neutralizing literal square-bracket tag syntax does not prove that arbitrary text cannot influence generative delivery.
