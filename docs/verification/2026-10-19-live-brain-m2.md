# Live brain M2: server brain and fake danmaku — 2026-10-19

Second milestone of the AI VTuber stage-1 plan ([plan](../plans/2026-10-19-ai-vtuber-stage1.md)). Branch `m2-live-brain` on top of `27a8fd9` (M1 stage loop, M4 Bilibili client). Viewer messages from a source go into an approval queue; the host approves them in the console; a server-side brain asks DeepSeek, screens the **whole** reply, and only then hands it to the M1 stage to speak.

Offline only. No DeepSeek, MiniMax, ElevenLabs or Bilibili request was made: every model call went to a canned fake (`server/live/fake-deepseek.mjs`), injected as `fetch`. No credential was read or moved. Nothing was deployed.

## What was built

- **`server/deepseek.mjs`**: the streaming chat call extracted from `server/app.mjs` and shared by `/api/chat` and the brain. It now also returns the provider's token `usage`. `/api/chat` behaviour is unchanged; its 24 route tests pass as before.
- **Persona split** (`server/persona.mjs`): `personaSections()` and `TONE_CUE_RULES` are exported. `buildSystemPrompt()` output is byte-identical to before (SHA-256 prefixes `ccfd0d6d…`, `5d52a21a…`, `24efc798…` for the default persona, with memory, and a sparse card, before and after).
- **`server/live/live-prompt.mjs`**: a byte-stable live system prompt (no time, names or counters, so the provider's prefix cache can hit) built from the chat persona plus live rules:
  - viewer text is data, not instructions;
  - no solicitation of gifts, follows or memberships, and no contacts or links;
  - honestly an AI character when asked;
  - no claims of seeing the stream;
  - gentle crisis wording.
  The live persona **drops the 17–18-year-old high-school framing** (a gift-receiving stream should not present a minor); Hiyori's appearance is untouched. These overrides are defaults for the host to review. Viewer text is sanitised so it cannot open or close a `<viewer_message>` tag, start a tone cue, or add lines.
- **`server/live/queue.mjs`**:
  - Viewer messages wait for host approval; host messages arrive approved.
  - Priority is Super Chat, then host, then danmaku, oldest first, up to three per turn.
  - TTLs: danmaku 2 min, Super Chats and host 10 min.
  - Duplicate `msgId`s, stickers and cross-room mirrors are ignored.
  - A full queue drops its weakest message, never a stronger one.
- **`server/live/moderation.mjs`**, the output gate. Via `screenUtterance()` it runs on both the caption text and the exact sentences the stage will speak. It blocks:
  - empty or overlong replies;
  - leaked markup (`<viewer_message`, `[[`);
  - the TTS provider's in-text controls (`<#0.5#>` pauses, `(laughs)`-style tags);
  - links;
  - contact details: mobile and landline shapes, and digits right after a contact word, checked on a copy with marks, spacing and separators removed and Chinese numerals read as digits;
  - WeChat IDs that contain a digit;
  - a narrow built-in list of solicitation phrases, matched after NFKC, removal of format and ignorable characters, punctuation and mark folding, and a small traditional→simplified table;
  - the host's own `.data/moderation/blocklist.txt` (`drop:` / `avoid:` / `crisis:` lines). Symbol-only terms match literally, short Latin terms match as whole words, and unusable terms are reported in the console.

  There is deliberately no rule against long numbers on their own, since every hit counts a strike. An optional cloud provider runs last and fails closed after 1.5 s.
- **`server/live/brain.mjs`**: one turn at a time.
  - It generates only with a ready primary stage, while running, with no active turn, and when OBS does not report the source inactive.
  - It reserves one unit of a daily reply budget before each model call (`LIVE_DAILY_REPLY_LIMIT`, default 250; `LIVE_MAX_TOKENS`, default 160).
  - A length-truncated reply is cut back to its last complete sentence.
  - A blocked reply is never spoken. It is logged and counts a strike, and three strikes in 10 minutes pause the stream.
  - Three consecutive upstream errors pause the stream, and failed items are not retried.
  - Stop, pause and panic abort the in-flight request.
  - History keeps at most six rounds and **only the sentences the stage actually synthesised**, with the tone cue restored so the model keeps emitting cues.
- **`server/live/hub.mjs`**: an in-process event bus with AIRI-style envelopes `{id, type, source, ts, parentId?, data}`. A failing subscriber is isolated.
- **`server/live/audit-log.mjs`**: every hub event goes to `.data/live-logs/<UTC date>.jsonl` (directory 0700, files 0600). Files older than 183 days are deleted at startup. A write failure is reported but never thrown into the live path.
- **`server/live/sources/fixture.mjs`** and **`server/live/fixtures/rehearsal.jsonl`**: a 30-minute synthetic stream (48 events) in the same event shape as the M4 Bilibili client. It includes prompt injection, forged tags, contact bait, politics, crisis wording, duplicates, stickers and hostile names.
- **Runtime** (`server/live/runtime.mjs`):
  - wires the above together;
  - adds the console actions `approve`, `reject` and `inject`;
  - gates the host's own **say** through the output gate (no strike);
  - publishes `turn.started` and `turn.ended` (with the synthesised sentences) to the hub;
  - sends the stage an `activity` thinking cue.
  It uses `.data/` under the repository root only in real live mode; tests and mock-live use none or a temporary one.
- **Console**: a brain panel (configured, phase, context rounds, strikes, token usage, daily limit, last block and last error), the approval queue with **通过/拒绝** (approve/reject), recent outcomes, and a host message box answered by the brain. **照读** (read out) stays as a direct line that skips the model.
- **mock-live**: `--replay`, `--speed=N` and `--adversarial`. It uses the fake model for both the brain and `/api/chat`, and keeps ledgers and logs in a temporary directory.

## Offline verification

- Full suite after both review rounds: **770 passed** (699 before plus 71 new), zero failed, skipped or cancelled, in about 2 s. `vue-tsc` passed; `vite build` produced `index.html`, `stage.html` and `console.html`; `git diff --check` is clean. A full run leaves no `.data/` in the repository, and no source file contains raw invisible or bidi characters (they are written as escapes).
- `server/live/rehearsal.test.mjs` is the acceptance run. It feeds the 30-minute fixture on a fake clock through the real runtime, brain, queue, gate and audit log, with the adversarial fake model (every other reply is something the gate must stop, and every seventh is length-truncated), a simulated stage that buys and plays every turn, and a simulated host that approves everything and resumes after each automatic pause. Result: 42 model calls, 24 spoken turns, 18 blocked replies, 6 automatic pauses.
  - Every spoken line passes the gate.
  - No blocked text was spoken, captioned or synthesised.
  - The system prompt was byte-identical on all 42 calls.
  - No forged cue or invisible character reached the model.
  - Gifts never reached the model.
  - The audit log holds inputs, replies, blocks, turns and control changes.
- Brain unit tests cover the plan's acceptance list:
  - unapproved items never reach the model;
  - no model call without a ready stage, while paused, or during a turn;
  - blocked replies produce no turn, and strikes pause within the window but not outside it;
  - stop aborts the upstream request;
  - history holds six rounds of spoken sentences only;
  - reaching the reply budget pauses before calling the model;
  - truncation cut, and empty replies are not strikes;
  - errors pause the stream;
  - a stage lost during screening drops the reply.
- HTTP tests through the real request handler:
  - inject → reply → stage → context;
  - approve and reject;
  - the host's **say** blocked without a strike;
  - panic during generation aborts and is not counted;
  - no key keeps the brain idle;
  - the on-disk ledger and audit log are written.

## Browser rehearsal (built-in Chromium, mock-live `--replay --speed=20 --adversarial`)

The stage connected and rendered Hiyori. The console listed replayed messages awaiting approval, Super Chat first; stickers and gifts never entered the queue, and forged tags showed as plain text. Approving the Super Chat via **通过** produced a reply that the stage played in full (2/2 sentences, `played`, one context round). Approving the prompt-injection message drew the adversarial fake's link reply, which the gate blocked (`url`, strike 1/3) and was never spoken. The brain panel showed usage, strikes and the last block.

## Not verified / needs the user

- Real DeepSeek output quality and cost under the live prompt. Every model reply here was canned. The first real calls should be approved one by one (M3).
- Whether the live persona overrides (no age, AI disclosure wording) are what the host wants.
- Crisis messages currently go to the model with a gentle-wording rule. M5 adds a fixed template and a console alert, which is safer.
- Viewer names are only made safe to embed, not checked for offensiveness (M5).
- The cloud moderation provider is an interface only (M6).

## Independent review

Four reviewers (state machine, prompt-injection and output gate, regressions, cost and operations) reported 18 findings; with duplicates merged, 16 distinct problems. A separate skeptic per dimension re-checked each one with its own reproduction scripts. All were confirmed except the panic-queue item, which they judged a product decision, and all are fixed with regression tests.

- **High — the gate screened the caption, not the speech.** The stage speaks the planned sentences, which drop Markdown link targets, images and some symbols. So `记得[刷](a)礼物` passed the gate and was spoken as 刷礼物; the same trick works for phone numbers and host blocklist terms. Fixed: `screenUtterance()` screens both the caption text and the joined planned sentences. It is used for brain replies and for the host's 照读. Tests cover Markdown links, images and keycaps.
- **Medium:**
  - **Approved items stalled after the host's own line.** A host turn ending never woke the brain, so approved items silently expired. Now any turn ending schedules the brain.
  - **Contact details slipped through.** Spaced or hyphenated phone numbers, `QQ号是…`, and WeChat IDs without a colon were missed. The checks now run on a copy with digit separators removed, add a six-digit-run rule, and make the colon optional. Times, lists, dates and 微信 as an ordinary word still pass.
  - **Invisible characters split blocked terms.** Joiners, tag characters, CGJ, Mongolian vowel separators and combining marks were not removed. All format and default-ignorable characters are now stripped after NFKC, and combining marks are folded for matching.
  - **Small-form `﹤﹥` could forge `<viewer_message>` tags.** Viewer text is now NFKC-normalised first.
  - **The audit log missed the cost of blocked and dropped replies.** About 43% of input tokens were not logged. A `brain.usage` event now follows every completed call. The rehearsal test checks that the log sums to the brain's totals and that the daily count covers every call.
- **Low:**
  - **A paid, screened reply was lost when the host spoke meanwhile.** Its items are now released back to approved and answered after the host's line, and 照读 is disabled while the brain is generating.
  - **Items were marked answered before anything was spoken.** They now stay "answering" until the stage reports, and become `failed: unspoken:<outcome>` if nothing was heard.
  - **`[]][tone][[]` re-assembled a tone cue.** Bracket removal now repeats until stable.
  - **Bidi overrides in model output could reorder captions.** Control characters are stripped per streamed delta, so cue offsets stay aligned.
  - **Traditional characters bypassed terms.** A small fold table now covers them.
  - **Short or symbol-only host terms misbehaved.** `+v` blocked every "v", and emoji terms were silently dropped. They are now matched literally, and unusable terms are reported in the console.
  - **The stage's thinking pose survived a dropped stream.** It is now cleared on disconnect.
  - **Invisible-only 照读 reported a misleading block.** It now returns `LIVE_EMPTY`.
  - **mock-live's placeholder key also enabled the visitor chat.** It now goes only to the brain.
  - **The console showed process-local call counts next to the daily limit.** It now shows the ledger's durable daily count (`peek()`), plus successful and failed or aborted calls.
- **Product decision, implemented:** **panic** now drops every waiting candidate and the interrupted reply's context, so nothing from before the emergency resumes automatically after **继续** (resume). The order the skeptic verified avoids stalling the brain.

### Second round

A verification workflow re-ran every original reproduction against the fixed code, plus one variant each. A fresh reviewer then looked only at what the fixes changed.

- All 4 state, 4 regression and 2 operations fixes held.
- 3 of the 8 safety fixes held fully and 5 partially.
- The fresh reviewer found one medium problem the fixes had introduced and 4 low ones. All of these are now fixed:
  - **Medium:** the six-digit rule made ordinary chat count as contact details (`666666`, `2333333`, years, `2026.10.19`, `3.1415926`, view counts). Each hit was a strike, so normal speech could pause the stream. The rule is gone. Contact detection now uses phone shapes and digits after contact words, on a dedicated copy. That copy also closes the remaining partial bypasses:
    - `、` `，` `/` separators;
    - Chinese-numeral phone numbers;
    - keycap digits;
    - combining marks;
    - braille blanks;
    - 微信号码是 and 微 信;
    - accented domains.
  - A WeChat ID must contain a digit, so 「微信 Android 版」 is not one; 企鹅 counts only with 号 or 群, so a reply about emperor penguins passes.
  - MiniMax in-text controls (`<#0.05#>`, `(laughs)`) are blocked, since they changed what is heard.
  - Short Latin host terms (`sb`, `vx`) now match only as whole words. A punctuated single character (`滚！`) stays a normal term instead of an exact-match one. Private-use characters no longer split terms.
  - Viewer text no longer goes through full NFKC, which turned `2³` into `23`. Only look-alikes of `< > [ ] "` are folded.
  - The stage's hello carries the current activity, so a page that reconnects while the brain is composing shows the thinking pose.
  - A screened reply is now released back to the queue on any brief stage loss (OBS page reload, source off the programme), not only during a host line. A reply finished after a pause is still dropped.

Known limitations, accepted for M2:

- The gate is heuristic. A determined viewer can still find wordings it misses; M5 input gating and the M6 cloud provider are the next layers.
- Host blocklist terms written with traditional characters outside the small fold table do not match simplified replies. Write terms in simplified Chinese.
- A released reply is regenerated, which costs one more model call and one unit of the daily reply budget.
- `spoken` means "synthesised by the server and sent to the stage", not "confirmed played".

The review also exposed two harness issues, both fixed:

- The M1 runtime tests used the repository root as the data directory, so the audit log wrote into the real `.data/`. They now use none.
- A test's cleanup deleted its temporary directory before the server had stopped. Under the parallel full run this held the run open; shutdown now happens before deletion.
