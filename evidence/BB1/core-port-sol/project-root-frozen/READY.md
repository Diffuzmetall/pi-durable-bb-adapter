# Project-root private fixture: frozen executable candidate

Actual private copies now live at .pi/fixtures/core-sol/native-port/ and .pi/fixtures/core-sol/sqlite-build/, inside the canonical project. Root and both directories have mode 0700. Originals under /tmp were only read and remain retained. All 1982 symlinks resolve inside the new fixture root; external better-sqlite3 dependency links now target the private SQLite source, and copied external binary symlinks were materialized as private regular files. The existing incompatible binary is only retained input, not claimed usable; the authorized build must replace it before tests. No symlink escape or managed dependency writes. Runtime TMPDIR/HOME/cache are also inside owned fixture root.

Product source unchanged. All eight overlay/test files plus config match scratch SHA256. Full fixture tree SHA256 255bd90093ed021d9db5af2769d4ccaf492fa3e067d902cc9efea5ca8237f65b covers 39532 regular files and 1982 internal links. Complete overlay/test/config pins and 51 SQLite inputs are in parity-manifest.json SHA256 42a4118d2283c68385d983ae6c32c51adb0aca12b598287d9325a9e7c4d8cee8.

ONE frozen recipe: candidates/parallel-bb-core/verify-project-root-sqlite.sh SHA256 a53c2821c2d7d0a29a8511e47be92b8a0406b82254dc5ea3a405ef8c382aee32.

Exact command, only after fresh GO and actual leases:

```
MEASUREMENT_LEASE_EXPIRES_AT='<actual measurement receipt expiry>' SOURCE_LEASE_EXPIRES_AT='<earliest actual owned source/fixture/evidence receipt expiry>' bash /home/ubuntu/Projects/pi-durable-bb-adapter/candidates/parallel-bb-core/verify-project-root-sqlite.sh
```

Required project-relative coverage: candidates/parallel-bb-core/**, evidence/BB1/core-port-sol/**, .pi/fixtures/core-sol/**; source/fixture/evidence TTL>=900. Acquire .pi/coordination/bb0-local-measurements exclusive FILE token LAST, TTL600. Confirm acknowledged authoritative coverage and remaining>=210 immediately before execution; perform no preparation after measurement acquisition. Recipe checks expiry again before consuming proposed nonce core-sqlite-project-root-frozen-20261016-d. One 175s owned process-group run plus 5s cleanup; wait and retained per-attempt logs. No disabled build slot API, feature enablement, alternate project/identity/transport or misleading reservation path.

Read-only preflight complete: Node24.19/system node-gyp11.4 executable, compiler/make/Python/timeout/setsid, Node header, actual local Vitest and SQLite binding/source present. Shell syntax passes. No build/test run. Old failure/nonce/logs preserved. Previous GOc is UNCONSUMED/SUPERSEDED by relocation and new recipe hash. New nonce not consumed. All fixture DBs/binaries/dependencies/caches remain private and must never be committed. No further source or fixture changes after this freeze before exact GO execution.
