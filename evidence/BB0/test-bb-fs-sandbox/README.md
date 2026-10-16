# Confined TEST BB launcher — 1.0.0-source-only

Status: **needs_checks**. Source/plan units only. No namespace, BB, PTY or Pi runtime was executed. This is a separate fixture; accepted sources, the old `.test-bb` profile and its instance are not changed. No existing receipt transfers to this profile.

## Files and exact identity

- `launcher.py`: actual plan / validate / verify-public / guarded launch entrypoints, stdlib only.
- `mount-manifest.json`: deterministic `plan --fixture-id source-v1` output, including launcher SHA256, mounts, explicit outer/inner environments and exact future argv.
- `public-pins.json`: 11,943 public installed dependency entries (file SHA256/mode or symlink spelling/resolution), 21 resolved RO file mounts and the outer bubblewrap executable pin. SHA256 `7ef4254c10b4d941d69b453a656f2ec0980a4b706f3c463d2d8b58f8f2ecc826` is embedded in the launcher.
- `pin_public.py`: static ELF64 x86_64 PT_INTERP/DT_NEEDED inventory using Python struct; no loader, ldd, readelf, subprocess, installed writes or namespace execution. This script only prints inventory. Updating pins is a source/allowlist change, never an automatic runtime repair.
- `test_launcher.py`: calls the actual launcher executable with isolated Python and fresh leased temporary HOME/cwd; valid plans pass. It also checks deterministic output, exact ports, foreign/private/overlapping/missing/symlink mount proposals, altered environment/PID/network/FD fields, malformed inputs and pre-execution refusal gates. No complete authorized launch invocation is tested or performed.
- `red.log`, `green.log`, `green-v2.log`, `plan*.log`, `validate.log`, `public-verify.log`, `pin-inventory.log`, `baseline-*.json`: retained checks. Initial RED is the missing launcher; initial inventory refused an absent terminfo path. Its installed public location was then explicitly pinned, not downloaded or covered by a wider mount.
- `needs_checks.json`, `final-manifest.sha256`: handoff and exact candidate file hashes.

## Confinement contract

Fresh root: `/home/ubuntu/Projects/pi-durable-bb-adapter/.test-bb/fs-private.<fixtureId>`. ID is restricted ASCII, maximum 32 characters; existing roots and symlink ancestors are refused before reading profile contents. BB_DATA_DIR is explicitly `<root>/bb-data`, never the old `.test-bb` spelling. Planning is pre-provisioning and creates nothing there. Launch alone may exclusively provision this root after separate parent GO.

Only this fresh root is RW-bound at the same absolute pathname. Private HOME/agent/XDG/temp/run/cwd are descendants. Private procfs follows the new PID namespace, and `/dev` and `/tmp` are new mounts. Root is remounted RO. Capabilities are dropped; a user namespace plus `--disable-userns` prevents child user-namespace creation. Nested bwrap inside BB is deliberately not promised. A separately authorized native owner can instead run in its own namespace.

RO application mount: **only** `/home/ubuntu/.bb-server/app/node_modules`. No parent `.bb-server` state is visible. Node24 is an individual resolved binary mount, not its HOME or global package tree. OS mounts are individual files: dash, bash, env, ps, their/Node/native-module static library dependencies, ELF interpreters and xterm-256color terminfo. Every source is resolved and pinned; requested aliases are mounted as files, not host directory aliases. See the exact manifest for all 21. There is no whole `/usr`, `/usr/bin`, `/usr/lib`, `/etc`, HOME, host `/run`, host temp/proc, old `.test-bb`, donor or native SQLite mount. No toolchain, synthetic account/config files or downloads are included: none has yet been proved required.

The future direct subprocess call supplies an explicit minimal **outer** environment to bubblewrap (no inherited HOME/loader variables), stdin DEVNULL, a new owned log for stdout/stderr, `close_fds=True`, `pass_fds=()`, private cwd and umask 0077. Bubblewrap clears and explicitly supplies the inner environment before direct absolute Node24 launches bundled BB. No shell precedes filesystem confinement. Unknown later HOME/SHELL/loader/startup values can address only exposed filesystem paths; absent files/dependencies fail, never widen mounts. This is not a claim of exploit-proof isolation or confidentiality through network services.

**Network is host-shared, NOT OS network isolation.** There is no `--unshare-net`, proxy or alternate port. Only 40886/40887 are accepted. Host browser/CLI loopback and server↔daemon traffic remain possible; all other host networking, including reachable host services/abstract sockets, remains a material limit. Launch checks that both fixed TCP ports can be bound before provisioning; this is not an atomic handoff to BB. Serialization plus BB's own bind failure is still required. No process is killed and no old state is inspected to free ports.

