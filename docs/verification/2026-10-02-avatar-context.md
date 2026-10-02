# Facial context and bounded expression release — 2026-10-02

This is an engineering verification record, not a listener study, phoneme/viseme benchmark or physical-phone performance claim. No new LLM request, microphone access, paid speech call or provider activation was used.

## Production changes

- `src/avatar-context.ts` separates facial context from actual speaking activity. A conservative existing text heuristic chooses only soft/neutral for the first wait; it is not emotion recognition.
- Only a delivery callback from actual playback may replace that baseline. Incoming SSE cues enter the speech queue but do not immediately change the face.
- After playback stops, its expression bridges a sentence gap for at most 2,500ms. A long wait returns to this turn's user-text baseline. Final idle returns to neutral. Waiting/idle transitions may change the destination but cannot extend an existing deadline.
- New turns, resumed speech, stop, reset and disposal invalidate queued old timer callbacks. A late-mounted avatar receives the current context even if no cue changed while loading.
- Soft delivery blends raised Idle eyebrows toward -0.16 at a maximum 0.9 weight, alongside the existing calming of smiling eyes and blush. Neutral leaves the underlying Idle baseline intact.
- Waiting never opens the mouth or adds audio emphasis. The existing audio-driven mouth and reduced-motion/render-budget policies are unchanged.

Independent read-only review identified two issues before release: indefinite retention during long sentence waits, and the diagnostic context-to-manual takeover retaining its zero-mouth fixture. Both were corrected, with timer/target and manual-takeover regression coverage.

## Automated checks

- `pnpm test`: **279 passed, zero failed/skipped**. This includes 18 context lifecycle cases, 13 avatar performance cases and 6 diagnostic cases.
- Context fixtures cover first wait, genuine playback priority, ignored upcoming cues, bounded gaps, destination changes without renewed deadlines, stale callbacks, replacement, clear and destroy. Gap timers whose destination was already changed are also covered.
- The diagnostic takeover test checks source ordering; it is a structural shield, not a browser execution result.
- `pnpm typecheck` and `pnpm build`: passed. The existing large-bundle warning remains.
- Main bundle: `index-ecLJ0-B7.js`, SHA-256 `1de441f5a995f2a922a7da5f32048b220fe1eea0ac86fbf0cce27efbb44ae262`.

## Actual browser: real model, synthetic context signals

Development page: `/airi/scripts/avatar-preview.html`, actual Hiyori/Cubism/WebGL and production context/performance helpers. Its context buttons are explicitly labelled synthetic playback signals; they generate no audio.

Observed sequence:

1. Low-mood wait and a future bright cue: thinking/soft, mouth 0.
2. Synthetic bright playback followed immediately by a gap: thinking/bright, mouth 0.
3. After the release window, without another cue: thinking/soft, mouth 0.
4. Manual soft/speaking takeover while a gap timer was pending: rendered mouth 0.700; the soft face remained after the old deadline.

One long-wait render observation read smiling-eye baseline L/R `0.658870/0.649133`, then `0.065887/0.064913` after the soft overlay; brows were `-0.144`, and mouth remained 0. This is a parameter/render observation, not a human emotion rating. A local screenshot was saved as `/tmp/airi-context-soft-release-20261002.png`; it is a development view, not the production site.

## Actual browser: free local audio

The same page at a 30fps ceiling generated and played the fixed Kokoro lines:

> 诶，终于来了！今天居然一口气把这段跑通了。
> 先慢一点说也没关系。

The completed replayable audio reported **9.225s**, readyState 4 and no media error. Before the separate replay/cancel check, observations were:

- 279 speaking render frames; 99 low-opening frames (`mouthOpen < 0.06`).
- 86 emphasis frames; maximum added pitch offset 0.890 degrees.
- Zero low-opening emphasis mismatches and zero mouth-override errors.
- Final context neutral and mouth 0 after the release window.
- No warning/error console logs in this checked run.

The already-generated clip was subsequently replayed, paused through its visible media control and taken over by a manual pose; this generated no additional audio. The manual path cancels speech and clears its context timer before setting the pose. Frames here are not phonemes or human-labelled silence, and playback/decode success is not proof of audible naturalness.

## Boundaries

The actual Vue App watcher/late-mount wiring was code-reviewed but not mounted in a dedicated automated integration harness. Physical-phone keyboard/touch, real OS background changes, listener-rated emotional quality, free multi-turn persona behaviour and phoneme-level mouth timing remain unproved. Cloud speech remains disabled while the user chooses an account/voice/budget; the newer ElevenLabs candidate has not been implemented or auditioned in this app. These changes do not complete the overall humanization goal.
