# Hiyori free-running dialogue diagnostic

Generated 2026-10-02 UTC; archived 2026-10-03 JST. **The candidate was withdrawn, not deployed.** The application's default remains the baseline at `f88ef18`. Adding more persona-card constraints did not resolve the intended question-pressure problem in these samples.

## What ran

Four frozen synthetic user trajectories, three rounds each, for each of two cards: 24 real application text requests through the existing configured DeepSeek service. Every later round includes the preceding actual completed response from that same trajectory/card. All 24 rows completed with application `done` events; the 16 between-round handoffs were checked against the recorded responses. There were no retries, resampling, failed rows or known-credential redactions. No voice synthesis was called.

The health-reported requested model was `deepseek-flash`. Provider-native model revision, token usage, generation-parameter overrides and billing were not exposed/inspected. Do not treat the application event stream or requested model name as that missing evidence.

The candidate appended guidance about unanswered questions, initiating a concrete topic, and not inventing a celebratory backstory, plus two examples. It was informed by baseline failures, so this is neither a held-out benchmark nor a randomized causal comparison. Exact cards, cases and outputs are retained; no better-looking draw replaced a poor one.

## Result and deployment decision

| Diagnostic | Baseline | Candidate |
| --- | ---: | ---: |
| Completed real replies | 12 | 12 |
| UTF-16 reply length | 17–55 | 16–59 |
| Replies containing `?` or `？` | 4 | 7 |
| Bread trajectory: consecutive question-mark replies | 3 | 3 |
| Replies with a reviewer issue | 4 | 4 |

Question marks are a reproducible descriptive count, **not a semantic question-pressure label, naturalness score or statistical improvement estimate**. Both reviewers accepted register and attunement for the baseline bread replies; the orchestrator's product concern about unanswered-question chasing is separate from their votes. The candidate still asks which bread, its filling, then whether it is sweet/savoury. Its third task-switch reply also missed the requested one-sentence companionship boundary according to both reviewers.

Baseline concerns include invented bug duration and inferred current feelings. Candidate concerns include presupposing a bread filling, attributing a taste preference to an unstated reason, and a claimed recent thought. Some boundaries—fictional inner thoughts, casual dessert sharing, listening habits and inferred feelings—need human judgment, not automatic rejection based on AI agreement.

The candidate source edit and migration tests were withdrawn. A fresh build from the restored baseline produces the unchanged `index-Do0Zz9P4.js`, SHA-256 `132dedebe59580038692ca06fb7f55406bed5163e67488ad37940311388b8b4f`. `pnpm test`: **368 passed, 0 failed**; `pnpm build`: success with optional large-chunk warnings. No frontend upload or service restart occurred for this diagnostic. Public health was rechecked with cloud speech still disabled. Only the non-production diagnostic runner had been copied to the VPS to execute the samples.

## Independent review and limits

The frozen [rubric](rubric.md) and [config](review-config.json) reuse register, attunement and grounding. Four fresh no-history reviewers each saw only their rubric and own blind packet: two per card, different IDs and packet order. All 24 replies received two reviews: **48 item assignments**. There was no human calibration, so weights are equal. Exact reviewer model revisions and token usage were not exposed; shared model bias remains possible. The orchestrator did not vote or automatically adopt rewrites.

| Exact per-field agreement | Baseline | Candidate |
| --- | ---: | ---: |
| Register | 12/12 | 12/12 |
| Attunement | 12/12 | 12/12 |
| Grounding | 10/12 | 12/12 |

Agreement includes agreement on failures; it does not show that the candidate is better. The two baseline grounding disagreements remain unadjudicated. Each helper summary contains 24 resolved fields and 12 provisional fields. Its `unresolved_fields: 0` does **not** mean every reply passes: issue-bearing items are routed as provisional, including those two disagreement fields. No field-only adjudication was run.

Deterministic routing selected four calibration-overlap items and four fixed audits per card; per-stratum integer rounding expanded the requested 20%/10% fractions. These are selections, not completed human audits. The union of issue-bearing replies and fixed audit selections is **15 pending card/reply units (7 baseline, 8 candidate)**. Human-reviewed units: **0**. See [routing and agreement](routing-and-agreement.json) for IDs/reasons and [provenance](provenance.json) for hashes, counts and boundaries. AI labels are unconfirmed; exact agreement is at most silver consistency, never human gold or proof that people cannot distinguish the character from a human VTuber.

## Files

- `cases.json`: the frozen user turns.
- `baseline-card.json`, `candidate-card.json`: exact input cards, including the unsuccessful candidate.
- `*-replies.jsonl`: actual replies, normalized transmitted contexts, timestamps and application events.
- `*-items.jsonl`: review units mechanically derived from those replies.
- `raw/`: independent original reviewer outputs, before schema-key normalization.
- `*-run/`: blind packets/maps, normalized reviews and deterministic aggregation outputs. The maps are reproduction metadata, not secrets; reviewers did not receive them.

## Reproduce only with an explicit call budget

The frozen run's 24-request maximum is consumed. Repeating this command spends new provider usage and needs a separate saved budget decision; it is **not** an instruction to rerun automatically. Use Node 24 and synthetic non-private cases. Keep the access code in the server environment, never in the packet or command arguments.

```bash
node --input-type=module - <<'NODE' | node --env-file=.env scripts/persona-dialogue-check.mjs
import { readFileSync } from 'node:fs'
const dir = 'docs/reviews/2026-10-02-dialogue'
const persona = JSON.parse(readFileSync(`${dir}/baseline-card.json`, 'utf8'))
const { trajectories } = JSON.parse(readFileSync(`${dir}/cases.json`, 'utf8'))
process.stdout.write(JSON.stringify({ persona, trajectories }))
NODE
```

The runner defaults to loopback `/airi/api/chat`; `AIRI_SMOKE_URL` may override it. It validates all input before network access, isolates trajectories, caps one invocation at four trajectories × three turns (12 text requests), and stops the whole batch on the first incomplete/empty/error/credential-echo response without retrying. Safe failure records contain classifications, not raw HTTP bodies, headers, credentials or exceptions. Tests inject fake fetches and do not call DeepSeek.

Next: change the hypothesis or the response policy and improve the targeted review boundary before another bounded run. More card prohibitions or blindly shorter replies are not supported by this failed candidate. Real-human conversation and expressive-voice auditions remain separate completion gates.
