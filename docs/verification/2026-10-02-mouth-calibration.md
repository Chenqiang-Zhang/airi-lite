# Per-clip mouth calibration — 2026-10-02

Baseline: `e7e8fd7`. This improves measured-audio mouth movement, not the TTS voice's expressive quality or human-rated naturalness. No real cloud synthesis, account signup, or paid-provider activation occurred.

## Changes

- Replace fixed `RMS * 5` jaw gain with a bounded, per-clip gain. A robust three-frame median anchor keeps a long faint tail from outvoting a short spoken region; the upper percentile of the eligible population avoids calibration by a single click. Within-clip level changes remain.
- Keep a near-zero floor and a relative amplitude gate. Silent release closes the jaw in approximately two 25 ms frames for usual calibrated levels (up to three frames from the maximum opening). Pausing/canceling still close immediately through the speech controller.
- Compute each 40 Hz frame boundary from its absolute audio time instead of accumulating `floor(sampleRate / 40)`. A 180-second 44.1 kHz regression checks the actual last-frame onset, not just array length.
- Analyze each accepted clip once. Its saved frames and exact duration are reused for original playback, combined-WAV replay and backward/forward seeking. The concatenated WAV is not globally re-calibrated.
- Read `audio.currentTime`, binary-search the saved clip intervals, and use a local frame index. Clip endings/gaps return a closed mouth; floating-point boundary tolerance is far below a media-clock tick.

Original Float32 samples remain read-only. Encoded PCM and playback gain are unchanged. Browser-system TTS still has no accessible waveform and uses the existing simpler animation.

This is not VAD: a continuous weak sound cannot be reliably identified as speech versus noise from RMS alone. Sustained strong noise can affect the anchor; extreme within-clip dynamic range can gate very weak fragments. Mouth form is a restrained spectral heuristic, not Chinese phoneme/viseme labels.

## Real local Chinese speech

Development URL: `/airi/scripts/avatar-preview.html`; real Hiyori/Cubism renderer and production speech/performance controllers, free local Kokoro. Fixed non-private input:

> 诶，终于来了！今天居然一口气把这段跑通了。
> 先慢一点说也没关系。

Original playback completed and the complete WAV was replayed using the actual player's play control. Player duration: **9.225 seconds**, readyState 4, no media error. Captured render observations:

| Observation | Original run | After full replay |
| --- | ---: | ---: |
| Rendered audio frames | 552 | 1,096 |
| Low-opening frames, mouth < 0.06 | 217 | 425 |
| Added-emphasis frames > 0.08 degrees | 141 | 321 |
| Maximum added speech pitch offset | 0.900 degrees | 0.900 degrees |
| Added-emphasis mismatches at low opening | 0 | 0 |
| Rendered-mouth override errors | 0 | 0 |

Render counts depend on actual frame scheduling and are not expected to double exactly. No captured warning/error logs were returned for the run. Neither counts nor screenshots are independently labelled silence/phonemes or a naturalness study.

The browser download call timed out, but the actual file was subsequently verified on disk with the same UUID as the page's combined blob URL. The newly saved file was 442,844 bytes, **24,000 Hz mono 16-bit PCM**, containing 221,400 samples. SHA-256:

`737ce1e3f47893393abcb02374b0f1dbc6781dfd293e3cabb94ab35d0d37ee4d`

Local handoff copy: `/private/tmp/airi-kokoro-mouth-20261002.wav`. This is a real synthesized Chinese waveform, not either pre-existing synthetic MP3 tone fixture. It is not committed to the public repository.

## Same-waveform level diagnostic

Decode the saved PCM into Float32 samples and analyze copies at 0.25×, 1× and 4× gain; do not change the saved WAV or playback. This re-analyzes the combined waveform only as a numerical diagnostic; production replay uses each original clip's saved track.

| Input amplitude multiplier | Previous mean jaw opening | New mean jaw opening |
| --- | ---: | ---: |
| 0.25 | 0.057377 | 0.251080 |
| 1 | 0.230450 | 0.251080 |
| 4 | 0.547927 | 0.251080 |

New jaw and form maximum differences across all three copies were 0 in this calculation. All copies produced 369 frames, maximum opening 0.775192 and 126 exactly closed frames. Twenty warmed Node analyses per copy on this desktop had medians 0.42–0.57 ms. This is not a browser or phone benchmark, nor proof of equivalent behavior below the absolute floor/gain cap or for every recording.

## Automated verification

- `pnpm test`: **356 passed, 0 failed**. `pnpm build`: TypeScript and Vite successful; existing large avatar/Kokoro chunk warning remains.
- Unit checks: common sample rates 8/22.05/24/32/44.1/48/96 kHz, a late 44.1 kHz onset, fractional final frames, near-zero/non-finite inputs, amplitude invariance, syllable-level variation, isolated clicks, short speech with a long faint tail, silent release, interval gaps/endpoints and reverse seeks.
- Real controller fixtures: both local and injected cloud paths, adjacent 44.1 kHz clips with non-25-ms-aligned lengths and >50× differing levels, original vs merged replay, backward/forward seeks, silent joins, pause/resume/cancel, no synthesis on seeking, and byte-for-byte unchanged merged PCM.
- Independent read-only review found the long-faint-tail regression in the first revision. It was repaired, then independently rechecked; 51 mouth/speech/avatar-performance tests passed in that review.

Entry asset: `index-Do0Zz9P4.js`, SHA-256 `132dedebe59580038692ca06fb7f55406bed5163e67488ad37940311388b8b4f`.

## Deployment

Published the built assets to the existing personal VPS, switching HTML last after the new hashed assets were in place. Previous HTML/assets were backed up at `/opt/airi-lite/backups/20261002-mouth-before.tar.gz`; old hashed resources, models, credentials and quota ledgers remain. No backend restart was needed.

Local, VPS and public HTTPS copies of the entry have the same SHA-256 above. Systemd remains active. Public health reports configured `deepseek-flash`, protected chat access and MiniMax speech still **unconfigured**. A fresh public browser page loaded one real Hiyori canvas, no model-failure notice and no captured warning/error logs. The experience-code gate was not unlocked; no production chat or paid speech request was made in this release check.

Local release screenshot: `/private/tmp/airi-mouth-online-20261002.png`. This public-page check proves release availability and character startup, not real-cloud voice quality or phone performance.

## Remaining product requirements

No phoneme alignment, listening study, real-provider emotional-voice comparison, physical-phone test or complete human-likeness validation is claimed. Cloud voice account/key/voice choice and spending approval are still absent. The wider project goal remains active.
