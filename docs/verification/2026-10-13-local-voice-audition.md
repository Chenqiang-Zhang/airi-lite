# Local voice audition — 2026-10-13

Status: development implementation passed offline review; real audition
remains pending authorization. **No actual audition
WAV or persistent listening manifest has been generated or delivered in this
run.** Browser access was not authorized, so no alternative browser, origin,
driver or command-line model generation was used to bypass that restriction.
The full companion humanization goal remains unproven and active.

## Intended comparison

The loopback-only `/airi/scripts/voice-audition-preview.html` uses the production
speech controller with real installed Kokoro, not fixture PCM, if its cache
preflight succeeds and the user starts a batch. It does not load environment
keys, call chat/cloud speech, or save the application's default voice.

- Twelve neutral audition items: three existing Chinese voice presets and the
  same four public, synthetic lines from the voice-provider shortlist.
- Fixed concealed labels, with the real mapping in source and the downloadable
  manifest. This is not a randomized or rigorously blinded study.
- After a human selects one voice, three new delivery items compare the first
  three lines; the fourth neutral item reuses its existing baseline. No winner
  is automatically selected. Current delivery controls mostly change speed,
  not learned expressive emotion.
- An audition item can contain several production speech sentences. The four
  texts split into `[2, 1, 1, 2]`: the neutral batch therefore requires at least
  18 actual model invocations, and optional delivery adds at least four. The
  maximum of 15 unique audition items is **not** a 15-inference budget. Actual
  model calls are separately instrumented and recorded.

Replay and download reuse a successful item's WAV without new inference.
Human notes are optional; empty notes mean unevaluated, not a passing score.
Refreshing discards temporary page data unless its audio and manifest were
downloaded. Generated WAVs stay local and are not part of the public repository.

## Resource and authorization boundaries

The installed Kokoro/Transformers loader expects exact `transformers-cache`
responses for config, tokenizer, tokenizer config and `onnx/model.onnx` at the
configured model's `resolve/main/` URLs. Voice embeddings alone are not proof
that the model is available. The preflight checks complete cached bodies and
basic structure, not a model hash or the latest upstream revision.

The model repository labels this model Apache-2.0 and currently lists fp32
`model.onnx` at approximately 339 MB; tokenizers and runtime add overhead.
These are public metadata checks, not a model download. See the [model card](https://huggingface.co/onnx-community/Kokoro-82M-v1.1-zh-ONNX)
and [file listing](https://huggingface.co/onnx-community/Kokoro-82M-v1.1-zh-ONNX/tree/main/onnx).

The page checks installed local ORT runtime and voice resources. Its fetch
adapter returns only exact preverified cached model responses for external
URLs; API/write requests and unknown external URLs are refused. No generation
starts automatically. Missing resources stop the batch rather than authorizing
a download. This implementation still needs actual browser verification; its
offline guard tests are not proof of all runtime network behavior.

## Verification status

`pnpm test` passed **525 tests**, with zero failures, skips or cancellations.
Production typechecking/build passed; the existing large-chunk warning remains.
The final audition-specific tests passed nine cases. The production build was
not repeated after the last change because that change only affected the
development HTML/test, not an app import; the full suite was repeated after
that material repair.

The reviewer found and retained two failed contracts before repair:

1. Paused/zero-time/at-least-one-ended was not a full-reply marker. After clip
   one ended, a blocked second clip could be accepted as a complete WAV. The
   controller now exposes an owned, immutable `getCompletedAudioBlob()` only
   after successful synthesis and all accepted playback drains into the full
   replay source. Cancel/new-run/source replacement/partial failure/fallback
   clear or suppress the snapshot; the page uses it directly rather than
   fetching a potentially revoked `currentSrc`.
2. Cancellation could occur while asynchronous WAV inspection ran. The page
   now rechecks cancellation, error and the exact owned Blob after inspection,
   before publishing a successful result.

Actual-controller fake-DI tests show a blocked second clip has no snapshot;
after fake media completion the Blob contains both expected PCM pieces byte
for byte, and replay adds no model call. Additional tests cover cancellation,
new turns, partial/fallback and reentrant callbacks. A test executes the actual
page audition function with delayed inspection and fake model/media signals:
cancel, replacement and late error all fail without a WAV/download URL. These
are offline state/ownership tests, not real Kokoro or native-media evidence.

Requested delegation: Astra planner, Sol executor/reviewer, one Sol repair and
one small parent consolidation after the repair limit. Delivered model identity
and per-agent usage were not observed; no savings or quality score is claimed.

Actual browser cache readiness, real model loading, complete WAV generation,
decode/media-clock progress/native endings, persistence and user listening
remain pending authorization. Browser events do not by themselves prove
hardware audibility. Physical phone behavior and phoneme-level lip sync also
remain unverified. No server deployment, paid provider call or voice training
is part of this work.
