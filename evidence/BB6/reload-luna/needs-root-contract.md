# BB6.3 reload candidate — implementation and focused verification

## Candidate

Root's clarification admits the existing host-local `DurableExtensions.reloadWhenIdle` facade and its `#current` swap. BB5's actual bridge is `createPiToolRegistration(definition: ToolDefinition): ToolRegistration` in `pi-extensions/tool-bridge.ts`; sibling Lead CrimsonPrairie confirmed the path and that loader extension tool map entries expose `.definition` (Agent Mail #211).

This candidate now prepares reload candidates from BB5's real loader/bridge and wires the preparation into the existing `DurableExtensions` facade. Startup explicitly skips a second Pi prepare; user reload reconstructs the admitted Pi facet, excludes the previously installed Pi extension owners from the base copy, preserves native installed definitions, reapplies existing Durable adapters, validates, then swaps the facade once. Candidate failure and active-task refusal leave the old facade snapshot current.

Files:

- `candidates/parallel-bb6-reload/host/.pi/extensions/durable-reload/index.ts` — existing facade, optional Pi base preparer, one publish after validation, active-task check retained.
- `candidates/parallel-bb6-reload/host/packages/coding-agent/src/experimental/durable/runtime.ts` — runtime overlay: remembers installed Pi owner names, builds preparer from `options.piResources` and actual loader/bridge exports, avoids duplicate startup preparation.
- `candidates/parallel-bb6-reload/host/packages/coding-agent/src/experimental/durable/pi-extensions/reload-registry.ts` — candidate builder using existing SDK `createRegistry()`/`install()` operations only on an unpublished candidate; refuses failed/refused/conflicting resources.
- `candidates/parallel-bb6-reload/host/packages/coding-agent/src/experimental/durable/pi-extensions/reload.test.mjs` — focused real SDK/loader/bridge coverage.

## Checks

Node 24.19.0 focused test command:

```sh
BB5_SDK_ROOT=/home/ubuntu/.local/share/pi-durable/bb-provider-shared-0.2.29/node_modules/@earendil-works/pi-coding-agent \
PI_DURABLE_SDK_ROOT=/home/ubuntu/.local/share/pi-durable/bb-provider-shared-0.2.29/node_modules/@earendil-works/pi-durable \
JITI_FS_CACHE=0 \
/home/ubuntu/.nvm/versions/node/v24.19.0/bin/node --test \
candidates/parallel-bb6-reload/host/packages/coding-agent/src/experimental/durable/pi-extensions/reload.test.mjs
```

Exit `0`: 4 passed, 0 failed. Tests prove (1) real Pi extension loaded and its actual bridge registration is callable after exactly one facade publication, replacing an existing Pi owner while retaining native/task/document definitions; (2) actual loader failure leaves old Pi and native tools callable; (3) active-task refusal happens before candidate preparation and disposes the task graph; (4) the candidate `runtime.ts` opens the real Durable Harness on an isolated temporary data root, then its actual `controller.reload()` replaces the admitted Pi tool and refreshes the view inventory while preserving the native tool inventory.

The runtime test uses the real SDK 1.2 loader/bridge and candidate facade. `mcp: false` makes MCP inactive; only its otherwise-eager module import is stubbed by the test resolver. Active-task refusal remains verified at the facade task-graph boundary, not with a live background task in an open Harness. No model/network call is made. Temporary session/root data is removed by the test.

Syntax checks, exit `0`:

```sh
/home/ubuntu/.nvm/versions/node/v24.19.0/bin/node --check candidates/parallel-bb6-reload/host/packages/coding-agent/src/experimental/durable/runtime.ts
/home/ubuntu/.nvm/versions/node/v24.19.0/bin/node --check candidates/parallel-bb6-reload/host/packages/coding-agent/src/experimental/durable/pi-extensions/reload-registry.ts
/home/ubuntu/.nvm/versions/node/v24.19.0/bin/node --check candidates/parallel-bb6-reload/host/packages/coding-agent/src/experimental/durable/pi-extensions/reload.test.mjs
/home/ubuntu/.nvm/versions/node/v24.19.0/bin/node --check candidates/parallel-bb6-reload/host/.pi/extensions/durable-reload/index.ts
```

No live host, installed dist, or dependency mutation was performed. Git committed/pushed only the five owned source/test/evidence paths below; unrelated dirty and untracked work remains untouched. The existing `bbup-6-reload` Bead was reopened after the exact candidate changed, updated with the focused-scope evidence and then closed by its assigned Lead; no review/QA micro-Beads were created. Independent BB6 milestone review/E2E QA, cross-feature and live/performance acceptance remain unverified; the focused active-task refusal test uses the facade's taskGraph boundary, not a live background task in an open Harness.

**Private Git delivery receipt:** `gh repo view` confirmed `Diffuzmetall/pi-durable-bb-adapter` is `PRIVATE` before and after the implementation push; `origin` is the supplied private URL. On `work/bb-durable-upgrade`, pre-push local HEAD and remote branch SHA were `d84092784825e9c2b26f2669d2e12915c704ada9`. Fresh exclusive `.pi/coordination/beads-lead-git-index` lease 767 was granted to true Mail identity `IvoryStork` after the prior holder released/expired. The single logical implementation commit is `a20cd436daf5aea60e9dd2070dc26b0b8838ee0e` (`BB6.3: transactionally reload admitted Pi registry`), with explicit author and committer `Diffuzmetall <208909650+Diffuzmetall@users.noreply.github.com>`; `gh api user` confirmed the configured noreply account ID/login. The normal non-force push succeeded. At that push, `git ls-remote origin refs/heads/work/bb-durable-upgrade` returned exactly `a20cd436daf5aea60e9dd2070dc26b0b8838ee0e`, matching local HEAD. This implementation commit contains only the four owned source/test files and this evidence file. Staged whitespace check passed; the targeted credential-pattern scan found no matches; all five files are text. No other dirty/untracked work was staged or committed. This local post-push receipt update will be saved in a follow-up evidence-only commit; final branch-head SHA is recorded in the Bead to avoid self-referential commit metadata.

## Full candidate SHA-256 manifest

```text
ef241600ed70b55c5a5a0c8061b38e945c6236add91080d639cd7827944e1212  candidates/parallel-bb6-reload/host/.pi/extensions/durable-reload/index.ts
d32c186b270e4fe2f9da613c1cb91a12e968c256bd497f7a9a685897a610ac9d  candidates/parallel-bb6-reload/host/packages/coding-agent/src/experimental/durable/runtime.ts
ebe2aae1377d1203dcf2beb1569d22cad298ad34870ba131fe33165908f9adb8  candidates/parallel-bb6-reload/host/packages/coding-agent/src/experimental/durable/pi-extensions/reload-registry.ts
585518999a0b96833d2b019be6825e1caa03ec29726da12a62f86552b969a758  candidates/parallel-bb6-reload/host/packages/coding-agent/src/experimental/durable/pi-extensions/reload.test.mjs
```