## Guarded future launch, NOT current authorization

Normal usage is `python3 -I -B launcher.py plan --fixture-id source-v1`, `validate` with that JSON on stdin, or `verify-public`. These are non-runtime entrypoints. A successful public pin check or plan validation is **not** a runtime capability PASS.

`launch` refuses before socket/process/profile operations unless all explicit acknowledgements are supplied: `--runtime-go --stage1-accepted --old-owned-instance-retired`, plus `--reviewed-plan-sha256` matching the exact canonical plan bytes. The plan itself includes this launcher's SHA256 and pinned dependencies. Flags are manual acknowledgements, NOT authorization tokens: only the parent can grant GO and verify Stage1, exact source/allowlist review, a narrow runtime lease and serialized CPU reservation. No environment variable silently arms launch. The script contains no stop/restart/kill/port-alternative path.

Even with acknowledgements, missing/mismatched reviewed SHA refuses before public verification or runtime work. After verified source/dependency pins and free-port checks, exclusive profile creation and direct bwrap invocation are the only runtime path. Partial/failed profiles and logs are retained; a retry cannot reuse or inspect one. A zero exit reports `runtimeCapability: UNAVAILABLE`, not acceptance.

**Do not invoke the authorized launch path now.** Old launcher/server/daemon remain frozen. Retiring only their separately proven owned PIDs requires its own parent runtime GO after Stage1 and this candidate's distinct checks.

## Future canonical owner/socket boundary

The manifest reserves (not activates):

- canonical `C`: `.test-bb/fs-owner.<fixtureId>/session`, held only by the native owner namespace;
- socketDir `S`: `<new BB root>/s`, socket `S/d.sock`, same absolute path in both namespaces, pathname length checked;
- BB sees S through its own root; the owner would receive only a separate directory bind of S plus its own C. Directory binding supports socket replacement; do not bind a socket inode.

No native SQLite directory is mounted into BB. C is metadata in this plan, not a mount or active runtime. A native-owner launch contract, permissions, socket reachability, binding/authentication and Stage2 correctness remain unverified. No Pi import/install is authorized by this fixture.

## Source-driven compatibility

Existing `test-bb-env-probe/start-private.sh:4–24` supplies the approved Node24/bundled BB CLI shape and safety flags. This new fixture reuses that command shape with a new explicit DATA identity; it does not execute, edit or remap the old launcher. Installed `bb-app/dist/bb-app.js:19992–20038` forks server/daemon through `process.execPath` and explicit inherited env, so the complete process tree remains inside its launcher's namespace. Installed `daemon-bundle.mjs:200–201` spawns terminal shells after daemon startup: the filesystem boundary now precedes those shells. The existing `lead-sandbox.py` host-network refusal remains byte-identical.

Installed BB package is 0.46.0. Absolute Node24.19.0 and BB/native outputs are content-pinned. Local `/usr/share/man/man1/bwrap.1.gz` documents the namespace, clearenv, bind, proc/dev and disable-userns options. Capability/LSM/setuid compatibility was NOT exercised.

Applied methods: AE IncrementalImplementation/TestDrivenDevelopment/SourceDrivenDevelopment; poteto Boundary Discipline (outer process boundary), Sequence Verifiable Units (RED→plan→refusals→public pins), Prove It Works (actual entrypoints, not copied helpers); ponytail (existing bwrap/bundled launcher + stdlib, no terminal/core/network layer).

## Checks and remaining gates

Executed only Python -I/-B source/plan checks with fresh private temp HOME/cwd under this lease. `green-v2.log`: 6 tests PASS, including 13 tamper cases and 6 unsafe mount proposals. `plan.log` and `plan-repeat.log`: byte-identical. `validate.log`: plan PASS. `public-verify.log`: exact current public pins PASS. `baseline-parity.json`: all 10 protected source hashes unchanged. The old runtime profile was not read or written; this does not assert new runtime parity.

**UNAVAILABLE**: complete runtime dependency closure (dlopen, NSS, subprocess tools, BB startup), user/PID namespace permission, private devpts/PTY function, Node/BB boot within mounts, actual environmental roots before shells, host loopback/API/UI, native worker, socket binding/identity, actual Pi execution, TUI/capture/visual QA and cleanup behavior. No optional mount may be added to silence a failure without a new exact allowlist/source review. New runtime acceptance must be separate and fresh; old receipts stay historical.
