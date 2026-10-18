# Pi Durable for Beyond Boundaries

A BB provider that runs new conversations in an **admitted native Pi Durable SDK 1.3.0 installation**, preserving its native global extensions and subagent owner. Native subagents get separate BB threads without an initial-prompt replay.

**Status: Linux x64 beta.** Tested against Node 24.19.x and one fingerprinted BB 0.46.0 build. This is an adapter around an existing native installation—not a bundled Pi distribution, a second scheduler, or a replacement for your terminal session.

## What runs where

- **Pi Durable** owns execution, SQLite, native conversations, tasks, extensions and subagents.
- **BB** is the client: prompts, history, controls and separate child-thread views.
- **This adapter** authenticates BB ownership, launches or reconnects a native CLI session, and translates contracts. It does not import the classic Pi `ExtensionRunner`, auto-discover `.pi/extensions`, or register another MCP/subagent owner.

A new BB root gets its own native session under the selected agent directory. It uses the selected native global configuration, but **does not silently attach to an already-running terminal conversation**. An existing terminal needs the explicit existing-session listener/attach path; do not restart it merely to install this plugin.

The provider/catalog compatibility dependencies remain pinned to SDK **1.2.0**. **Execution is native SDK 1.3.0**, checked separately at preparation and readiness. An unsupported native/model configuration fails closed; there is no managed-runtime fallback.

## Prerequisites

- Linux x64, Node `>=24.19.0 <25`, npm, Python 3, `tar` and `lsof`.
- A normal BB **0.46.0** standalone application directory. The compatibility preparer checks the exact build; the version string alone is insufficient.
- An already working native **SDK 1.3.0** CLI and its admitted `local-host` global composition, including the native subagent/read-service lifecycle. Stock/classic Pi extensions are not a substitute.
- Your native agent profile must already contain its normal models, authentication and safety environment (including the native DCG addon when enabled). These are deliberately **not** shipped or copied by this repository.

The native global/private extension release is an external prerequisite, not something the plugin downloads or automatically trusts.

## Install

### 1. Build the plugin

```sh
git clone https://github.com/Diffuzmetall/pi-durable-bb-adapter.git
cd pi-durable-bb-adapter
npm ci              # builds via the prepare hook
npm test
npm run doctor
```

The repository root is the portable package. `candidates/`, `docs/plans/` and older `evidence/` are development history, not alternative installation roots.

### 2. Prepare compatible BB code

BB needs a port for registering an **existing** native child without spawning it again. The plugin alone cannot add that Core capability.

```sh
node scripts/prepare-bb.mjs --bb-app /absolute/path/to/normal/bb/application
```

Keep the returned **private receipt path** (`receipt.json` beside the staged `app/`). Preparation verifies the archive and source fingerprints, stages ten compatibility overlays in a separate cache, and verifies unchanged migrations and original application files. It does **not** restart BB or open/migrate its data.

For a new isolated BB instance:

```sh
node scripts/start-bb.mjs \
  --stage /absolute/path/to/private/stage/receipt.json \
  --data-dir /absolute/path/to/new-private-bb-data \
  --server-port 40886 --host-daemon-port 40887
```

For an existing instance, first make a consistent backup and stop BB and its daemon normally **when idle**. Use its existing data directory and original ports; retain the original service command for rollback. The launcher refuses an active owner, occupied ports, unknown data roots or changed staged code. Never run two BB owners against one database.

Use matching CLI routing for that instance:

```sh
export BB_DATA_DIR=/absolute/path/to/private-bb-data
export BB_SERVER_URL=http://127.0.0.1:40886
export BB_HOST_DAEMON_PORT=40887
bb plugin build
bb plugin install "path:$PWD" --yes --json
```

The installer uses BB's normal build/install lifecycle. It does not publish anything or change repository visibility.

### 3. Admit your native installation

```sh
node scripts/prepare-native.mjs \
  --global /absolute/path/to/admitted/packages/local-host/src/global.ts \
  --sdk-root /absolute/path/to/native/node_modules
```

