# Arch Improvement Memory — `bb-plugin-provider-pi-durable`

## 2026-10-12 - Provider Bridge is a Slave Protocol: Subthreads Require Explicit BB Server DB Creation
- Context: Native subagents and composite `providerThreadId` in Beyond Boundaries.
- Symptom: A subagent executed in Pi Durable (`tx.createConversation`), but no child thread appeared in the BB IDE sidebar.
- Cause: The Provider Bridge protocol (`stdio JSON-RPC`) is strictly slave/reactive. Pi creates conversations inside local `session.sqlite`, but BB renders threads exclusively from its internal server SQLite table (`threads`). Without an explicit call to BB Server (`bb.sdk.threads.spawn` or REST API), BB Server has zero knowledge of the subagent, so no sidebar thread exists.
- Use next time: Never assume a provider's local DB entities automatically project into the host UI. Subthread sidebar projection requires an explicit registration call to BB Server API, decoupled from in-process task execution.
- Evidence: Visual inspection in BB IDE; `src/host/bridge.ts` protocol schema; lack of `threads.spawn` calls after PR #9 removal.

## 2026-10-12 - Shared Owner Session Requires Target-Aware Thread Delta Routing
- Context: Reusing `PiThreadSession` across composite thread IDs (`${sessionKey}:${conversationId}`).
- Symptom: If a child thread with ID `thr_child` sends `turn/start`, its deltas would be sent to `thr_parent`.
- Cause: `PiThreadSession` cached `this.options.threadId` from the initial parent connection and blindly routed all runner event deltas to `this.options.threadId`.
- Use next time: In multi-conversation or composite-ID sessions, wire event deltas must map from `event.conversationId` (or active turn threadId) to the specific target `threadId` registered in `SessionRegistry`.
- Evidence: `src/host/session.ts:66` hardcoded `this.sendNotification("thread/delta", { threadId: this.options.threadId, deltas })`.

## 2026-10-12 - Tool Execution Details Stripped in Durable `tool_execution_end`
- Context: Subagent delegation visual cards and `childRef` in timeline deltas.
- Symptom: `childRef` in the delegation card reverted to fallback `"subagent"` instead of the actual `conversationId`.
- Cause: `@earendil-works/pi-durable` deletes `slot.details` when a tool finishes. `tool_execution_end` events lack `details`, causing extractor to return `undefined`.
- Use next time: Buffer `details` (specifically `conversationId`) across `tool_execution_update` events during the tool's lifecycle so `tool_execution_end` retains the conversation metadata.
- Evidence: `src/runner/bridge/tool-result-extractor.ts:74`, `src/host/tool-delta-translator.ts:201`.

## 2026-10-12 - Cycle 86.1: Dual-Track Architecture for Subagents & Subthreads
- Context: Reconciling in-process subagents and BB sidebar child threads without custom socket servers.
- Architectural Resolution:
  1. Native Provider Subagents (Model A): In-process task execution inside `session.sqlite`. Rendered entirely in the parent thread timeline via `DeltaDelegationShape` with real `childRef`. Zero server race conditions or deadlocks.
  2. BB Platform Delegation (Model B): Full independent child threads created via BB platform (`bb thread spawn`), with `providerThreadId: ${sessionKey}:${conversationId}` routed via `SessionRegistry` (Shared Owner) and dynamic delta routing in `PiThreadSession`.
- Verification: 176/176 tests pass, zero type escapes, AP-019 strictly adhered to.

## 2026-10-12 - Subagent BB Subthreads Require Active Mirror Guard to Prevent Duplicate Turn 1 Execution
- Context: Auto-spawning BB sidebar threads on behalf of in-process subagents.
- Symptom: Spawning a subthread in BB causes Turn 1 to execute a duplicate concurrent model generation on the same task.
- Cause: BB Server automatically schedules Turn 1 and dispatches `turn/start` to the Provider Bridge when a thread is created with an initial prompt.
- Use next time: Providers running in-process subagents must implement an Active Mirror Guard in the bridge router. The guard intercepts `turn/start`, verifies if the conversation is an active or completed mirror, acknowledges the turn (`input.accepted`, `turn.open`), and suppresses duplicate `session.prompt`, attaching the thread to the live subagent delta stream instead.
- Evidence: `tests/subagent-parallel-work-check.test.ts`, `src/host/bridge-router.ts:88`, `src/host/subagent-mirror.ts`.

## 2026-10-12 - AP-022: Silent Catch Blocks Mask Critical Runtime Bugs (The version.ts ESM lesson)
- Context: Elimination of empty catch blocks across runner and host modules.
- Symptom: Modules ran with hidden failures that never surfaced in logs or test outputs.
- Cause: Blind `catch {}` blocks were used under the assumption of "safe non-blocking fallback", but in reality they masked broken ESM bindings (`require is not defined`, `__dirname is not defined` in `version.ts`), broken lockfile permissions, and unhandled child process errors.
- Use next time: Strictly obey AP-022. Never write empty `catch {}` or empty `cp.on("error")`. Check specifically for expected non-fatal error codes (e.g., `ENOENT`, `ESRCH`, `EBADF`), and log all other errors with component prefixes and `{ cause }`. When silent catch was replaced in `version.ts`, an ESM bug that existed since Cycle 60 was immediately discovered and resolved.
- Evidence: `src/runner/version.ts`, `tests/session-storage-errors.test.ts`, `docs/arch-improvement/ledger.md` (Cycle 87).

