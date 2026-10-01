# Speech queue and audio-driven avatar verification

Verified on 2026-10-01 against the source changes accompanying this note. This is an engineering check, not a listener study or a naturalness ranking.

## Scope and changes

- Cloud synthesis has one current clip and at most one future clip. A blocked first autoplay cannot generate the remainder of a reply.
- A pause between an already-resolved capacity check and its microtask continuation revokes that permit without dropping the waiting sentence. An already-started request may still finish and incur provider charges.
- Cancel, disposal, replacement and player errors release capacity waits and isolate old runs. A silent cloud clip stops subsequent sentence requests.
- Added speech head motion now follows rises in the measured audio envelope rather than fixed sine waves. It is pitch-only, capped at 0.9 degrees, with a 400 ms cooldown. Low opening, pause/cancel, background gaps and reduced-motion clear it.
- The development preview's zero-audio shadow mirrors real Cubism target clipping before weighted writes and reads the actual model pitch bounds. Unit checks cover thinking/attention fades at both pitch extremes.

## Actual browser check

Development URL: `/airi/scripts/avatar-preview.html`, actual Hiyori model, production performance/speech controllers, default free Kokoro voice. Fixed input:

> 诶，终于来了！今天居然一口气把这段跑通了。
> 先慢一点说也没关系。

The completed, replayable WAV reported a duration of **9.225 seconds**, `readyState=4`, and no media error. The preview recorded:

- 1,132 rendered audio frames; 335 frames with added pitch emphasis above 0.08 degrees.
- Maximum added speech pitch offset: 0.900 degrees.
- 403 low-opening frames (`mouthOpen < 0.06`), with zero added-emphasis mismatches in those frames.
- Zero rendered-mouth override errors and zero captured browser warning/error logs for this run.

Frames are render observations, not phonemes or independently labelled silence. Original Idle motion and facial expressions remain. The WAV download event could not be confirmed by the browser tool; no downloaded waveform analysis is claimed.

## Automated/build checks

- `pnpm test`: **238 passed, 0 failed**. Cloud provider calls are injected mocks, including the pause microtask race and an in-flight lookahead.
- `pnpm build`: passed, including `vue-tsc`; existing bundle-size warning remains.
- Main bundle: `index-BAABVem5.js`, SHA-256 `8430b7e32e8e9f7c87f3ed39e73ea5ce93d467c3bbda35812b8443b5433f6199`.

No real MiniMax synthesis or new paid-provider activation occurred. These checks do not prove human-like listening quality, semantic stress detection, phoneme/viseme alignment, physical-phone performance, or natural multi-turn persona behaviour.
