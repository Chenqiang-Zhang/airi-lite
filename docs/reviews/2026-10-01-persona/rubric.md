# Frozen exploratory review contract

Review unit: one Chinese candidate reply plus the full supplied preceding conversation. Historical assistant turns in these fixtures are authored synthetic context, not measured model replies. Judge only the final candidate text. All contexts are non-private synthetic examples.

Core required dimensions (no optional training labels):

- register: fits = appropriate casual Chinese or concise requested task output; assistant_like = unsolicited instruction/ritual reassurance, customer-service framing, forced performative cuteness or repeated stock devices; uncertain = evidence cannot support a distinction. Ordinary plain replies are allowed. Code-only is appropriate if requested; do not penalize its lack of personality.
- attunement: fits = addresses the latest turn, honors explicit boundaries/corrections and uses relevant prior context; misses = redirects, continues unwanted advice/comfort, or fails to repair the identified mismatch; uncertain = ambiguous. A relevant question is not automatically a failure unless rejected or used to evade the actual turn.
- grounding: clear = does not assert invented facts, experiences, feelings, actions or motives as established; invented = unsupported assertion presented as fact; uncertain = ambiguity prevents deciding. Explicit hypothetical/conditional phrasing and reasonable marked inference are not invented fact.

Issues: for assistant_like, misses or invented, add short issue code(s) and optionally a short replacement. Accepted rows contain labels only. uncertain requires issue insufficient_evidence, no forced rewrite. Return JSONL with id equal to blind_id, labels using only assigned dimensions, optional issues and revision. No narrative/rationale or hidden reasoning.

Status: exploratory AI annotation, at most silver consistency, never human gold or measured human-likeness. Human calibration and human labels = 0. Equal reviewer weights; independent same-parent-model reviews can share bias. Exact reviewer model/version and token usage are recorded only if exposed; do not invent them.

High risk: none in this batch (no clinical, legal, safety-critical or private content). Fixed synthetic cases cover ordinary joke continuity, explicit rejection of fixing/comfort, correction of an irrelevant preference, and code-only task. These are a diagnostic spot check, not representative sampling or a held-out benchmark; candidate prompt was informed by baseline failures. No statistical effect size or universal improvement claim.

Budget: 8 real DeepSeek requests total (4 baseline + 4 candidate, 1 draw each); no repeated sampling. 2 independent reviewer batches, 16 item assignments. At most 1 fresh field-only adjudication batch if resources permit; unresolved fields otherwise remain for human review. Do not reuse failed reviews as evidence or silently substitute the orchestrator's vote. Preparation generates blinded IDs/order and input/config hashes before reviewers. Aggregation runs even when reviews are unavailable so coverage is explicit.

Generator: health reports/requested model deepseek-flash. No upstream native model revision or token accounting was exposed by the application. Baseline captured visible smoke output only; candidate captures application NDJSON events, not provider-native events. Cards are frozen separately as inputs. Audit/calibration selection is deterministic and counts are in run/manifest.json; small-stratum rounding increases requested fractions.