## 2026-10-12 - Host-Side Orchestration vs. Worker CLI Spawning (AP-010 / AP-020 Ports & Adapters)
- Context: Synchronizing in-process Pi Durable subagents with Beyond Boundaries sidebar threads.
- Symptom: Subagent tool tried to spawn external `bb thread spawn` CLI from inside the runner worker process, but failed due to missing CLI environment (`BB_THREAD_ID`, required `--project`), leaving no subthread and violating domain purity.
- Cause: Placing platform orchestration (CLI calls, thread creation) inside execution tool runners couples the domain engine with the host environment.
- Use next time: Strictly follow Ports & Adapters. The runner only emits structured task metadata (`api.details({ conversationId, task })`). The Host Bridge (`src/host/subthread-spawner.ts`), which lives in the BB platform environment, intercepts the event and orchestrates the creation of the child thread, linking it to the active session mirror.
- Evidence: `src/runner/subagent.ts`, `src/host/subthread-spawner.ts`, `tests/host-subthread-spawner.test.ts`, `tests/subagent-timeline-ordering.test.ts`.

## 2026-10-12 - Async Subagents, Role Envelopes & Removing Toy Upstream Limits
- Context: Subagent exploratory loops and blocking parent freezes (Cycle 89).
- Symptom: Child subagent called with level 2 nesting went into a 20-turn exploratory spiral calling `tool_search`, `codemode`, `find`, `git status`, and `read`, freezing the parent chat.
- Cause: Two compounding issues: 1) The upstream example code line `extensions: { remove: [Subagent] }` was copied verbatim, stripping the tool and making nesting impossible; 2) The child conversation was created without a Role Envelope (`instructions`), leading the LLM to think it was the root orchestrator and panic when a tool was absent; 3) `subagent` synchronously blocked on `await submission.wait()`.
- Use next time: Subagents must be non-blocking (`background: true`) by default. Never copy toy demo constraints (`remove: [Subagent]`) into production harnesses. Always configure a strict Role Envelope in `instructions` for child conversations so workers know their boundary, solve the task, and return without triggering exploratory spirals.
- Evidence: `src/runner/subagent.ts`, `tests/subagent-async-envelope.test.ts`, `docs/arch-improvement/ledger.md` (Cycle 89).

## 2026-10-12 - Subagent Delegation Card Single-Source-of-Truth & Child Lifecycle Isolation
- Context: Subagent delegation cards in Beyond Boundaries timeline and end-to-end multi-conversation streaming.
- Symptom: Task prompt repeated twice in parent timeline (at card opening and inside card message body); child subagents in sidebar threads never received streaming deltas or turn boundary completions.
- Cause: 1) `BBChildEventAdapter` forwarded the initial child `message_start` as an assistant `text_delta` under `parentRef`, duplicating what `item.open` already displayed in `summary` and `label`; 2) `BBChildEventAdapter` was missing `conversationId` decoration, preventing Host Bridge from resolving `childThreadId`; 3) Child `run_end` was suppressed, leaving child sidebar threads hanging without `turn.boundary: completed`; 4) Unfiltered forwarding of child `agent_end` to parent translator caused premature parent turn completion.
- Use next time: Keep delegation card summaries clean — never echo user prompts into child text deltas when `summary` already carries the task. Always propagate `conversationId` through child adapters to host bridge. On child `run_end`, emit `agent_end` decorated with `conversationId`, and strictly filter it in `session.ts` so child subthreads complete their turns without prematurely closing the parent turn.
- Evidence: `src/runner/bridge/bb-child-event-adapter.ts`, `src/host/session.ts:167`, `tests/subagent-timeline-ordering.test.ts`, `tests/subagent-dual-stream.test.ts`, `docs/arch-improvement/ledger.md` (Cycle 90).

## 2026-10-12 - Rejection of Declarative Graph DSL: Atomic Primitive Invariant (YAGNI & Unix Philosophy)
- Context: Proposal to add `tasks: string[]` and `chain: string[]` directly into the `subagent` tool schema.
- Symptom: Risk of creating a proprietary, bloated mini-framework/DSL inside the provider harness for task graph execution.
- Cause: Overengineering provider boundaries. LLMs and human orchestrators already possess native multi-tool parallel calls (`tool_calls` fan-out) and sequential nested calls for pipelines.
- Use next time: Keep provider tools atomic (`subagent({ task, background })`). Do not invent custom graph DSLs with string interpolation (`{previous}`) inside the tool runner. The provider's sole responsibility is robust lifecycle, SQLite persistence, and UI streaming; composition belongs to the agent.
- Evidence: `docs/superpowers/specs/2026-10-12-prd-pi-durable-native-subagents-and-composite-threads.md` (Section 6), `docs/arch-improvement/ledger.md` (ADR-90-1).





