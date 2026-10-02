# Local speech backpressure and replay intent — 2026-10-03

Baseline: `2ddabc0`. No LLM requests, real cloud synthesis, account activation, training, new credentials or quota changes were used in this iteration. Real browser checks used the existing free local Kokoro model and Hiyori.

## Evidence driving the change

The initial short no-auto-pause observations showed the first source at 0.042667 s, but the later screenshot/DOM state showed all three sources and the complete 10 s waveform had finished. A persistent media-clock fault is therefore **not established**. That baseline run recorded a fourth `playing` event for the full waveform without an agent replay click; its cause is not established either. Source replacement now explicitly pauses before revoke/src/load, and only advancing a real next clip explicitly calls `play()`.

Separately, a pure blocked-player fixture reproduced unbounded local computation: one model input yielded forty five-second PCM clips while the first player's `play()` rejected. This was a local scheduling problem, not a listening-quality or phone-speed measurement.

## Changes and limits

- Local generation captures its original session/token and checks capacity **before every model iterator step**, not just before each sentence. It rechecks after awaiting a permit, retaining the exact input if a pause revokes that permit.
- At most three ready lookahead clips are retained. Further steps require an actually-started current source that is not paused/ended; an empty queue with no current clip may produce the first/underrun clip.
- An already-running model step can finish. Pause does not hard-interrupt the underlying inference; cancel/new-turn tokens discard late results. Cancel, dispose and media errors wake the original local waiter and close its iterator. Cloud capacity remains independently limited to its existing one lookahead.
- Complete replay samples still accumulate as audio is accepted. Three clips is **not** a total memory/byte/duration cap, and the model weights, individual clip length and played-reply cache are not reduced by it. PCM validation, mouth analysis and inference are not moved off the main thread in this change.
- Source replacement pauses explicitly, including complete-WAV preparation. The next current clip is still played by `advance()`; manual replay remains available without re-synthesis.
- The preview no longer auto-pauses to fill a queue, which would conflict with the new pause behavior. It distinguishes code `play()` requests from `playing` events; seeking can add the latter without the former.

This reduces unnecessary local work during a blocked/paused long reply. It does not train emotional prosody, remove generated pauses, provide phoneme alignment or prove low-end-phone frame rate.

## Deterministic blocked-player comparison

One input, forty possible five-second clips, 24 kHz Float32 mono, first playback rejected; observe counters from the first real timer task, then cancel. The baseline source is loaded from Git `2ddabc0` and compared with the changed controller using the same fixture.

| Counter | Baseline | Changed controller |
| --- | ---: | ---: |
| Model steps producing PCM | 40 | 1 |
| Corresponding generated audio | 200 s | 5 s |
| Raw accepted PCM payload | 18.3105 MiB | 0.4578 MiB |
| Additional steps after cancellation | 0 | 0 |
| Iterator closed | yes | yes |

PCM payload is calculated from sample count, **not process resident-memory measurement**. No real model inference or provider call occurred in this comparison. Reproducer retained locally: `/private/tmp/airi-local-lookahead-diagnostic-20261003.mjs`. The checked-in regression covers the blocked forty-output generator and cancellation; another nine-output fixture verifies a real timer runs after current + three ready clips, resume cannot overfill, and playback drains the remaining exact outputs.

## Real Chinese browser checks

Dev-only `/airi/scripts/speech-preview.html`; real production controller, local Kokoro and Hiyori. One model load across both inputs. No captured warning/error logs or media error were reported.

### Three different deliveries

Fixed bright / soft / curious inputs produced **2.725 s**, **3.975 s**, **3.300 s** sources. Three code `play()` requests and three `playing` events corresponded to the three source advances. The complete **10.000 s** WAV then loaded **paused at 0**, without a fourth playback event or code request. The reported mouth was closed; its observed maximum during original playback was 0.870.