This produces a private `manifest.json` and an after-local-host addon. It pins the selected prerequisites, checks SDK 1.3.0, keeps the existing native subagent owner external, and does not start a model. The launch order is **existing native global first, addon second**; the addon never mounts the global again.

```sh
node scripts/configure-native.mjs \
  --operator-dir "$BB_DATA_DIR/plugins/provider-pi-durable/bridge-data" \
  --cli /absolute/path/to/pi-durable \
  --prepared /absolute/path/to/private/native/manifest.json
```

Configuration validates before replacement and retains an immutable backup. It starts no process. Normally use your existing native agent directory; optional `--agent-dir /absolute/private/profile` selects an already prepared profile, **not** a blank replacement for your native settings and guards.

Create a **new** BB thread using `pi-durable` and a model available in that native profile. First admission starts the selected CLI through a small PTY helper; later attachment reuses the recorded native session. A helper lock and live-owner check prevent duplicate launch. BB's authenticated Core identity is checked before native admission, history or controls.

## Verified flow and beta limits

The real native-primary test used BB prompt → native SDK 1.3.0 → native `subagent` → a separate Core-registered BB child. Opening that child and reloading showed the completed result without another user submission or increased native execution counters. See [the acceptance scope](docs/verification/native-primary-flow.md).

Important limits:

- **Legacy managed SDK 1.2 BB identities are not silently migrated.** They fail with `NATIVE_LEGACY_SESSION_REQUIRES_EXPLICIT_MIGRATION`. Their original history remains intact. Retain the previous provider revision for rollback; continuing those threads requires explicit migration or restoring the previous runtime. A new empty native session is not history migration.
- Projected existing native children are read-only in this beta. The accepted delegation case is a foreground native spawn; this is not acceptance of all background/follow-up delivery paths.
- The admitted UI history projector is deliberately bounded. The completed text-only case is verified; unsupported/richer native histories fail closed rather than being presented as complete. This is not a claim of full native transcript-format coverage.
- The compatibility catalog is not guaranteed to equal every native-global model factory. Choose a model in your native profile; missing native models fail rather than silently substituting another model.
- Failed/interrupted unsafe tool effects are **not** automatically replayed. Exactly-once admission does not guarantee exactly-once external side effects.
- Native agent permissions and guards remain authoritative. This adapter does not turn a full-trust native CLI into a sandbox.
- A failed native child report or an unavailable guard is not success. Correct the profile/configuration explicitly before retrying a safe read-only test.
- Automatic upgrades to arbitrary BB/SDK versions are unsupported. Rebuild and explicitly re-admit changed prerequisites; do not bypass fingerprint failures.

## Updates, rollback and safety

Retain the original BB application, provider revision, service command, private configuration backups and consistent data backup. Stop only the owned idle instance, restore the prior service/provider configuration, and reopen the same unmodified data root. Do not delete live stores, history, queued messages or backups. Never terminate an unrelated native terminal to activate this plugin.

The compatibility archive contains executable BB/vendor code, not user data. Its complete file hashes, licenses and staging targets are in [`compat/manifest.json`](compat/manifest.json); provenance is in [`NOTICE.md`](NOTICE.md). Treat extensions and prepared native artifacts as trusted executable code. Keep native manifests, owner grants, control sockets, private scan reports, account files and SQLite stores out of Git.

## Development

```sh
npm run build       # host artifact + runner
npm test            # focused and inherited regression suites; no live model required
npm run doctor      # package/build diagnostics
npm run check:catalog
```

A live native smoke test requires the separately admitted native installation and private operator configuration; it is not run automatically by CI. Historical PASS reports are not fresh acceptance of changed files. Public installation/support is bounded to the prerequisites above.

## License

MIT for this adapter; upstream attribution and vendor notices remain in [`NOTICE.md`](NOTICE.md) and [`licenses/`](licenses/).
