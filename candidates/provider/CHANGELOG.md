# Changelog

All notable changes to the `bb-plugin-provider-pi-durable` plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- **Live Task Graph in BB's Plan Panel**: The runner forwards `harness.taskGraph()` to BB as `planSteps`, so the composer shows the chain of live tasks (`N/M complete`, in-progress first) instead of nothing. Rows follow creation order with children nested under their owner, and identical snapshots are dropped before they reach the wire.
- **Named Steps**: A step says what its task is doing rather than only what kind it is: a tool task takes the name of the call it runs (`#12 bash: echo alpha`, `#13 read: src/runner/index.ts`), and the harness tasks read as `assistant turn` and `compacting context`. A node carries no checkpoint payload (spec §9.5), so a tool task is named from its call's own start event, which names the task it belongs to. Names are clipped to one bounded line; an unnamed task still shows its kind and phase.

### Fixed
- **Runner Resolution Against a Foreign Install (Issue #18)**: bb runs this plugin's host bundle from `<dataDir>/plugin-host-artifacts/<pluginId>/<digest>/host.mjs`, with no runner beside it and without `BB_DATA_DIR`, so resolving the runner by guessing the data dir let an unrelated `~/.bb` checkout answer for the plugin bb had actually activated: the plugin ran older code while still reporting the new version. The data dir is now read back out of the bundle's own deployed path, and the search order is that installation, its `bb.db` row, its caches, then the legacy `~/.bb`. A caller that names its own db or cache paths gets only what it named.
- **Deterministic Discovery and Readiness Tests**: `resolveRunnerPath` no longer consults the machine's ambient installs when a caller passed explicit paths, so `runner-discovery` asserts a genuine "not found" error instead of failing on any machine that has the plugin installed. The catalogue-readiness test now allows the 12.1s a real runner needs to enumerate the configured providers (it was 10s) and clears its timer on success, so the budget stays a fail-fast ceiling rather than a hidden delay.

---

## [0.2.0] - 2026-10-07

### Added
- **Embedded TypeScript Runner (`dist/runner`)**: Migrated provider runner to a self-contained, high-performance TypeScript process communicating with BB over IPC file descriptors and standard JSON-RPC wire protocol.
- **Native Event Streaming (`watchEvents`)**: Subscribed directly to `@earendil-works/pi-durable` native transactional event stream (`watchEvents`), streaming turn lifecycle, thinking deltas, tool executions, and progress events with sub-millisecond latency.
- **Model Discovery with `enabledModels` Scoping**: Implemented automatic resolution of Pi's `enabledModels` pattern whitelist (`resolveModelScopeWithDiagnostics`). Only explicitly enabled models are advertised to BB IDE, keeping model pickers clean and relevant.
- **Dynamic Context Estimation & `/compact`**: Integrated real-time token estimation (`estimateContextTokens`) from conversation history, emitting context window deltas directly to BB timeline. Added support for manual `/compact` commands.
- **Model-Aware Compaction Configuration**: Refactored harness setup to resolve model-specific compaction thresholds from Pi's `settings.json` (`modelOverrides`) via `settingsManager.getCompactionSettings(model)`.
- **Steer & Turn Lifecycle Discipline**: Aligned runner input submission with BB's `turn/steer` contract, emitting `input.accepted` with `providerTurnId` and properly reconciling pending steers.
- **Discovery Handler & Protocol Modularization**: Extracted dedicated `discovery-handler.ts`, `jsonrpc.ts`, and `bb-event-adapter.ts` to strictly adhere to architectural boundaries (AP-010, AP-019).
- **Master Parity Roadmap (Cycles 56–67)**: Published comprehensive 12-cycle architectural plan (`docs/superpowers/plans/2026-10-07-arch-improvement-master-plan-pi-durable-parity.md`) for full engine parity and remediation.

### Fixed
- **Instant Per-Tool Output Completion**: Ensured individual tool completions emit immediately with aggregated output rather than stalling until turn completion.
- **Probe Mode Model Extraction**: Fixed model discovery in `--no-session` probe mode to reliably parse model catalogs from `raw.data.models`.
- **SQLite Directory Path Normalization**: Fixed handling of SQLite session directories and recursive cleanup on teardown.
- **Boundary & Error Types Discipline**: Replaced heuristic fallbacks with fail-fast typed contracts per AP-012 and AP-013.

---

## [0.1.0] - 2026-10-05

### Added
- Initial release of the Pi Durable provider plugin for BB IDE.
- Basic provider registration and bridge routing for durable conversations.
- SQLite-backed transactional session persistence.
