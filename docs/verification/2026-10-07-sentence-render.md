# Streaming sentence suffixes and live render profiles — 2026-10-07

Status: local uncommitted source against baseline `5f4e13461ba2894e9077f6979fb69618c2430fb5`. This batch made no real LLM/TTS request, credential read/upload, paid activation, voice training, SSH or deployment. Existing changes from earlier batches and the independent `deploy/airi-lite.service` change were preserved. The overall humanization goal remains incomplete.

## Regression and build

- `pnpm test`: **453 passed**, zero failed/canceled/skipped. This batch adds 30 tests over the prior 423-test snapshot: 22 text/sentence tests, six render/storage tests and two controller tests.
- `pnpm build`: typecheck and production build passed. The first attempt reached typecheck but Vite's write to the repository's `.vite-temp` was sandbox-denied; the scoped local-build retry succeeded. This was a file permission failure, not a source diagnostic.
- `node --check scripts/mock-voice-app.mjs`, the media diagnostic module's stdin syntax check, and `git diff --check`: passed.
- Independent read-only review: 15 render/storage tests passed and installed PIXI6 setter/resize/interaction behavior matched the implementation. No blocking issue was found; that is not proof of all device behavior.
- Main bundle: `index-B6EocGUq.js`, SHA-256 `55ddb2bd11b597c65347d9068e67ffb10efedc766775d4f04de431dff50aa02f`.
- Media diagnostic HTML SHA-256: `cf3c7a75b477678f94496303107f98dc9c678ed3459c9e2a55d50bee7f422ff5`.
- Sentence buffer SHA-256: `321c8b7e1f67fe6a812a5703daadbff63b4559136e603068ce61d73f7a95b3ba`.
- Render budget module SHA-256: `b82b03992d98b67a953f4d2c3ce92dc20b79470f0783ce92f310dff93f250e2f`.

Vite's existing large-chunk warning remains. The main JS is 145.88 kB before gzip, Live2D 617.89 kB, Kokoro 2.19 MB and its WASM 26.86 MB. This batch does not remove those downloads.

## Streaming speech contract

The sentence buffer keeps adjacent hard punctuation and closing quotes/brackets with their preceding readable body. It carries ASCII quote context across sentences while distinguishing common ASCII contractions. At an unfinished stream edge it observes the next character rather than submitting only the first punctuation mark. A delivery change, newline or finish releases the sentence. No added delay timer, whole-reply wait or ellipsis hard-stop policy was introduced.

Newline is an immediate structural commit. A punctuation-terminated first line is released before a following long silent code fence; closers on a later line are not pulled back across that newline. The 180 UTF-16-unit bound and non-BMP integrity take precedence over keeping an arbitrarily long suffix together. ASCII `!` still waits long enough to distinguish a literal exclamation from Markdown image syntax, with bounded pending delivery ownership.

Controller tests exercise local, injected-cloud and browser paths with character-sized fragments of `“真的吗？！”`. They check the exact synthesis/utterance input, no premature submission and bright-to-soft delivery changes only when the corresponding audio/utterance actually starts. Canceling a held suffix cannot leak old speech or block a fresh newline-committed sentence. The existing cloud-failure test still submits its first newline-terminated sentence before a later code fence.

These are text/controller contracts. A provider's learned intonation may or may not respond to the retained punctuation; real Mandarin listening evidence is still required. First-audio latency can increase by the time until the next character or commit arrives; it is not claimed to be unchanged.

## Render profile contract

`auto` retains the existing device-hint heuristic. Explicit `economy` caps the application's own ticker at 30fps and resolution at 1x. The profile has a separate validated local-storage key and does not alter cloud grants or voice choice. Storage failure returns before changing the current picture. If settings change while the model loads, App reapplies the latest saved profile after mounting.

Live application updates the existing PIXI renderer, its backing buffer and the instance's InteractionManager resolution. It does not start/stop the app, create a new model or replace any media source. A destroyed mount is a no-op; a hidden ticker is not restarted by changing the budget. Antialiasing is reported as the actual context-creation policy, not the newly requested initial policy. This is verified by code/unit evidence and actual canvas resizing below, not a hardware benchmark.

