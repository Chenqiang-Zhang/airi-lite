# Direct typed barge-in — 2026-10-10

Verification against checkpoint base `5f4e13461ba2894e9077f6979fb69618c2430fb5`. This batch changes turn-taking, not persona or learned voice quality. Earlier verified speech/render/international preparation changes remain in the same worktree; the independent `deploy/airi-lite.service` edit is excluded from the checkpoint. No SSH, deployment, paid activation, voice training, real project LLM/TTS request, or credential display/edit/upload occurred. The mock uses `envDir: false`; the normal production build retains Vite's normal environment loading.

## Contracts and checks

- A valid next message can be submitted while text is generating or speech is active. Typing/focus alone does not interrupt. Validation of text/access/request precedes cancellation; rejected input keeps the active turn and draft.
- Ownership is revoked before abort/cancel callbacks. The new turn, unique message IDs, placeholder and consumed draft are claimed synchronously before `nextTick`. The UI does not insert an extra role reply or flash the manual-stop notice.
- Visible old text and delivery offsets remain; an empty placeholder is removed. Request context contains the old text, not its UI-only interrupted marker. Stale deltas, delivery, success/failure and cleanup cannot own the new turn.
- Manual stop retains its notice and composer focus. Native composition/229 Enter keeps candidate confirmation intact while guarding implicit submission; a post-composition confirmation is also guarded through that task.
- Targeted tests: **16/16 passed**. Full `pnpm test`: **497 passed**, zero failed/canceled/skipped. `pnpm build`, mock syntax and `git diff --check` passed. Existing large-chunk warning remains; main JS is `index-DhYvoUBV.js`, 148.57 kB / 57.20 kB gzip. No measured device-performance claim.

The coordinator tests exercise delayed old release, duplicate and abort-reentrant submissions, invalid/empty inputs, empty placeholders, voice-only interruption, manual stop and keyboard/composition event shapes. They are not a native OS IME test.

Independent review found greeting constructors in reset/persona still using `Date.now()` outside the new allocator. A compiled actual-App probe with initial clock 1000 and reset at 1002 reproduced duplicate IDs `[1002,1001,1002]`, causing stop to mark the greeting instead of removing the empty assistant. Both constructors now use `nextMessageId()`. Four checked-in regressions compile and execute the real App setup/handlers for reset/persona at clocks 1002/10000, stubbing lifecycle/transport/persistence/avatar/audio boundaries. They verify increasing unique IDs before await, correct placeholder removal and ignored late production-App callbacks. No new dependencies were added.

## Actual Chrome and actual Vue

Loopback fixture: `node scripts/mock-voice-app.mjs --no-speech elevenlabs normal cn --barge-in`. Actual App: `/airi/`; explicit gate UI: `/airi/scripts/chat-barge-in-preview.html`. Both speech providers are disabled; fake chat uses fixed public phrases. Diagnostic history shows only allowlisted fixture text and lengths; other greeting/persona/content is omitted. Final verification intentionally reloaded after the allocator fix and restarted the mock for empty diagnostics.

1. Cleared the conversation through the actual menu. Sent `开始慢回复。`; request #1 displayed `模拟旧回复：先去河边。` and waited at its explicit gate.
2. Typed a draft without submitting; then submitted three spaces with Enter. Request count stayed 1, old connection stayed open, generation stayed active, and the three-space draft remained in the input.
3. Filled `改讲公园。` and clicked **打断并发送** once. A following Enter with the consumed empty draft did not create another request. Request #2 displayed `模拟新回复：改去公园。`; old visible text remained marked “已停下”.
4. Typed `这句先留在草稿。`, then released old gate #1. Diagnostics showed exactly two requests, old disconnected/released and new waiting. The new generating UI and draft remained; old tail was absent. Request #2 history contained the original user phrase, displayed old assistant fragment and correction, with no interrupted label or empty placeholder.
5. Released new gate #2. Only the new reply gained `（模拟释放尾句。）`; generation ended and the draft remained.
6. Sent `第三句。`, then used manual **停下** and released gate #3. The third fragment stayed marked interrupted without its tail, generation stayed stopped, the composer was focused, and the original manual-stop notice appeared.

The fixture observes an already disconnected old browser request before attempting its late tail. It cannot prove that network bytes reach stale browser callbacks; deterministic callback/compiled-App tests cover that boundary separately. Browser cancellation also does not establish that a real upstream immediately stops work or refunds charges.

Actual Hiyori rendered. The test origin already used lightweight browser speech, so no Kokoro model download was requested. The system engine reported unconfirmed speech start again; no natural speech/audibility claim is made. No warning/error console entries were captured for the final app check.

Local screenshots outside the repository:

- `outputs/airi-barge-in-20261010.png` under the desktop AIRI directory: old fragment, new active reply and retained draft after old-gate release.
- `outputs/airi-barge-in-diagnostic-20261010.png`: two requests and redacted context/ownership state.

An earlier capture was invalidated by development HMR during the repair; it was replaced by the final post-reload capture, not used as acceptance evidence. Diagnostic HTML is a development entrypoint, not part of the production build.

## Remaining full-goal gates

Real Mandarin expressive audition/listener acceptance, non-assistant-like dialogue evaluation, phoneme/viseme timing, working native voices/OS IMEs and physical-phone performance remain unverified. This batch makes an observable interaction improvement; it does not prove undetectably human conversation or complete the humanization goal. The checkpoint is source publication, not production deployment.

SHA-256 source snapshot:

```text
2d71b60be0f2e10aff4b2b925da20774b1ae6b34a7bfcac35fad08e9877b00a5  src/App.vue
e8583465d352872524c228133bf6b6d9f54fd7c4aeaa9736be5de44a9f6b36b2  src/chat-turn.ts
c5a723687695b8d1d09c0d59bc45dcca5103a291fa9c53f427a8f8b293e45873  src/chat-turn-app.test.mjs
dfc1adcdb73c18376594ac92e65e690464fb7e9c0539dc4cb2b6ae37be9fc563  scripts/chat-barge-in-preview.html
```
