# Speech flow — 2026-10-03

Baseline: `8394f70`. No new LLM requests, paid speech calls, account activation, credential/configuration changes or model training occurred in this change.

## Two reproducible boundaries

1. Repeating an identical explicit delivery cue inside a forming clause previously flushed that clause. Real-time output could therefore contain two speech inputs while saved-reply normalization produced one. `SpeechSentenceStream` now compares the latest requested delivery, including keycap-delayed callbacks. Genuine changes still cut at the old-tone boundary; reverting a deferred change does not apply a stale tone or cut an unchanged-tone clause.
2. Every accepted PCM clip previously restarted `audio.src` / `load()` / `play()`, even when multiple same-tone successors were already queued. Playback now joins only already-ready consecutive same-tone clips, with at most three clips and at most 12 seconds when appending clips. It never waits for a future clip or changes synthesis inputs. This limit does not constrain an original long single clip or complete-reply replay.

All generated samples and real pauses are retained, without crossfade, silence trimming, normalization or playback gain changes. Joined sources use the original calibrated mouth frames with exact sample-count time offsets; complete-reply chunks and replay timelines remain unchanged. A genuine delivery change starts a separate source. Cloud synthesis still permits only one lookahead while the current source has actually started and is not paused; joining does not expand this paid capacity.

This removes eligible source restart boundaries. It does not give Kokoro cross-sentence acoustic context: the installed library's `stream()` also splits sentences internally. No millisecond pause reduction or listener-rated naturalness improvement is claimed.

## Automated and independent checks

- Full `pnpm test`: **373 passed, 0 failed**. `pnpm build`: successful TypeScript and Vite build; existing optional Live2D/Kokoro chunk-size warning remains.
- Duplicate-cue regression covers local, injected-cloud and browser-system TTS inputs; implicit first delivery and deferred keycap replacements/reversions are covered separately.
- Playback tests compare every encoded PCM sample, preserve silent joins, use quiet/loud clips with non-25-ms-aligned lengths, and check per-clip mouth tracks, backward seeking and replay without synthesis.
- Join tests stop at three clips, 12 seconds or a tone change. Pause/cancel, closed mouths, delayed `playing` events and canceled runs' late media events are checked. Cloud pause and lookahead request-count protections remain covered.
- Independent read-only review: **45/45** targeted tests and `git diff --check` passed; no new must-fix defect identified. These fixtures are not a real cloud/provider audition or physical-device performance study.

## Current real-browser check: partial, not a pass

The dev-only `/airi/scripts/speech-preview.html` now exposes same-tone fixed Chinese text, visible playback/source/mouth counters and pause/resume controls. Its first-clip auto-pause is explicitly labelled as a fixture to let free local generation proceed; it must not be treated as a natural streaming-delay measurement.

Real Hiyori loaded. Free local Kokoro produced a decoded/ready first source with **4.900 s** duration, readyState 4 and no media error. This is not proof of audible playback. The fixture repeated a neutral delivery marker within its first clause. The model loaded once; repeated control clicks did not trigger a second model load. Pause and stop closed the reported mouth, and stop cleared the source/audio-ready state.

However, in this run, both the visible resume control and native player triggered `playing` while `audio.currentTime` stayed at **0**. No captured warning/error logs explained this. An earlier attempt was interrupted by a Vite connection-loss/reload; the fresh attempt still showed the stationary clock. Source successors, completed playback, replay, audible output and rendered mouth synchronization therefore remain **unverified in this run**. The media download helper also timed out; no new downloaded waveform is claimed. Prior successful Chinese playback evidence is in the separate 2026-10-02 mouth record and is not substituted for a current pass.

Local evidence screenshot: `/private/tmp/airi-speech-flow-clock-20261003.png`. Its counter label predates the final review's wording correction: the preview now says `playing 事件次数`, because these events do not prove media-clock progress or audible output. The temporary browser tab and the loopback dev server were closed after the check. No OS/browser audio settings were changed.

## Release

**Later continuation:** a fresh no-auto-pause run subsequently completed all three clips and its complete WAV. The initial short observations therefore do not establish a persistent media-clock fault. That run also reported a full-source `playing` event without an agent replay click; its cause remains unknown. Explicit source-pause protection, local compute backpressure, a fixture without automatic pause, and successful later real playback are recorded in [the follow-up verification](2026-10-03-local-backpressure.md). The partial check above is retained as historical evidence, not the latest playback result.

Built entry: `index-CaRODWE7.js`, SHA-256 `690cbcde7e3b60f426691e2c5deb958aa2d2106ad384c37cb2211ae41a3f1819`.

Published to the existing personal VPS with a recoverable static backup at `/opt/airi-lite/backups/20261003-speech-flow-before.tar.gz`. New hashed assets were uploaded first; HTML was switched last through an atomic rename. Old assets and models were retained. No backend restart was needed; credential-file size, modification time and mode were unchanged, and no budget ledger was modified by the release.

Local build, VPS entry and public HTTPS entry all have the SHA-256 above; public HTML references the new entry. Systemd remains active. Public health still reports configured `deepseek-flash`, access-protected chat, and MiniMax speech **unconfigured** (`speech-2.8-turbo`). A fresh public browser page loaded real Hiyori, with no loading/failure notice remaining and no captured warning/error logs. The experience-code gate was not unlocked, so this verifies release availability and character startup, not production chat or TTS playback.

Public release screenshot: `/private/tmp/airi-speech-flow-online-20261003.png`. The temporary public browser tab was closed.

The broader goal remains active: expressive-provider listening comparison, human-labelled dialogue quality, phoneme alignment and physical-phone tests are still outstanding.
