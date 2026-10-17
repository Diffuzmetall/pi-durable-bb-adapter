# bbup-1.2 actual executable overlay handoff to integrate-pi-sol / GreenIvy

Prepared actual BB server+daemon executable package, not another Hono-only application. Root: /home/ubuntu/Projects/pi-durable-bb-adapter/.pi/fixtures/core-sol/executable/node_modules/bb-app. Whole existing local dependency tree copied into sibling node_modules; all links remain inside owned fixture. No installed files, production stores, credentials/config contents, Pi Host Core, ports or processes modified.

Version distinction: copied installed bb-app0.46.0 base bundle commit UNKNOWN, pinned by exact server SHA d5c282329b50697f20ecba123dfe90ed4f9cda6161f9424847b1c0f82a601550 and daemon SHA acd96560885bf5410af4a53e8cba774f31cac1849ed9d94a3fccc5d56742c163. Do not claim the installed base was compiled from 4c87fdec. Tested overlay source is official Core4c87fdec/SDK0.6.37 at private commit af4354da38153e743137467e2c1f3bfb2557deba. Copied installed runtime's matching better-sqlite3 wrapper/native is13.0.3; Node24.19 :memory: SELECT1 smoke passed. This is NOT13binary with12wrapper; earlier pinned-source test driver12 remains separate.

Deterministic owned-copy recipe candidates/parallel-bb-core/executable/prepare-overlay.mjs SHA9440f59f8bfdd45b5ad8b4e78d740c2099d27a15ae758680fa5b7df213f8d482 requires exact base hashes and all ten tested source pins, extracts actual tested route/helpers/query/dispatcher/registrar code, compiles only two small support modules with existing private esbuild0.25.12 (65ms/124ms logged), then patches only owned distribution copies at exact unique anchors. Originals retained as .original files; rerun refuses non-base fingerprints rather than overwriting or silent fallback. No full main compilation or dependency install was performed.

Actual server entry server/dist/index.js imports owned patched start-server.js. The patched real registerInternalHostRoutes receives nativeInstallRegisterExisting using its existing Core repos/auth/Drizzle tables/functions; its real createThread repository gains caller-supplied deterministic ID, retaining existing atomic plugin metadata transaction. Actual daemon minified handleStdoutLine now routes reverse thread/registerExisting through extracted tested dispatcher with actual process/identity resolver; actual environment RuntimeManager/app/ServerClient callbacks are patched to daemon-owned HTTP registrar. Provider-maintenance runtime unchanged. No fake context/repository or alternate model runner.

node --check PASS for both patched executable bundles and both compiled support modules. Six exact wiring assertions PASS; all eight entry/side/worker fingerprints in launch-manifest.json SHA ec8f8324528c90d816f95a1909bc550d9aa1eec2f99e597f85656d14ea278814. output-manifest.json SHA dd7dffb3eedf82d87dd9f30ab3abcfe731e8fcc8993cbc2df44099c0f454e77f. Static checks and native memory smoke are NOT main-boot/runtime route acceptance.

Deployment and restart belong ONLY to GreenIvy, on .test-bb40886/40887 after one frozen combined main command/fresh GO and real shared-resource token. Do not let original installed launcher roots silently select unpatched code. Existing public copied launchers compute packageRoot from their own import.meta.url and select owned server/index and daemon-bundle. From static launcher source, compatible invocation shape is:

```
NODE=/home/ubuntu/.nvm/versions/node/v24.19.0/bin/node
APP=/home/ubuntu/Projects/pi-durable-bb-adapter/.pi/fixtures/core-sol/executable/node_modules/bb-app
DATA=/home/ubuntu/Projects/pi-durable-bb-adapter/.test-bb
BB_DATA_DIR="$DATA" BB_SERVER_PORT=40886 BB_HOST_DAEMON_PORT=40887 "$NODE" "$APP/dist/bb-server.js" --data-dir "$DATA" --server-host 127.0.0.1 --server-port 40886
BB_DATA_DIR="$DATA" BB_SERVER_PORT=40886 BB_HOST_DAEMON_PORT=40887 "$NODE" "$APP/dist/bb-host-daemon.js" --server-url http://127.0.0.1:40886 --host-daemon-port 40887
```

These are process roles, NOT a combined shell command to run sequentially in foreground. Integrator chooses owned supervision/cleanup, preserves test enrollment and existing host identity, and supplies test-only auth through existing daemon-owned mechanism without exporting it. No auto-update/install flags or production/global data roots. Integrator should verify its actual resolved entries/argv before admitting main run; do not execute these independently on occupied ports.

Required next real evidence under integrator main GO: server boot actually includes authenticated native endpoint (invalid/missing auth401, not404), actual daemon forwarder reaches it from provider process and registered child persists/opens with actual history, correct mapped parent/provider and one execution. Neither executable has been booted by FoggyShore; actual served-route/main-composition PASS is pending and must not be inferred from private handler test or syntax checks. Consumer adds parentProviderThreadId from mapped provider parent; reply remains correlated {threadId}. No other features resumed.
