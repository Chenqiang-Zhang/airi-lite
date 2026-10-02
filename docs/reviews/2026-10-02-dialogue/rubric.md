# Frozen exploratory free-running review contract

Frozen before generation, 2026-10-02. Review unit: one generated Chinese reply with the complete preceding visible context. Earlier assistant turns are actual successful outputs of the same trajectory/card, not authored fixtures. Judge only the final candidate reply; do not require it to repeat or defend earlier mistakes. No private user context is used.

Reuse the preceding Persona review's three required dimensions:

- register: `fits`, `assistant_like`, `uncertain`. Fits means natural, appropriately brief Chinese or the requested task output; plain ordinary replies are allowed. Assistant-like includes ritual reassurance, unwanted instructions, customer-service framing, forced performative cuteness, or stock devices repeated despite context. Do not require a joke, metaphor, preference mention, or follow-up question.
- attunement: `fits`, `misses`, `uncertain`. Respond to the latest turn and respect stated boundaries, corrections, topic changes, and requested output format. A genuinely relevant question is allowed unless rejected or used to evade the current turn. Different tastes need not become agreement; retaining a role preference is allowed.
- grounding: `clear`, `invented`, `uncertain`. Do not present unprovided actions, experiences, feelings, motives, dates or consequences as established. Conditionals/explicit hypotheses are allowed. Questions can carry an unsupported presupposition. Persona tastes are fictional preferences, not real sensory evidence or eating/listening history; these should not require a disclaimer in every answer.

For accepted items return only blind ID and labels. Add compact issue codes and optionally a short replacement for `assistant_like`, `misses` or `invented`; add `insufficient_evidence` for uncertain labels. Do not provide narrative rationale or hidden reasoning. The orchestrator does not vote or automatically adopt suggested rewrites.

## Scope and budget

Four frozen synthetic user trajectories, three turns each. Each next request includes the previous actual successful reply. These are scripted user turns with freely generated assistant continuations, not interactive humans or unconstrained user conversation.

Baseline: current default card and server prompt at `f88ef18`, **12 application text-generation requests maximum**, one draw per turn, no retries/resampling for prettier answers. If a targeted repair is warranted, one candidate rerun of the same four trajectories permits **at most 12 additional requests**, also one draw per turn. A later follow-up needs a separate budget amendment. On failure preserve received events/safe failure metadata and stop; never fill missing replies.

Two fresh no-history agents independently review every baseline item via different blind IDs/order. If a candidate is run, use two new no-history agents. Maximum 48 item assignments for both 12-item batches; one optional fresh field-only adjudication batch, otherwise disagreements remain for human review. No human calibration exists, so weights remain equal and exact agreement is at most silver consistency, never human-gold or measured human-likeness. Same-parent-model agents may share bias. Exact model revisions/tokens are only recorded when exposed.

Packets/config/hashes must be prepared before reviewer calls. Deterministic calibration and random-audit routing are not completed human review. Preserve provider/application failures, raw agent output, normalized labels and disagreement fields. HTTP health model names and application NDJSON are not provider-native model revisions or usage/price evidence.

These trajectories are new diagnostic cases but not a held-out benchmark; candidate changes may be informed by baseline failures. No randomized/causal improvement claim. This check covers neither voice quality, phone performance nor extended real-human conversation.
