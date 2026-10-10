# Speech start and playback-clock liveness — 2026-10-07

Status: local, uncommitted source against baseline `5f4e13461ba2894e9077f6979fb69618c2430fb5`. Earlier batches and the independent service-file change were preserved. No commit, push, SSH, deployment, paid activation, voice training or real LLM/TTS request was made. Credentials were not displayed, edited or uploaded. The diagnostic server uses `envDir: false`, fake configuration, a temporary ledger and disabled provider speech.

The previous implementation turn made source/test progress. This continuation integrates the prepared clock helper, completes its controller regression coverage and gathers browser evidence. The full user humanization objective remains active and unproven; this is not a completion report.

## Implemented contracts

### Unconfirmed native speech start

- Production browser speech now has a 15,000 ms policy deadline while waiting for its first native `start` event. A genuine start clears that timer, including before a subsequent pause/resume. There is no maximum speaking-duration timer.
- Start, end, error, synchronous failure, cancellation and disposal retire deadline ownership. An already-queued old deadline cannot cancel or alter a replacement turn.
- If the engine emits no start/end/error, the controller stops waiting, attempts native cancellation, closes mouth/form and reports a specific problem. It does not assume success, submit the next sentence, retry a paid request or load Kokoro in lightweight mode.
- Ownership is revoked before native cancellation, which may synchronously dispatch old events. Run checks between cleanup callbacks prevent those callbacks from overwriting a synchronously started replacement.
- The warning says the app has stopped **waiting**, not that audible system speech is guaranteed to have stopped. Native cancel itself can fail; audibility is not observable here.

### Playable source with a stationary media clock

`playback-clock.ts` is an observation guard, not a player or sound detector. With continuously observed timestamps, 1,500 ms without forward `currentTime` progress yields `stalled`. An observation gap over 750 ms, backwards time or invalid data resets its baseline. Extremely sparse/background observation cannot establish a continuous stall.

The controller closes mouth/form, sets playing false and preparation true at a newly observed stall, but retains one observation RAF on the current source. Local/cloud capacity is revoked before callbacks: an already in-flight result may finish, but no new work starts under stalled permission. Only subsequent observed forward media progress restores speaking and wakes the original producer. Duplicate native playing events and fresh baselines alone do not restore it.

Every scheduled mouth RAF captures run, source URL and an observation revision. This matters both for new turns and for chunk/full-cache replacement within one turn. Already-queued callbacks retired by pause, waiting, seek, replacement, cancel or disposal cannot observe a newer source, write its state or schedule a second loop. Callback reentry is checked after each mouth, delivery, preparation and speaking update.

Independent review also reproduced an ended-event edge: a cleanup callback could restart the same source while run/source/session identities stayed unchanged, then the old ended handler incorrectly advanced to the next clip. Rechecking `audio.ended` after cleanup fixes this. Regression tests cover same-source restart from mouth/playing/preparing callbacks and subsequent genuine advancement.

These changes never reload, replay or resynthesize audio just to recover a clock stall. A progressing but acoustically silent waveform, muted output device or quiet speaker is outside this guard.

## Offline and production-build evidence

- `node --test src/speech.test.mjs src/playback-clock.test.mjs`: **91 passed**, zero failed/canceled/skipped.
- `pnpm test`: **487 passed**, zero failed/canceled/skipped.
- `pnpm build`: Vue/TypeScript check and production build passed. The existing large-chunk warning remains.
- The main production JS is `index-Cz3xkNhE.js`, 147.38 kB before gzip / 56.68 kB gzip. Live2D remains 617.89 kB, Kokoro 2.19 MB and its WASM 26.86 MB. This batch does not remove model downloads or prove memory/power gains.
- Independent read-only review found the same-source ended reentry described above. The reviewer then verified the fix and its three callback cases; no remaining blocking issue was found in the reviewed scope.

The native deadline matrix includes direct browser, local fallback and injected-cloud fallback through stream/replay; genuine start, synchronous completion/failure, old queued timers/events, native cancellation failure, cleanup reentry, synchronous scheduler expiration and scheduler exceptions. Clock tests include real elapsed-time thresholds at 60/30/10/2 FPS, 100 ms time quantization, gaps, back-seeks and invalid observations.

Controller tests use explicit RAF timestamps. They verify closed UI at the boundary, no repeated stationary writes, event-free advancement recovery, no recovery from a long-gap baseline, local/cloud backpressure without skipped sentences, accepted in-flight local output, reset/retirement and same/new-run stale-RAF isolation. These injected failures are deterministic offline tests, not proof that the user's OS has a persistent native-audio fault.

SHA-256 snapshot:

```text
25d619695601c10bdd72cc7085abdaae6ba9e8fbd91e39a4a49104bf7e759070  src/speech.ts
0ca1e622ece1729b31ee2cc142c1bdf976219304a47a6f6f2e6c4b5a8acd218f  src/playback-clock.ts
a82062e03db5f4a74b462293173afd326b31bec50ee42c5c2f6accdce577c189  src/speech.test.mjs
209c715cc47ce9a47760a1b001d8013d8a4c307a2c87990b3ebe621a137633a9  src/playback-clock.test.mjs
6dca8331804070a3e0ab47bef2ef23da6e3b17d224c595e0aa2076a77fe00f3a  scripts/speech-liveness-preview.html
0c72ae6b2c395ba00aa6238812021b2f029ce3bb368776de8a26bc0a6c391d76  dist/assets/index-Cz3xkNhE.js
```

## Actual Chrome: default start deadline with a labelled no-event stub

Loopback service: `node scripts/mock-voice-app.mjs --no-speech elevenlabs normal`, listening only on `127.0.0.1:4175`. The diagnostic page is `/airi/scripts/speech-liveness-preview.html`, not a production entrypoint.

The user-gesture button temporarily swallows only this page's SpeechSynthesis speak/cancel calls, without fabricating native start/end/error events or invoking a real system voice. The production deadline scheduler is not overridden. Page cleanup disposes the controller while still isolated, then restores the original methods.

Observed in Chrome:

- Initial waiting: one stub speak, preparation true, playing false, mouth/form zero; no PCM/model/project-API call.
- Production `speak` promise settled at **15,006.0 ms**. The default cutoff callback attempted cancel at 15,005.5 ms.
- Final state: preparation/playing false, mouth/form zero, audioReady false, the specific stop-waiting warning, and only one submitted sentence. Stub cancel count 2 includes initial controller reset and cutoff cleanup.
- All five page assertions passed. No warning/error console entry was captured for this page in the checked run.

Screenshot under the desktop AIRI task directory: `outputs/airi-speech-start-deadline-20261007.png`. After this observation, only the optional PCM seek-button wording was clarified from “不播放” to “不调用 play”; the deadline script was unchanged. The optional PCM region on this new page was **not** exercised; normal HTMLAudio regression used the separate page below.

This proves the labelled no-event fixture's default deadline in a real browser timer/UI path. It does not demonstrate that a real system engine emitted no events, nor prove actual speaker silence.

## Actual Chrome: HTMLAudio and production Hiyori regression

`/airi/scripts/media-playback-preview.html` generated two six-second 24 kHz PCM tones and used the production controller, native HTMLAudioElement and actual Hiyori mount. The visible cloud state describes injected PCM, not a provider request. No fabricated media events were dispatched.

1. Both sources played, bright then soft, and a 12-second complete-cache source loaded at time zero while paused and closed. Synthesis count remained 2; loadedmetadata count was 3.
2. During full-cache replay, a native seek to eight seconds observed `8.180 / 12.000`, readyState 4, playing true, soft delivery, mouth 0.2292 / form -0.0961. Maximum mouth opening was 0.5887. The screenshot captures a slightly later waveform frame, which may be closed between pulses.
3. While playing the same complete-cache source, economy changed the existing Hiyori backing canvas from 754 × 840 to 377 × 420, with a 30fps ceiling / 1x resolution. Created-context antialiasing remained true. Same-canvas and unchanged playback-intent/time checks passed; no resynthesis or source load occurred.
4. That replay naturally ended before the subsequent pause-button action. A paused backward seek to two seconds remained closed, did not resume audio, and retained the same cache. Restoring auto returned the backing canvas to 754 × 840 / 60fps ceiling without starting audio.
5. Explicit continue then observed `2.186 / 12.000`, playing true and bright delivery. A later actual pause at **7.190 / 12.000**, ended false, left playing/preparation false and mouth/form zero. Synthesis count stayed 2 and source count 3.
6. Cumulative media-page assertion failures remained zero. No warning/error console entry was captured in the checked run. Cancel-and-clear left no source, no ready/preparing/playing state and mouth/form zero.

Desktop screenshots: `outputs/airi-speech-liveness-playing-20261007.png` and `outputs/airi-speech-liveness-paused-20261007.png`. These are local artifacts, not repository model assets. No explicit viewport override or physical-phone test was used. Same canvas identity and buffer dimensions are not measured FPS or continuous glitch-free sound.

## Full-goal audit / remaining work

- Natural expressive voice: **not established**. The new browser deadline uses a deliberately silent stub; PCM tones only test media control. Real Mandarin provider audition and listener acceptance remain necessary, subject to explicit budget/free API entitlement and region-matched server-only credentials.
- Concise, non-assistant-like character dialogue: **not established by this batch**. No persona change or real LLM request was made. The previous small dialogue comparison did not justify more catchphrases/prohibitions; quality still needs conversation evidence and human judgment.
- Different device performance: render policy and same-cache switching have evidence, but physical-phone behavior, thermals, frame rate, power and memory are **not verified** here.
- API/custom voice option: adapters exist; this batch neither activated a paid service nor trained/cloned a voice. Consumer web gifts are not assumed to be API quota.
- Expression/mouth correspondence: waveform-driven mouth, played tone and interruption control improved. **Exact phoneme/viseme alignment and human articulation remain unverified**.

The goal remains active. None of the 487 passing tests substitutes for these perceptual/provider/device gates.
