# International MiniMax preparation and native media regression — 2026-10-06

Status: local, uncommitted source verification against baseline `5f4e13461ba2894e9077f6979fb69618c2430fb5`. No real LLM/TTS request, credential read/upload, paid activation, voice training, SSH, production configuration change or deployment occurred in this batch. The earlier independent change to `deploy/airi-lite.service` was preserved and was not deployed here.

## Regression and build

- `pnpm test`: 400 passed, 0 failed/canceled/skipped.
- `pnpm typecheck` and `pnpm build`: passed. Vite retained its existing large-chunk warning; a build does not establish physical-device performance.
- `git diff --check`, mock server syntax, and the diagnostic page's module syntax: passed.
- Built main JS: `index-mmMmRCzS.js`, SHA-256 `f3128eca3ae3b08fe83009f08deec3666ba369cb23280455905484be9c948252`.
- Diagnostic HTML SHA-256: `9be8130a49e36fd50dd56809718eabc62bfd1fdb042f20f902f6b377350f3723`.

## Region and accounting contracts

`MINIMAX_TTS_REGION=cn|global` selects only the fixed official host. Invalid values, injected mismatched hosts and redirects fail closed. Client requests carry a pinned expected provider and MiniMax region; mismatch returns 409 before quota reservation or upstream fetch. Missing legacy guards mean MiniMax cn. The v2 browser grant distinguishes `minimax:cn`, `minimax:global` and `elevenlabs`; reading a v1 MiniMax grant authorizes only cn and does not write a new grant.

Provider `usage_characters` becomes optional `usage.billableCharacters`; `word_count` is optional reference metadata, not billing. Missing/word-count-only metadata does not create a zero charge or inferred count. Explicit reported zero remains zero. Valid usage is shown for the latest segment only, not a full reply, price or balance. These fields never reset or refund the shared protective UTC-day ledger. Its `2 * text.length` reservation is not an international Chinese-character multiplier.

These are code contracts, not evidence of a successful international API request or the user's international account entitlement. Sources: [official HTTP API](https://platform.minimax.io/docs/api-reference/speech-t2a-http), [official schema](https://platform.minimax.io/docs/api-reference/speech/t2a/api/openapi.json), [official regional key guidance](https://github.com/MiniMax-AI/MiniMax-MCP-JS#quickstart-with-mcp-client). No public international Hanzi multiplier was established in this verification.

## Real browser: region-change confirmation

Chrome on `127.0.0.1:4175/airi/` used the development-only mock with environment-file loading disabled, fake credentials, injected fetch and a temporary quota ledger. The existing 44.1 kHz tone file was supplied solely to start this health/UI fixture; it was **not requested or used to validate MiniMax's 32 kHz audio contract**. Neither audition nor chat was clicked. There were no `mockRequest` entries.

1. The editor displayed MiniMax 国内, an unconfirmed cloud draft, and the separate confirmation button.
2. Saving explicitly confirmed cn on the test origin.
3. The mock was restarted as global and the page intentionally refreshed.
4. The editor displayed MiniMax 国际 and required new confirmation. Actual speech policy showed lightweight browser speech, not automatic international cloud activation.

This proves refreshed-health UI behavior, not the already-open stale-health 409 path. That path is covered by fake-provider unit tests. The final test-origin setting was restored to browser speech through the UI.

Local screenshot: `outputs/airi-global-consent-20261006.png` under the desktop AIRI task directory; it is not a repository asset.

## Real browser: production controller, native media, real Hiyori

Development page: `/airi/scripts/media-playback-preview.html`. It injects two generated 24 kHz, six-second mono PCM tones (bright, soft) into the real speech controller. The controller encodes real WAV sources played by an actual HTMLAudioElement. Hiyori/Cubism was actually mounted through the production avatar module. No model download, TTS request or fabricated media event was used.

Observed:

- Two synthesis calls, two initial six-second sources, then one twelve-second full-cache source: three `loadedmetadata` events total. The full cache remained paused at time zero with mouth/form zero, rather than replaying automatically.
- Maximum reported mouth opening: `0.5887`; the real Hiyori canvas was rendered.
- Full-cache replay and an active seek to eight seconds reused synthesis count 2 and source count 3. Playback recovered at `8.167 / 12` seconds, `playing=true`, `readyState=4`, delivery soft, mouth `0.3818`, form `-0.1747`, with no media error.
- A paused seek to two seconds left `paused=true`, `playing=false`, mouth/form zero. It did not call play or regenerate PCM.
- Continuing from two seconds reported bright; later pausing during actual playback at `8.423 / 12` seconds closed mouth/form with no source replacement or regeneration.
- The fixture's cumulative assertion-failure count stayed zero. Cancel subsequently cleared ready/preparing/playing and mouth state.

In this Chrome run, each active buffered seek emitted one additional native `playing` event; the paused seek emitted none. Therefore the browser evidence does **not** establish active seek recovery without a new `playing` event. The production `seeked` recovery for that allowed browser behavior is separately covered by unit tests. Initial loading/seek generated real `waiting` events, but no stalled remote network was induced.

Local screenshots: `outputs/airi-native-media-playing-20261006.png` and `outputs/airi-native-media-paused-20261006.png` under the desktop task directory, not repository assets.

## Remaining gates

- User-authorized real international API/voice audition, with a region-matched ordinary key and an explicit spending limit or verified API free entitlement.
- Listener acceptance of actual Mandarin speech and expressive delivery; tone playback is not human voice evidence.
- Real provider subtitle timing, PCM-to-character synchronization and phoneme/viseme accuracy. Current mouth motion is waveform-driven, not phoneme-labelled.
- Physical phone/touch/keyboard/performance and real network-stall behavior; local Chrome and unit mocks cannot establish them.
- Component-level asynchronous health/usage cancellation scenarios; pinning and abort checks were inspected, but no Vue-level interaction test exercised all races here.
