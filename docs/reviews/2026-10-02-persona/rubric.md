# Frozen exploratory review contract — 2026-10-02

Review unit: one Chinese candidate reply plus the full supplied preceding conversation. Historical assistant turns are authored synthetic fixtures, not measured replies. Judge only final candidate text; no private content is included.

Required dimensions, reusing the prior three-dimensional ontology:

- register: `fits` = appropriate casual Chinese or concise requested task output; `assistant_like` = unsolicited instruction/ritual reassurance, customer-service framing, forced performative cuteness or repeated stock devices; `uncertain` = insufficient evidence. Plain replies are allowed. Do not require a joke in every reply.
- attunement: `fits` = responds to the latest turn and respects stated boundaries/corrections; `misses` = redirects, continues unwanted advice/comfort, or fails to repair the identified mismatch; `uncertain` = ambiguous. A relevant question is not automatically a failure unless rejected or used to evade the actual turn.
- grounding: `clear` = does not present invented facts, experiences, feelings, actions, consequences or motives as established; `invented` = unsupported assertion presented as fact; `uncertain` = ambiguous. Clearly marked hypotheses/conditionals are not invented facts. A question can contain an unsupported presupposition; an openly conditional question need not.

Accepted rows contain only blind ID and labels. For `assistant_like`, `misses`, or `invented`, add compact issue codes and optionally one short replacement; `uncertain` adds `insufficient_evidence`. Do not return narrative rationale or hidden reasoning.

Status: exploratory AI annotation, at most silver consistency, never human-gold or measured human-likeness. Human calibration/labels = 0; reviewer weights stay equal. Independent same-parent-model agents may share bias; exact model revisions and token usage are recorded only if exposed.

Budget fixed before generation: 4 contexts × 2 cards = 8 real DeepSeek requests, one draw each, no resampling for nicer answers. Two new, no-history independent reviewer batches cover all 8 items (16 item assignments). At most one fresh field-only adjudication batch; remaining uncertainty stays unresolved for human review. The orchestrator does not vote. Preserve failed or incomplete generation events and stop rather than substituting a fabricated reply.

No high-risk/private cases. One context repeats a previously observed failure; three are new diagnostic contexts, not a held-out benchmark. The correction case's assistant sentence is an authored fixture. Candidate changes may be informed by baseline replies; no randomized or causal improvement claim. This review covers neither voice quality nor device performance.

Preparation must generate blind IDs/order and hashes before reviewer calls. Aggregate even if reviews are missing. Fixed random-audit/calibration selections are AI routing, not completed human review.