An explicit replay click added the fourth code request, reused the same four loaded sources and reached **10.000 s** paused. Actual replay delivery observations changed to soft around 2.74 s and curious around 6.75 s. Native progress controls and a second replay were also exercised; seeking generated an additional `playing` event without another code `play()` request, as labelled.

Screenshots: `/private/tmp/airi-local-lookahead-three-tones-20261003.png`, `/private/tmp/airi-local-lookahead-replay-20261003.png`.

### Same-tone streaming, replay and mid-play pause

Fixed neutral text contained three clauses and a duplicate neutral cue within the first clause. The first source lasted **4.900 s**; the remaining two already-ready clips shared a **5.950 s** source. Original playback therefore used **two** code requests/events. A complete **10.850 s** WAV was prepared paused at 0 with no extra playback request. This verifies an actual eligible join, not a guarantee that every streaming reply has its successors ready in time.

Manual replay reused the same three loaded sources. Native progress controls advanced into the waveform; the visible pause button stopped it at **5.58 / 10.850 s**, with reported mouth opening **0.000**. Returning to the beginning while paused retained a closed mouth. Resuming reached **10.850 s**, `ended=true`, `paused=true`, readyState 4, without another source load or model load. Stop then cleared audio-ready/src state. Mouth maximum across the original and later replay observations was 0.962; these are speech-controller callback observations, not independently verified rendered parameter values, labelled phonemes or a listening score.

Screenshots: `/private/tmp/airi-local-lookahead-same-tone-20261003.png`, `/private/tmp/airi-local-lookahead-pause-20261003.png`, `/private/tmp/airi-local-lookahead-finished-20261003.png`.

The temporary tab and loopback dev server were closed. No OS/browser audio settings were changed. No new waveform download is claimed. These fixed-line desktop checks do not establish emotional naturalness, phone compatibility or indistinguishability from a human performer.

## Regression and review

- `pnpm test`: **380 passed, 0 failed**. TypeScript/Vite build successful; the existing optional avatar/Kokoro chunk-size warning remains.
- Seven new regression cases cover blocked initial local playback, one input with multiple clips, a real-task opportunity at full capacity, in-flight pause, cancel/dispose/error, new-turn waiter isolation, late input underrun, and complete-WAV preparation while an ended source retains playing intent.
- Existing sample-exact PCM, per-clip mouth/replay/seek, sentence cue and cloud fee/capacity checks still pass. The long eager-generation test now starts its promise, drives a real playback ending, then awaits synthesis instead of requiring unlimited lookahead.
- Independent read-only review: **107/107** targeted tests passed. An additional local microtask-permit-revocation fixture preserved the exact input, resumed to current + three ready clips and closed the original iterator on cancellation. No new must-fix defect was found.

## Release

Built entry: `index-BQ-s_feb.js`, SHA-256 `f00206c3fcc3f406343904c1074089fabcfa98cfb0ce13537b9ae76d1a7f8293`.

Published to the existing personal VPS with recoverable static backup `/opt/airi-lite/backups/20261003-local-lookahead-before.tar.gz`. New hashed resources were staged and verified first; HTML was switched last by atomic rename. Old resources/models remained, no backend restart occurred, and credential-file size/mtime/mode were unchanged. No release operation touched quota ledgers.

Local, VPS and public HTTPS entries have the same SHA-256 above, and public HTML references the new entry. Systemd remains active. Public health reports configured `deepseek-flash`, protected chat, and MiniMax speech still **unconfigured** (`speech-2.8-turbo`). A fresh public page loaded Hiyori without a remaining loading/failure notice or captured warning/error logs. The experience-code gate was not unlocked: this release check proves availability/character startup, not production chat, paid speech or provider quality. Temporary release tab closed; screenshot `/private/tmp/airi-local-lookahead-online-20261003.png`.

Expressive-provider audition, human-labelled conversational quality, true phoneme/viseme alignment and physical-phone validation remain outstanding; the broader goal is not marked complete.
