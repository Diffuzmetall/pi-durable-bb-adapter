# SDK definition LEAF candidate — SOURCE ONLY / needs_checks

Owner IvoryBridge; root RusticCanyon alone orchestrates/accepts. Authorized bounded source-only slice under this NEW directory, lease280. No Stage2 product implementation, runtime.ts seam/API, original provider/main/host imports or activation are authorized. Accepted DOC6/Stage1/UNIT004/FS18 remain untouched.

## Finite deliverable and boundary

Exactly five files: `probe.mjs`, `pin-manifest.json`, `README.md`, `source-checks.json`, `checkpoint.json`. Fresh private empty environment directories live at `.private/refusal-001/`; no private config is populated or read. No dependencies, loader copy, framework, bundle, MCP shim, SDK double/fake export, RPC handlers or platform implementation. Node builtins only in the harness. Target imports are dynamic and unreachable without BOTH sole argument `--execute-leaf` and environment marker `BB0_SDK_LEAF_GO=sdk-definition-leaf-v1`. That marker is a deliberate admission interlock, NOT authentication, actual coordinator permission, or confinement proof. A separate root execution GO is still mandatory.

`--refusal-self-test` checks four pure admission refusals without calling the execution function, even if a marker is present. Ordinary absent/wrong/unknown admission exits77 BEFORE reading target pins or importing/evaluating/defining SDK/Zod. This is not a target behavior test. Node `--check` parses only; it does not evaluate imports. No positive target test has run.

## Actual pinned sources and minimal fixture

- Exact public BB packaged `server/dist/plugin-sdk-runtime.js`: SHA256 `62c27b9bbb127417f2c3e13494289fd36f999c09614c120826785955935d4126`; actual static imports only `node:module`, `node:path`, `node:url`. It creates a local require at top level. Source lines819–822 define the real identity function `defineRpcContract(contract) { return contract; }`; trivial body does NOT establish full module effect safety. Version0.6.37 is build provenance, not a version export assertion.
- Real public donor Zod4.6.5 root `index.js` plus finite95-file relative-import/reexport JS closure, individual bytes/hashes in manifest. Sorted absolutePath TAB sha256 LF map SHA256 `b54753d60453a9944906ba0c666040116ebedc33aadeb8fc042b18ce4a37b917`.
- Original shape source ONLY: `candidates/provider/src/rpc/contract.ts:5–12`, pinned but NEVER imported. Fixture uses precisely `{ diagnostics_get: { input: z.object({}).optional(), output: z.object({ report: z.custom() }) } }`; original `PiDiagnosticsReport` generic is TypeScript-only and erased, not replaced with invented runtime validation. Synthetic report data only. No diagnostics_get/RPC method/handler is invoked.
- Future real `defineRpcContract(fixture)` must return EXACT fixture identity with identical input/output schema references and exact keys. Real Zod positive parses for optional input and synthetic report, negative null parses, and actual Standard Schema validate-function presence are asserted. `z.custom()` without a predicate does NOT validate PiDiagnosticsReport fields. These are PLANNED assertions, not observed successes.
- Two exact public package metadata files are separately pinned. Target module URL allowlist has96 JS files plus three SDK builtin URLs. Harness builtin imports occur before guard installation and are not misrepresented as guarded target evaluation.

Static closure reconstruction is a regex inventory, not AST/import-effect proof. Apparent `zod`, `zod/compile` matches are source comments, not runtime imports in the previously inventoried closure. Future native synchronous Node24 `registerHooks` defaults deny all other resolved URLs, verifies ORIGINAL bytes/hash/format again on load, and returns unchanged native loader output. No resolution fallback, transformed source, handbuilt bundle or original BB resolver is supplied. If a target dependency/format/guard is unavailable, STOP; do not widen or shim automatically.

## Observed effect surface and event ordering (future, NOT executed)

Guards throw and increment named attempted-call counters on ordinary public FS/fs.promises functions, DNS, child_process, network/socket/server constructors and connection/listen/request methods, workers/MessageChannel, global fetch/WebSocket/EventSource/timers and selected process resource methods. Builtin ESM exports are synchronized. Target stdout/stderr writes are blocked; the harness retains one earlier stdout writer for structured receipts. Counters fail even if a target catches the exception. Present but unpatchable function surfaces fail closed; absent/nonfunction/getter-only entries are skipped and NOT coverage. Every actually patched function has a named zero-initialized attempted-call counter, and the installed function count is recorded. Guard installation rollback and finally restoration are implemented.

Event sequence: admission/environment strings →96 source pins +2 metadata pins →ordinary-effect guards →URL/load guards →cold SDK import →cold Zod import →real schema construction →real defineRpcContract →identity/schema assertions →zero observed forbidden attempts. Resolution/load URLs and original loaded hashes correlate to manifest. Per-process coldness requires a fresh Node process with no flags/preloads/NODE_OPTIONS. Failure is `LEAF_FAILED_OR_UNAVAILABLE`, not a silent partial pass; success candidate label is `LEAF_OBSERVATIONS_NEEDS_INDEPENDENT_CHECKS`, NEVER BB0/Stage2 PASS.

