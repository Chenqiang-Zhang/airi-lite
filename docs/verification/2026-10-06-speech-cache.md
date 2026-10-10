# Incremental PCM cache and lightweight speech regression — 2026-10-06

Status: local, uncommitted work against baseline `5f4e13461ba2894e9077f6979fb69618c2430fb5`. This follows the earlier [international preparation/native-media record](2026-10-06-global-media.md); that record's 400-test/build snapshot is intentionally unchanged. No real project LLM/TTS request, paid activation, credential upload, voice training, SSH or deployment occurred here. The pre-existing systemd change remains independent and undeployed.

## Regression and build

- Final `pnpm test`: 423 passed, 0 failed/canceled/skipped.
- Final `pnpm build`: TypeScript and Vite passed; the existing large-chunk warning remains. Main JS `index-DVtnbDU5.js`, SHA-256 `f8f36407356937ab1b8d78f90bc9d2011e537dd9270e3c66f021d9e7cd1d1018`.
- Both diagnostic module scripts passed `node --input-type=module --check`; no preview HTML is present in `dist`.
- `git diff --check`: passed. These checks do not establish physical-phone performance or natural speech.

## Complete long sentences obey the same cap

Previously `SentenceBuffer.push()` extracted punctuation-terminated sentences before enforcing the 180 UTF-16-unit bound. A whole 501-unit sentence emitted one oversized voice input, while different stream packaging could produce bounded inputs. The completed and pending cases now share the bound; a comma at index 180 cannot create a 181-unit output. Valid supplementary characters are not split into lone surrogate halves.

Tests cover whole/split input, 179/180/181 boundaries, Chinese/English comma positions, ordinary prefixes and non-BMP characters. A 501-unit sentence produces `[180, 180, 141]` in both the whole and tested fragmented forms. The cap is an engineering input bound, **not** MiniMax's billing character definition. This does not fix all punctuation/prosody behavior or change learned TTS expressiveness.

## Encode each accepted PCM clip once

`src/audio-wav.ts` preserves the old mono PCM16 clipping/quantization and validates the RIFF uint32 dimensions before writing headers. Each accepted clip keeps an immutable PCM16 Blob snapshot plus its original mouth track. Prepared playback items are constructed explicitly and no longer retain raw historical Float32 PCM through a spread of the input segment.

Single-clip playback, bounded same-delivery ready batches and the complete replay compose the same encoded parts. No samples, pauses, delivery boundaries or per-clip mouth calibration are resampled or trimmed. Completing a reply still prepares the full source while paused; it does not request an automatic replay.

The controller-level allocation regression uses three shaped 44.1 kHz clips totaling 25,313 samples. During the synchronous final `ended` → complete-cache replacement it observes exactly one explicit 44-byte ArrayBuffer and no Float32Array construction. Constructors are restored before asynchronous Blob reading. Every PCM16 sample in the resulting WAV is checked against the original quantization; explicit replay starts no new inference. Helper tests additionally cover real header fields, snapshot mutation, unequal clips/order, silence and uint32 boundaries without allocating a multi-gigabyte fixture.

This removes full-reply JavaScript copying and re-quantization. It is **not** a claim that browser Blob construction is internally zero-copy, a total cache-byte cap, lower measured RSS, OOM safety or physical-phone speed. Encoded replay data and mouth tracks still grow with accepted audio. An independent offline review also checked rejection of a changed second-clip sample rate and matching creation/revocation of Object URLs; these extra review probes were not added as checked-in tests.

## Native HTMLAudioElement and real Hiyori

Chrome used `/airi/scripts/media-playback-preview.html` on loopback with the production speech controller and two generated 24 kHz, six-second PCM tones (bright then soft). These are not human speech. Real Hiyori mounted through the production avatar module; no Kokoro download, project speech API or fabricated media event was used.

Observed in this run:

