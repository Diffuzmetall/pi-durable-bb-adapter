# Stage1 shared-required refusal fixture — needs_checks

This is a NEW fixture-only contract, not an existing BB flag/settings interface. It is single-session TEST ONLY. Positive catalog, socket attachment, runtime, full build, installation and real BB identity admission remain UNAVAILABLE / NOT_REACHED and require separate GO. No native owner, Harness or SQLite is allocated here.

## Inputs and provenance

- Immutable baseline: `candidate-manifest.json`, SHA-256 `cf4e31a9e48a2286b507f59c7a53b32ce4947e16bc6275c482686873f7a59645`; provider 0.2.29, 191 files; host 536 files. Materialization verifies every provider input against that inventory before writing a fresh private copy. Accepted candidates, managed fixes, UNIT, raw003, derived files and launchers are not edited.
- Origin: `/home/ubuntu/.local/share/pi-durable/bb-provider-shared-0.2.29`, through the accepted `candidates/provider` copy. Original notices and source are retained. This managed package does not declare a license in package.json; no redistribution license is inferred. Publication/redistribution is not authorized.
- `overlay-v1.json` contains explicit, unique literal patches for eight baseline files. `overlay/fixture-admission.mjs` is the only new variant module. `materialize.mjs` copies pinned source and applies these inputs; it is NOT a builder, transpiler, replacement provider or compatibility shim. It copies no dependencies, dist or Git state. Materialized files have mode 0400.
- The unit harness uses existing read-only donor Zod 4.6.5 (MIT), with pinned package/entry hashes in `tests/effects.mjs`. Actual loaded dependency file hashes are logged. No npm operation, downloads, version fallback or installed edits occur.

## New private declaration and refusal boundary

`prepareFixture` allocates UUID-v4 K (`bb0_<uuid>`) before publication. It creates fresh 0700 directories and 0600 binding/admission files with exclusive creation. It explicitly strips inherited directory setgid on these new directories only. `admission.json` is written last. B contains the existing-format `shared-host.json`: `{ "socket": S }`.

The declaration's exact fields are version, mode, fixtureId, sessionKey, expectedThreadId, bindingDirectory, cwd, socket, createdAt and expiresAt. Mode is `shared-required-stage1`. K is not timestamp-guessed. B must equal `<F>/bindings/K`, C `<F>/work`, S `<F>/s`; S must fit a Linux pathname UNIX socket (at most 107 bytes). Lifetime is at most five minutes and must be current. Private F is pinned into the materialized module, never obtained from global config or a fallback environment variable.

Validation rejects unknown/missing fields, inconsistent K/B/C/S, stale dates, symlinks, foreign UID, wrong modes/types and noncanonical paths. File reads use O_NOFOLLOW and compare descriptor identity/ownership/mode against lstat. Private admission and binding files must be regular, single-link and at most 64 KiB. No directory, mode or binding is repaired by admission.

`validateDeclaration` and real-file `admitPureFixture` have successful unit cases. They explicitly return runtimeAdmission=UNAVAILABLE. `admitPrivateFixture` additionally requires private socket metadata; Stage1 does NOT connect or establish liveness. Every operational `refuseFixtureEntry` path stops even after valid metadata with STAGE2_NOT_ADMITTED. Missing/stale real sockets cannot cause local fallback. This is not a native socket authentication or race-resistance proof against arbitrary same-UID writers.

## Actual patched entrypoints

- `server.ts`: private preflight before metadata registration; diagnostics_get refuses before dynamically importing local diagnostics. Unit SDK metadata registrations are test doubles, not a BB registration proof.
- `src/host/index.ts`: refuses before dynamic bridge import and process-handler registration.
- `bridge.ts`: refuses at the real request boundary, before discovery/catalog access or createOrGet. Refusal uses the existing JSON-RPC -32000 error path. Fork database import is lazy and unreachable.
- `discovery-handler.ts`: direct discovery calls refuse, including model/list autoprewarm, health, diagnostics and installation. There is no fabricated healthy/default catalog response.
- `catalog.ts`: start refuses before extension lookup or RunnerProcess construction; diagnostics import is lazy; health refuses outside its legacy catch. No local model setup runs.
- `session-registry.ts`: createOrGet refuses before importing/constructing PiThreadSession or storage-path/resource setup. Reconciliation refuses before existing-session access/close. The actual implicit turn router is exercised against this registry.
- `runner-process.ts`: direct constructor refuses before runner-path lookup or spawn.
- `src/runner/index.ts`: pure CLI parsing then refusal precedes dynamic imports of all runtime/resource modules, including direct --no-session. Version flags do not bypass the gate. Existing transport and runtime bodies are retained but unreachable in Stage1.