These public JS wrappers are NOT an OS sandbox or complete effect monitor: native bindings, module-loader internal source/metadata reads, process.binding, already-captured references, inherited/getter-only/unlisted methods, low-level/native/internal resource paths and late asynchronous work can escape this observed surface. Missing optional public methods are not universal coverage. Guards are armed only across target imports/definition/schema checks, not arbitrary future callbacks. Internal source-loader reads are expected; zero public guarded calls is not zero filesystem syscalls. OS confinement and independent negative controls are REQUIRED; no assertion here proves authentic BB loading or compiled preflight ordering.

## Existing sandbox source inspection: precise HOLD

Inspected actual admitted `evidence/BB0/lead-sandbox.py`, NOT executed or modified. It has an EXISTING explicit command port: optional `--cwd provider|host`, then `--` and admitted command argv. It creates NEW private `run-*` state under lead-private/.cache, maps fresh HOME/TMP/XDG/agent to `/bb0-state/*`, uses bwrap `--unshare-net`, `--unshare-pid`, drops capabilities, no root bind, remounts `/` readonly and clears environment. Network flag refuses host networking. Do not use `--probe` (imports host/config modules), `--boot` or `--baseline` (fixed commands and broader mounts/build behavior). The Stage1 run-units wrapper has fixed test commands and REUSES old QA HOME, so it is unsuitable.

Nonbaseline readable roots include the real donor `bb-provider-shared-0.2.29/node_modules`; Zod95 should be visible by static mount ancestry. The exact packaged SDK JS, its BB app package metadata and NEW evidence probe/manifest are NOT mounted. The current supported port has NO arbitrary public RO-mount flag. Therefore **HOLD: actual leaf execution unavailable with the frozen admitted namespace**. No bwrap, namespace, new profile, wrapper or FS18 modification was performed. Visibility is source-derived, not a fresh live namespace check.

Proposal ONLY for root review, preserving frozen FS18 and the existing bounded UNIT runner: explicit RO visibility of these FOUR files at identical absolute paths:

1. NEW `evidence/BB0/sdk-definition-leaf-probe/probe.mjs`.
2. NEW sibling `pin-manifest.json`.
3. `/home/ubuntu/.bb-server/app/node_modules/bb-app/server/dist/plugin-sdk-runtime.js` ONLY, not the BB app/node_modules tree.
4. `/home/ubuntu/.bb-server/app/node_modules/bb-app/package.json` ONLY, required public module-type metadata.

No new Zod mount is presently proposed because its exact root is already under an admitted readonly mount; confirm inside the eventual approved namespace. If another actual frozen UNIT command port exists, root may designate it and inspect it rather than invent flags. No such alternate port was verified here. Execution also needs fresh state/cache/CPU/log path leases and an external confinement receipt; current source-only lease grants NONE of that outside this directory.

### Future invocation proposal — DO NOT RUN in current scope

After distinct source review, exact mount/sandbox approval, CPU/execution GO and fresh-state authority, use the EXISTING command-argv port (the following does NOT add mounts and CURRENTLY WILL NOT WORK):

```text
/usr/bin/python3 evidence/BB0/lead-sandbox.py --cwd provider -- /usr/bin/env BB0_SDK_LEAF_GO=sdk-definition-leaf-v1 /home/ubuntu/.nvm/versions/node/v24.19.0/bin/node /home/ubuntu/Projects/pi-durable-bb-adapter/evidence/BB0/sdk-definition-leaf-probe/probe.mjs --execute-leaf
```

Capture external namespace/readonly/network/private-state evidence with the already admitted UNIT confinement verifier, not this process's env-string checks; verify actual supported verifier before execution. No new sandbox platform or command arguments are implemented here. Do not reuse finished QA HOME/TMP/XDG. Do not run a broad BB server/CLI or mount credential/config/private SQLite/Pocket data.

## Separate future behavioral QA obligations

Root assigns independent exact-source review first (source/manifest hashes, closure and admission reachability; guard rollback/restoration, original-byte load pinning, fixture fidelity and failure records). Then separately authorized confined behavioral QA: admission refusals; guard canaries/attempt counters without real resource effects; unknown URL/query/unpinned/changed source rejection; input identity/key/schema assertions against REAL SDK/Zod; exception and import failure paths, partial guard failure, every event-order assertion, zero forbidden attempts including caught attempts. Prove mutants disabling admission/URL/hash/zero-count/identity/schema/order checks are detected. Do not introduce SDK doubles to obtain these results. Record exact hashes, Node/env/UTC/exit/stdout, external confinement and fresh-state disposition. Inability to mount/evaluate is HOLD, not PASS.

Even a fully checked LEAF result will NOT close: original provider contract evaluation under authentic BB resolver hooks, provider's donor0.6.15 versus actual BB0.6.37 resolution, original static import preflight ordering, compiled artifact ordering, capability provisioning, peer/trusted BB identity, C-access policy/seam, synthetic native owner/catalog, build/install or full BB0. No new product API, host or provider changes.
