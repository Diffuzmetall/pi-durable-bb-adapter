# Architecture Improvement Plan: Cycle 59 - Synchronous Context Window Telemetry & Stale Runner Lifecycle

**Goal:** Ensure real-time, accurate context window usage telemetry (`Estimated context: X / Y tokens`) in BB IDE for all turns without UI stalls or dependencies on asynchronous IPC polling, and prevent stale background runner processes from locking sessions and dropping RPC commands.

**Architecture Baseline:** `arch-rules.md` (AP-010 – AP-071)  
**Methodology:** `arch-improvement-loop` (Cycle 59)  
**Primary Sources:**
- `~/Projects/pi/packages/durable/src/harness/context.ts` (`readContext`, `deriveContext`, `estimateContextTokens`)
- `~/Projects/bb-reference/host-daemon/dist/daemon-bundle.mjs` (Zod schema `KCe`, `case "contextWindow":`)
- `~/Projects/bb-reference/server/dist/start-server.js` (`extractThreadContextWindowUsage`)

---

## 1. Triaged Findings

### Finding F-59-1: Context Window Delta Missing from Synchronous Turn Finalization (P1 - AP-026, AP-013)
- **Evidence:** `src/host/delta-translator.ts` emitted only `kind: "usage"` on `event.type === "agent_end"`. `kind: "usage"` updates `thread/tokenUsage/updated` (cumulative tokens), but does NOT emit `thread/contextWindowUsage/updated` (the composer context meter).
- **Impact:** The composer context meter in BB IDE (`bb thread context <id>`) only updated once on startup and froze at legacy values (e.g., 125,390 tokens), ignoring turns 11–16 even though the model was actively consuming up to 161,243 tokens.
- **Root Cause:** Context window meter updates relied solely on an asynchronous IPC roundtrip (`this.refreshContextUsage()` calling `{ type: "get_session_stats" }` over stdin), which is vulnerable to runner process latency, command drops, and stale processes.
- **Fix Decision:** `fix-now`. In `delta-translator.ts`, synchronously emit `kind: "contextWindow"` alongside `kind: "usage"` and `turn.boundary` whenever `usage` is present in `agent_end`. The LLM's own response payload provides the exact token usage (`totalTokens` or `input + cacheRead`), eliminating any dependency on out-of-band stdin RPC.

### Finding F-59-2: Stale Runner Processes Persisting Across Plugin Reloads (P1 - AP-022, AP-012)
- **Evidence:** Host daemon kept old runner process (PID 44938, spawned at 15:20) alive in memory across plugin rebuilds and reloads (`bb plugin reload`). The stale process held an active `proper-lockfile` on `~/.bb/pi-bridge-sessions/<threadId>/session.sqlite` and lacked newly compiled command handlers (such as Cycle 57's `get_session_stats`).
- **Impact:** Any attempt to query the session via `openDurable` failed with `ELOCKED`, and RPC calls to the stale runner threw errors or timed out, preventing context telemetry and status queries from completing.
- **Fix Decision:** `fix-now`. Ensure stale runner processes are terminated on session cleanup or explicit restart, and document the runner lifecycle contract in the arch ledger and runtime types.

---

## 2. Implementation Slices

### Slice 1: Synchronous `contextWindow` Delta Translation (TDD)
1. **Failing Test Step:** In `tests/context-window-usage.test.ts`, assert that `translator.translate({ type: "agent_end", ... })` produces a delta with `kind: "contextWindow"` having `used: totTok`, `size: cwSize`, `estimated: false`, and `attach: "currentOrLast"`.
2. **Minimal Implementation Step:** In `src/host/delta-translator.ts`, within `case "agent_end":`, extract `cwSize = typeof event.contextWindow === "number" && event.contextWindow > 0 ? event.contextWindow : 128000;` and push `{ kind: "contextWindow", used: totTok, size: cwSize, estimated: false, attach: "currentOrLast" }`.
3. **Passing Test Step:** Verify all unit tests pass with `npm test`.

### Slice 2: Verification of Context Estimation against Real Upstream pi-durable
1. **Validation Command:** Execute context derivation script against real session database `/Users/vanya/.bb/pi-bridge-sessions/pi_durable_1791314935082/session.sqlite` using `~/Projects/pi` contracts (`captureContextBounds` and `deriveContext`).
2. **Passing Criteria:** `tokens: 161,243` matches LLM provider token usage from SQLite entries (153,531 cache + 3,598 input + 142 output + message overhead).

### Slice 3: Build, Packaging, and Ledger Documentation
1. Run `node scripts/build-runner.mjs && bb plugin build`.
2. Reload plugin in BB: `bb plugin reload provider-pi-durable`.
3. Record findings F-59-1 and F-59-2 in `docs/arch-improvement/ledger.md`.
4. Bump package version if needed and record verification evidence.