- Exactly two synthesis calls, two initial sources and one 12-second complete source (`loadedmetadata` count 3). Complete cache initially stayed paused at time zero; mouth/form were zero. Maximum reported opening was `0.5887`.
- Complete-cache replay and an active seek to eight seconds reused synthesis count 2 and source count 3. A real pause at `8.223 / 12` left `playing=false`, mouth/form zero and delivery soft.
- A paused seek to two seconds kept the mouth closed and did not play or synthesize. Continuing from that position reported bright; the callback later changed to soft at `6.002` seconds. Full replay then ended normally at 12 seconds without a media error or re-synthesis.
- The cumulative fixture assertion-failure count stayed zero. Active seeks in this Chrome run emitted an extra native `playing`; the paused seek did not. Recovery without an additional `playing` is covered by unit tests, not established by this browser run.

Screenshot: `outputs/airi-pcm-cache-paused-20261006.png` in the desktop AIRI task directory, not a repository asset. It shows the final paused/ended cache and actual Hiyori. Waveform-based mouth synchronization and native event delivery are separate from actually hearing speech or having phoneme-labelled lips.

## System SpeechSynthesis: pause guards and no-start failure

Browser-mode and local/cloud fallback utterances now handle `pause`/`resume` only after their genuine `start`, while checking the active run, current utterance identity and completion. Pausing closes the approximate mouth and stops speaking state; resuming restores only that utterance's delivery. These events neither complete a sentence nor trigger model/provider retries. Canceled, replaced, completed and failed utterances cannot overwrite the new turn.

An `end` without `start` closes preparing/playing state, stops remaining queued speech and reports: “系统语音未确认开始播放，请更换语音模式或检查浏览器与系统声线。” Resume-before-start cannot fabricate a successful start. Error-before-start keeps its original failure instead of having a late `end` replace it. Unit tests cover direct/browser fallback, streamed/replayed input, cancellation, same-run successor and new-run identity isolation.

The new loopback-only browser diagnostic uses public fixed text and real native events. It rejects project model/cloud dependencies, offers a diagnostic-only Chinese voice selector and restores its native constructor/listeners on page exit. Enumerating a voice does not prove it is installed or able to speak. System voices can use their own network service; this is disclosed on the page.

On this Mac/Chrome, both system default and an explicitly selected local Mandarin voice returned `end` with no observed `start` or `error`. The cause is unknown. After adding the guard, the actual browser showed one utterance, preparing/playing false, mouth zero, model/project cloud calls zero and the new warning; it did not queue the second sentence. Screenshot: `outputs/airi-browser-no-start-20261006.png` in the desktop task directory. No online Google voice was successfully selected or started. **Real native Chinese pause/resume and audible speech therefore remain unverified**, although the guarded event matrix passes offline.

Chrome's current `elapsedTime` implementation is milliseconds rather than the spec's seconds; an observed value near 2.9 is not evidence of 2.9 seconds of spoken audio. Primary references: [native pause](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisUtterance/pause_event), [native resume](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisUtterance/resume_event), [Chromium timing implementation](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/speech/speech_synthesis.cc), [compatibility data](https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/SpeechSynthesisEvent.json).

## Billing rule recheck and remaining gates

The official international HTTP schema was re-read without a key: `extra_info.usage_characters` is the billable count; `word_count` includes punctuation/spaces and is reference-only. No public language-specific multiplier was established. Do not derive international charges from local UTF-16 length or the app's protective quota reservation. Sources: [official API schema](https://platform.minimax.io/docs/api-reference/speech/t2a/api/openapi.json), [international pricing](https://platform.minimax.io/docs/pricing/overview).

Remaining gates: authorized real provider audition and listening acceptance, exact Chinese phoneme/viseme timing, native speech on working system voices and physical phones, real network stalls, and measured device/RSS behavior. A browser engine that sends neither `start`, `end` nor `error` can still leave a pending utterance; no watchdog or automatic cross-provider switch was added. Passing this batch does not complete the overall humanization goal.