The guard records a static boundary label in refusal errors. Tests require the first bridge/catalog boundary, not merely any downstream denial. This closes a discovered test blind spot where two gate-removal mutations survived because another guard still refused.

No new module-scoped runtime/resource instances, new transport, unrestricted runSharedHost catalog forwarding, core port, scheduler, child projection or general authorization layer is added. Any later catalog adapter must be bounded/disposed and permit ONLY get_available_models/get_state, never prompt/steer/abort/set_model.

## Identity limitation — NOT_REACHED

Legacy providerThreadId/sessionKey DO exist. They are opaque provider routing keys, not trusted requester/BB identity. The wire request's `params.threadId` can distinguish unequal synthetic thread IDs; the method name distinguishes thread/start from thread/resume at the wire level. Neither proves a trusted initial admission, legitimate persisted reopen, or a second fresh request claiming the same ID.

The NEW expectedThreadId field is supplied by the synthetic fixture only. It is not a supported API for selecting a real BB thread ID. Tests reject other thread/key values, child-composite keys, cwd changes and environment overrides; matching IDs still receive Stage2 refusal. No first-observed claim, process-local Map, or preallocated K/B/document is presented as durable identity, authorization or native-owner allocation. Actual initial/reopen/second-thread binding is NOT_REACHED pending a separately approved trusted provisioning/persistence contract.

Registration denial contains no cleanup and does not contact, stop, abort, delete or open a preexisting owner's SQLite/socket/lock. Tests create no SQLite or host owner; all new synthetic resources and failure artifacts are retained. Real existing-owner detach safety is not claimed as a new runtime result.

## Tests and replay

Acquire your own approved source/output and CPU leases before replay. Do not run this as a BB CLI/install/build command. Run from project root:

```
bash evidence/BB0/shared-required-fixture/run-units.sh UNIQUE_TAG units
```

The retained shell runner records the exact env-i Node24 command, UTC interval, exit and log. HOME, both Pi aliases, all XDG roots and TMP are fresh/private; no credentials or BB config are inherited. The candidate never reads real Pi configuration/auth. Named baseline/mutation modes are TEST-HARNESS controls only, not candidate flags.

Tests invoke the materialized real bridge, discovery handler, catalog methods, registry methods, implicit turn router, direct RunnerProcess constructor, host entry, direct --no-session runner module and registered diagnostics_get handler. No replacement provider implementation is used. SDK contract/metadata modules and forbidden runtime modules are explicit test doubles; existing Zod executes normally.

Effect probes intercept forbidden imports/resource initializations/spawns/session construction/storage opens/submits/socket connects/config reads. Canary calls prove each probe is live; then every refusal case requires all counters zero. In the 28 primary refusal fixtures, tests compare this unit process's /proc children before/after and require no SQLite/storage locks anywhere in each fixture. These are process/store absence checks at the unit boundary, not real native runtime integration.

Native socket creation/connect is deliberately NOT_REACHED. A valid pure declaration/file admission succeeds without a socket. Additional socket UID/mode/Stage2-fence cases use explicitly labelled lstat/realpath metadata fault injection, NOT a live socket or native owner. Foreign UID cases are metadata injection because no privilege escalation/chown is authorized.

`007` baseline control must fail. Early `009`/`010` gate-removal runs survived redundant downstream guards and are retained honestly; strengthened boundary assertions kill them in `015`/`016`. Final mutation runs include eager runtime import, bridge/catalog/registry/diagnostics/runner-constructor gate removal and always-deny pure admission. Expected mutation exit 1 means rejection of that mutant, not a product success.

`parity-before.json` / `parity-after.json` compare all 727 accepted source hashes plus 20 frozen artifact hashes. Raw003 private-cache coverage is metadata only, to avoid reading frozen Pi configuration/auth/store contents; public raw result and sample files are byte hashed. No claim of a fresh private raw-cache byte scan is made.

## Remaining gates

Independent exact-candidate review and behavioral QA are pending; parent arranges both. Same IvoryBridge session owns corrections. Stage2 native socket/catalog/namespace checks, Stage3 supported full build/closure and subsequent installation admission all require separate GO. Source-unit success does not certify BB SDK bundle/import ordering, compiled artifacts, actual BB worker environment/identity, native socket liveness, real UI timing/visuals or full BB0 acceptance.
