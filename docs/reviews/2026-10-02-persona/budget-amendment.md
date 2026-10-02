# Follow-up amendment, frozen before follow-up generation

The first candidate still added unsupported comfort/confusion to the alarm reply. Both independent reviewers marked its grounding `invented`. That candidate is retained unchanged as `candidate-card.json`; its review is not a final-card evaluation.

One final revision adds two brief, fact-grounded examples, without making every reply a joke or removing the character's preferences. Additional budget: exactly four real requests, one draw each, using `followup-cases.json`. One repeats the known alarm failure; three different contexts check ordinary sharing, completed cleanup and explicitly plain speech. No failed-output resampling or retry to obtain nicer answers is allowed.

Two fresh no-history independent reviewer batches may cover these four final replies, adding eight item assignments. Total generation ceiling = 12 real DeepSeek requests; full-item review ceiling = 24 assignments, plus at most the previously allowed one field-only adjudication batch. No human calibration is added, so agreement remains at most silver. The new diagnostic cases are informed by known failures and are not held-out or representative samples.

An earlier baseline launch exited before health/chat because the command named a nonexistent `.env.local`. The service's environment-file path was then read from systemd (without reading its contents), and the runner loaded `.env` internally. That setup failure made zero model requests and yielded no text; it is not a discarded generation.
