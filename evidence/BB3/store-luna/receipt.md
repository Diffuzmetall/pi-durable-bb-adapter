# BB3 durable binding-store candidate — QA correction receipt

## Candidate and fix

- Independent finding: `qa-bb4-regression-luna` reported that reads failed to verify the stored binding's embedded `conversationId` against the requested ID / indexed ID, and returned unvalidated stored records.
- `candidates/parallel-bb3-store/host/src/binding-store.ts` — SHA-256 `e156704335b250930a2db237c929a984ad81ee710d014bdef00279d2815a7756`.
- `candidates/parallel-bb3-store/host/tests/binding-store.test.mjs` — SHA-256 `9aba059283565a24d76523f4b8a34fe396dc41dea2c57d6ba1ceb16d2f80cf2d`.
- Fix: both reads reject corrupt/malformed stored bindings and validate embedded `conversationId` against their requested/indexed conversation ID. `findByThread` then checks the validated identity tuple.
- New regressions corrupt the document through the actual Durable SDK `defineDoc` + `Session.commit` / `Tx.doc` APIs, for both `get` and `findByThread`. No fake session and no direct SQL.
- SDK: installed `@earendil-works/pi-durable` 1.2.0 at `/home/ubuntu/.local/share/pi-durable/bb-provider-shared-0.2.29/node_modules/@earendil-works/pi-durable`; `package.json` SHA-256 `2fc81a444940fff9fe12bad39540a5a88a9dbcf6049dfece77005c6a281d16ad` (read-only).

## Exact checks

1. Command: `/home/ubuntu/.nvm/versions/node/v24.19.0/bin/node --test candidates/parallel-bb3-store/host/tests/binding-store.test.mjs` — exit **0**, 4/4 pass. Raw output: `unit-final.stdout.txt`; exit record: `unit-final.exit`.
2. Command: `PATH=/home/ubuntu/.nvm/versions/node/v24.19.0/bin:$PATH /home/ubuntu/.local/share/pi-durable/bb-provider-shared-0.2.29/node_modules/.bin/tsc -p /tmp/bb3-store-tsconfig.json` — exit **0**, no diagnostics. Raw output: `typecheck-final.stdout.txt`; exit record: `typecheck-final.exit`. Config SHA-256: `b089d7ab98e840a4e7b25318b92faf33a0fbe6546dac011989739733122912b8`.
3. Red-before-fix command with pinned Node 24 — exit **1**, as expected: both new corruption regressions failed with “Missing expected rejection”; the two pre-existing tests passed. Raw output: `unit-red-node24.stdout.txt`; exit record: `unit-red-node24.exit`.

A separate accidental `node --test ...` invocation resolved PATH Node 20.19.4 and failed before tests loaded (`node:sqlite` unavailable); it is not test evidence. Retained transparently as `unit-red.stdout.txt` / `unit-red.exit`.

## Archived prior candidate

The superseded receipt and outputs are preserved under `archive/b38b41bc489038a53fa1ee753af5eb781fe1e2f0891825bd2e75315bfaa28d11/`.

- Prior source SHA-256: `b38b41bc489038a53fa1ee753af5eb781fe1e2f0891825bd2e75315bfaa28d11`.
- Prior test SHA-256: `1981cac34caad733931bf61a2674e8927ed7311e0079fc794f7588cbebd809e7`.
- Archived receipt SHA-256: `55e892f1cad2de9357cd9809d36b77eb3ea6fc51e42eecc39906d6ef0adc6ca9`.

## Scope and remaining status

This is a store-level correction only, not BB3 acceptance. The shared-host route still does not consume `findByThread`, and a trusted requester principal / authorization mapping is absent. The previous authorization, route integration, live, and full-milestone blockers remain. Terminal direct-execution QA was paused; no terminal candidate or installed bundle was changed or executed.

The candidate and recheck request were recorded on owned Bead `bbup-3-binding` as `lead-bb3-store-luna` using the managed `bd` CLI; exit **0**. Raw command output and exit record: `bead-comment.stdout.txt` / `bead-comment.exit`. No shared `.beads/issues.jsonl` export or manual edit was performed.

Requested next action: the same independent reviewer and QA checker recheck the affected candidate above; their previous verdicts do not carry to these hashes.
