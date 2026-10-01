# Avatar render budget and mount lifecycle — 2026-10-01

This is an engineering verification record, not a listening-quality, phoneme-alignment or physical-device benchmark. No paid voice-provider activation, real MiniMax synthesis, new LLM call or microphone access was used.

## Production changes

- `src/live2d.ts` creates a non-shared, initially stopped PIXI application and an owned Live2D model with `autoUpdate:false`. The model update runs at NORMAL before application rendering at LOW.
- `src/avatar-rendering.ts` applies 30fps/resolution ≤1.25/no antialiasing only for memory ≤4 GB, cores ≤2 or saving-data hints; other/unknown hints use 60fps/resolution ≤2. WebGPU availability does not grade the WebGL renderer. Delta is finite, positive and at most 100ms.
- Hidden visibility stops only this app and its interaction subscription. Neither `Ticker.shared` nor `Ticker.system` is stopped. Visibility resume resets PIXI's RAF timing. Speech continues independently.
- `src/avatar-mount.ts` owns the model from construction, defers model destruction until initialization settles, handles partial initialization, and preserves the original error while attempting every registered cleanup. App unmount aborts pending mount and refuses late state assignment.
- Shared URL-cache CPU textures are retained, not destroyed by a canceled old model. Renderer-local GPU copies, context entries and disposal listeners are explicitly removed before application destruction. These are distinct ownership claims.
- Container ResizeObserver updates both camera layout and actual renderer buffer, without needing a window resize.

The installed dependency code was checked: pixi-live2d-display 0.4.0 accumulates `model.update` time and performs the Cubism update in `_render`; PIXI 6.5.10 registers application render at LOW, resets timing in Ticker start, and requires maxFPS to be set before minFPS to preserve the 100ms cap. Its default `model.destroy` cannot handle absent internalModel and its renderer texture system retains context references unless renderer-local textures are explicitly cleared.

## Automated checks

259 tests passed, including 9 budget/render-loop tests and 12 mount/resource tests. TypeScript and production build passed. Tests cover invalid hints/deltas, update-before-render ordering, hidden/resume/idempotence, initially hidden state, abort before/during/after promise settlement, partial initialization failure, cleanup exceptions, shared texture preservation and renderer-local texture iteration. These tests use controlled objects and do not establish physical-phone performance.

## Actual browser checks

The browser ran real Cubism/Hiyori and WebGL using the production render-loop helper, with a fixed local synthetic test script. DPR was 1. Measurements are from this browser/session only:

| Mode | Window | model.update / Cubism / prerender | Observed rate | Max dt in window |
| --- | --- | --- | --- | --- |
| 30fps, first sample | 3001.1ms | 89 / 89 / 89 | 29.66fps | 41.7ms |
| 60fps | 3001.6ms | 176 / 176 / 176 | 58.64fps | 24.9ms |
| 30fps, repeat | 3001.6ms | 88 / 88 / 88 | 29.32fps | 41.7ms |

Identical counts are evidence against a second shared-ticker model update in these runs, not evidence for all hardware/browser combinations.

Synthetic visibility hid the loop for 3002.1ms: all three counts changed by zero; app and interaction tickers were false while hidden and true after restoration. The first resumed model delta was 25ms. The real Document remained visible throughout this check; genuine OS/browser background switching was **not** exercised.

Actual local Kokoro playback at the 30fps ceiling produced a 9.225s decoded clip (readyState 4, no media error). It yielded 279 speaking render frames, 100 low-mouth-opening frames, 86 audible-opening emphasis frames, maximum added pitch offset 0.889 degrees, zero low-opening emphasis errors, and zero mouth-override errors. No warning/error console logs were recorded. The whole-run max dt reached the 100ms cap during local inference/loading; the finite clip is not proof of natural emotional voice, semantic stress, or phoneme/viseme timing.

The separate lifecycle page calls production `mountHiyori` directly:

- Immediate cancellation: one initial canvas, zero immediately after abort, late promise rejects AbortError and leaves zero canvas.
- Normal weak-hint mount: one canvas, maxFPS 30, resolution 1.
- Container-only resize: actual canvas height changed from 648 to 360, matching the 360px stage without window resize.
- Controlled race: old initialization is held after actual loading; old scope is canceled; the new production mount uploads its shared texture; only then old initialization settles. Old outcome is AbortError, shared CPU texture remains valid, and GPU context counts are `1 -> 1` for the still-running new renderer.
- Repeated destroy removes the canvas; the actual shared texture reports zero remaining GPU context entries while its shared CPU texture stays valid. No warning/error console logs were recorded in this lifecycle run.

## Boundaries and follow-up

No physical low-end phone, mobile keyboard/touch behavior, OS background switching, cloud-provider audition or multi-turn conversational naturalness was proved. Frame ceilings are policy choices, not speed guarantees. The fixed cache intentionally retains reusable CPU image data. The dependency can still fail inside core construction and can expose an unhandled texture rejection when a moc failure occurs before its texture Promise.all is attached; these dependency-internal edge cases were not fixed or claimed eliminated. Paid voice remains off pending the user's account/voice/budget choice. Phoneme-level lip sync remains future work.