## Actual browser: app settings

Chrome at `127.0.0.1:4175/airi/` used `scripts/mock-voice-app.mjs --no-speech elevenlabs normal`. The mock disables environment-file loading, uses fake chat credentials and a temporary ledger, and leaves both real cloud speech providers unconfigured. No chat or audition was requested.

1. Actual Hiyori loaded. Auto showed a 60fps ceiling and 2.00x resolution; its canvas was 2752 × 2376 backing pixels with 1376 × 1188 CSS dimensions.
2. Saving economy changed the existing displayed canvas dimensions to 1376 × 1188 backing pixels without changing its CSS dimensions.
3. An intentional reload, followed by reopening the editor, showed the saved economy selection and current 30fps / 1.00x report.
4. The test origin was restored to auto through the editor. This is not a production user-setting change.

Screenshot under the desktop AIRI task directory: `outputs/airi-render-economy-20261007.png`. The backdrop blur is the app's existing modal effect, not evidence of low-resolution rendering. These screenshots are local artifacts, not repository assets.

## Actual browser: production controller and real Hiyori

The loopback-only media page generated two six-second 24 kHz PCM tones and used the production speech controller, actual HTMLAudioElement and production Hiyori mount. The visible `cloud` label refers to the injected PCM dependency, not a TTS network call. No fabricated media events were dispatched.

- Two synthesis calls created two six-second sources and one twelve-second complete-cache source: three `loadedmetadata` events. Full-cache preparation remained paused at time zero with mouth/form zero.
- Actual Hiyori auto canvas: 754 × 840 backing pixels, 60fps ceiling, 2x resolution, context antialiasing true.
- During complete-cache playback, economy changed backing dimensions to 377 × 420, 30fps ceiling and 1x resolution. The fixture observed the same canvas, unchanged paused state and no backwards time jump at application. Its later cache assertions retained synthesis count 2 and source count 3 on the same complete-cache source. Created-context antialiasing stayed true.
- An active seek to eight seconds recovered at `8.145 / 12.000`, readyState 4, playing true, delivery soft, mouth 0.5231 and form -0.1711. Maximum reported opening was 0.5887. The screenshot captured a slightly later audio frame; these numbers are from the DOM observation, not frozen playback.
- Pausing later left mouth/form zero. Switching back to auto restored 754 × 840 backing dimensions while retaining the paused cached source, synthesis count 2 and source count 3. Delayed cache checks also passed; cumulative fixture failures remained zero.
- After the controlled replay had ended, the trace contained an additional native play/seek sequence without a fixture replay-button note before the later pause. Its origin was not established in this run. It did not synthesize/reload audio and does not invalidate the earlier switch checks, but this trace cannot prove that no other playback interaction occurred.

Screenshots under the desktop task directory: `outputs/airi-render-cache-playing-20261007.png` and `outputs/airi-render-cache-paused-20261007.png`.

The same-canvas assertion directly proves canvas identity, not model identity by itself; the no-model-construction code path and actual rendered character provide additional evidence. Snapshot audio state and cache checks do not establish continuously glitch-free sound. These tones are not human speech, and mouth movement remains waveform-driven rather than phoneme-labelled.

## Remaining gates

- User-authorized API audition with an explicit spending limit or verified API free entitlement; ordinary region-matched keys remain server-only.
- Listener acceptance of youthful Mandarin delivery, natural sentence flow and conversationally short replies. This batch made no persona/LLM change or quality claim.
- Provider subtitle timing and phoneme/viseme correspondence; waveform calibration and hidden delivery cues are not exact articulation.
- Physical-phone keyboard/touch, performance, thermal behavior and actual power/memory measurements.
- Vue component-level delayed-mount/storage-failure interaction tests and sustained native-audio continuity measurements.

No completion claim is made for the full humanization objective.
