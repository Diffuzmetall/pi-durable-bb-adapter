# BB3 durable binding-store Lead receipt

- Task: `bbup-3-binding`; implementer: Agent Mail `GreenBirch`.
- Requested model/runtime: `openai-codex/gpt-6-luna`, thinking high. Effective model telemetry unavailable/unknown; not a work gate.
- Writer leases: 620 (`candidates/parallel-bb3-store/host/**`) and 621 (`evidence/BB3/store-luna/**`), exclusive through 2026-10-16T13:47:13Z.
- SDK: installed `@earendil-works/pi-durable` 1.2.0, read-only.

## Exact store candidate

- `candidates/parallel-bb3-store/host/src/binding-store.ts` — SHA-256 `b38b41bc489038a53fa1ee753af5eb781fe1e2f0891825bd2e75315bfaa28d11`
- `candidates/parallel-bb3-store/host/tests/binding-store.test.mjs` — SHA-256 `1981cac34caad733931bf61a2674e8927ed7311e0079fc794f7588cbebd809e7`

Exports:

- `DurableBinding`: `backendId`, `sessionId`, `conversationId`, `bbThreadId`, optional `parentThreadId`.
- `DurableBindingIdentity`: identity tuple `(backendId, sessionId, bbThreadId)`.
- `DurableBindingStore.put(binding)`, `.get(conversationId)`, and `.findByThread(identity)`.
- `createDurableBindingStore(session: Pick<Session, 'commit' | 'snapshot'>, context: Context)`.

The store atomically persists a conversation-scoped `bb.native-child-binding` document and a session-scoped identity index through Durable SDK `Session.commit` + `Tx.doc`; reads use `Session.snapshot`. `findByThread` resolves the tuple in the owning Durable session and verifies the referenced conversation document matches the tuple. This is identity persistence only, **not authorization**; callers must authorize from a server-bound principal. No requester assertion is accepted.

## Fresh self-checks

1. `/home/ubuntu/.nvm/versions/node/v24.19.0/bin/node --test candidates/parallel-bb3-store/host/tests/binding-store.test.mjs` — exit 0, 2/2 pass. The real SDK 1.2.0 + SQLite tests exercise close/reopen persistence, idempotent writes, tuple lookup after reopen, wrong-session/missing-thread misses, malformed tuple rejection, conflicting binding and duplicate thread rejection, and missing Durable conversation rejection. Raw output: `unit.stdout.txt`.
2. `/home/ubuntu/.local/share/pi-durable/bb-provider-shared-0.2.29/node_modules/.bin/tsc -p /tmp/bb3-store-tsconfig.json` — exit 0, no diagnostics. Raw empty output: `typecheck.stdout.txt`.

## Concrete remaining defect

The binding lookup now supports a consumer's BB-thread→Durable-conversation resolution, but the actual shared-host child-history attach/control route does not yet consume it. The store does not establish trusted requester identity or permissions. I contacted BB3 consumer/host-route and Core producer Leads directly with the exact export; no integrated candidate or trusted-principal API has been confirmed in this receipt. Do not claim end-to-end BB3 acceptance, record→binding crash consistency, authorization, or child-history/control behavior from these store checks.
