# Timestamp-constrained speech beats — 2026-10-10

This is a bounded implementation and playback verification record, not a
human-likeness score. Source changes do not mean the live demo is deployed.

## Behavior and limits

- Provider word intervals take precedence over character intervals. Actual
  readable text coverage constrains measured peaks in the existing 40 Hz audio
  opening envelope. Words are not divided into guessed character timings.
- Punctuation, spaces, zero-duration intervals, weak opening and uncovered gaps
  do not generate beats. Peaks are separated by at least 650 ms, including
  accepted clip boundaries. The bounded pitch gesture remains at most 0.9°.
- Missing alignment retains the earlier measured-rise fallback. Known
  alignment with no qualifying event has a zero track and suppresses that
  fallback. Provider availability must survive adapter normalization; dropping
  a zero-duration item must not turn supplied metadata into invented timing.
- Queue batches and complete replay carry the same clip-relative event tracks
  and offsets as mouth tracks. Media-time lookup is stateless, including a
  backward seek. Historical Float32 audio is not added to the cache.
- Mouth and beat updates share the current-source callback and ownership
  guards. Pause, stalled clock and cancellation stop their motion. Reduced
  motion and low opening suppress added pitch. Browser speech has no measured
  envelope and does not invent these beats.

Text alignment is not phoneme alignment or semantic stress. The mouth remains
an amplitude/spectrum approximation. Timestamp-constrained motion cannot by
itself establish that speech or the character looks natural.

## Offline and browser evidence

`pnpm test` passed **513 tests**, with zero failures, skips or cancellations.
`pnpm build` passed typechecking and the production build; the existing large
Live2D/Kokoro chunk warning remains. No dependency was added. The development
diagnostic labels/module were absent from the emitted app/Live2D bundles.

Two targeted, read-only Sol reviews found no actionable defect in the final
production delta. The second checked the factual MiniMax availability marker
after the parent requested a bounded repair:

- `wordAlignmentAvailable: true` is emitted only for accepted provider word
  arrays in retained subtitle segments, including empty/all-zero arrays.
- The client validates a present marker as true-only before codec allocation.
  An unmarked legacy `words: []` remains missing; a marked empty array remains
  available without inventing a playback interval. Missing character metadata
  stays absent through the ElevenLabs adapter and decoder; an explicit empty
  array remains available.
- A regression traverses the real MiniMax collector, client decoder and speech
  controller, including complete replay and backward media-time lookup with
  strong injected audio opening. Its fake MPEG bytes and codec/PCM are not
  evidence of a real provider or codec.

Actual Chrome verification used the fixture below and real Hiyori. Initial
two-clip playback made exactly two synthetic generation calls, then loaded
the 12-second full cache paused: 1,447 callback/time-track matches and zero
cumulative assertion failures. Real Cubism's maximum added pitch was 0.900°;
bounds, low-opening/silence, reduced-motion and closed-mouth error counters
were all zero at the initial observation.

Full-cache replay and native forward/backward seeks retained two generation
calls and the same third audio source. An active playback was manually paused:
mouth/form became zero, beat became null, and speaking became false. A paused
seek to 2 seconds did not start playback. Economy mode changed the existing
canvas to a 30fps ceiling without pausing/reloading/rewinding the audio. Its
complete replay reached 3,632 callback/time-track matches without a failure,
while the real Cubism error counters remained zero.

An additional complete-cache replay with fixture reduced motion enabled
reached **5,073** callback/time-track matches and zero assertion failures.
At that observation the diagnostic counted 2,672 reduced-motion frames;
current added pitch stayed suppressed and all four Cubism error counters
remained zero. The system preference was false: this proves the injected
suppression path, not the operating system setting on another device.

A new run without injected alignment retained null beats and the earlier
fallback, generated exactly two clips, and completed the same paused cache
without assertion or Cubism errors. Canceling then cleared audio availability,
preparation, speaking, mouth/form and the beat. Browser warn/error logs were
empty. The saved aligned-run screenshot retains the cumulative counters and
the real character; a static screenshot cannot demonstrate perceived motion.

Positive grouped-clip offsets have pure-track tests and a reviewed controller
mapping. The native cloud fixture does not force multiple ready cloud clips:
the existing paid-lookahead cap deliberately permits only one queued clip.
It therefore must not be presented as real positive cloud-batching evidence.

The development-only `/airi/scripts/media-playback-preview.html` uses the
production speech controller and native HTMLAudioElement, with two generated
6-second modulated PCM tones and hand-authored nonuniform character intervals.
It performs no model/TTS API request and does not load environment credentials.
Its optional Hiyori view uses the production actor and render budget with the
real Cubism model. A same-frame zero-audio pitch shadow isolates the added
gesture; another shadow records the earlier unaligned fallback. Neither is a
second rendered character or a listener-rating baseline.

The fixture's reduced-motion checkbox adds suppression without changing the
operating-system preference. It is not proof of physical-device preference
behavior. These development diagnostic modules are not imported by the app.

## Remaining full-goal gates

- Authorized real-provider Chinese synthesis and listening/viewing comparison
  against the previous playback, including genuine provider timestamps,
  voice consistency, latency and emotional delivery.
- Human review of multi-turn conversation: concise replies, grounded playful
  reactions, consistent preferences, and reduced assistant-style advice.
- Physical low-performance/mobile-device playback and input-method checks.
- Phoneme/viseme-level timing if an appropriate model and alignment source
  become available; current text timestamps are not a substitute.

No real provider call, key transfer, paid voice creation/training or deployment
is part of this verification. The overall companion goal remains active.
