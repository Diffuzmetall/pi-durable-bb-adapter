# BB0 observations — INCONCLUSIVE; required first-visible-text metric unavailable

## Attributable correction (no rerun)

IvoryBridge corrected this derived aggregation following the parent's bounded independent scout-port audit. That scout audit is **not final review or QA**. Raw run003, driver `f7b7…`, result `675d…`, and raw samples `7df8…` remain unchanged. Their historical `wireFirstTextMs` / `terminalFirstVisibleTextMs` labels are **not valid incremental-first-text, true-first-token, parsed-render or visible-paint labels**; this document supersedes the earlier interpretation, not the raw observations.

All62 timed marker frames have `message_start` containing the complete `ALPHA_OMEGA` answer together with `message_end`, `turn_end`, `run_end`, `submission`, and `usage_changed`. The PTY observation likewise concerns **complete-answer bytes**, not a parsed terminal screen or observed paint. Both timing paths include the deliberate10ms fixture delay after the first SSE chunk. Neither is pure provider/UI overhead or the required first-visible-text metric.

## Conditions and confounds

Protected UTC: 2026-10-15T23:12:59.682514+00:00–23:13:08.234356+00:00. IvoryBridge file reservation163 covered23:11:19.702048Z–23:13:46.295886Z; previous QA ended23:06:18.046530Z and the parent kept ops static.

Cold means fresh process/session, **not OS page-cache flush**. Attach timing begins after socket readiness, not process startup. One cold observation per side preceded30 warm pairs. Every pair is **always reference FIRST, candidate second**: fixed AB order, NOT counterbalanced or randomized. The order is a confound, not eliminated by calling the sequence alternating.

Both sides execute the **SAME `candidates/host` source**. Only original-parent versus adjusted-location managed loaders differ; this is not a new implementation, SDK migration, or speedup comparison. Histories grow identically. Matching hashes concern model messages and are joined by `(side,index)` within this run; raw rows do not carry self-contained authenticated request/work receipts.

## Corrected descriptive labels (ms; NOT acceptance metrics)

| Warm observation | Reference median / range / p95 | Candidate median / range / p95 |
|---|---|---|
| Attach response observed | 4.991 / 3.579–8.530 / 7.463 | 5.300 / 3.735–26.726 / 7.781 |
| Completed-turn marker frame observed | 31.592 / 27.940–42.323 / 39.073 | 32.467 / 28.229–42.423 / 40.248 |
| Complete-answer bytes observed on PTY | 36.090 / 30.314–47.949 / 47.143 | 35.986 / 31.836–48.219 / 46.507 |

Thirty warm observations per side; nearest-rank p95 is observation29/30. Two separate cold rows and all60 warm rows remain in the raw samples. `lead-baseline-derived-metrics.json` supplies the corrected label map and derived run-local message-hash joins without modifying raw labels retroactively.

## Work and error accounting

- **62 timed rows /63 HTTP requests**: reference31, candidate32. Candidate index31 is the extra held functional diagnostic, not a timing sample. Counts are observed local HTTP boundary work, not an independently authenticated per-row execution receipt.
- Raw `errors: []` means **zero HTTP-fixture exceptions only**, not zero protocol/runtime errors.
- Recorded protocol responses:130 total,129 successful, **one expected wrong-cwd attach denial** (`Shared host belongs to a different working directory`). Per-log totals: reference63, candidate66, reopened1. No additional failed responses were observed in these recorded logs; this is not universal error coverage.
- Separate expected negative probes: second owner exits1; missing socket raises ENOENT; synthetic policy denies one call. These are not successful latency samples. Three actual native main processes exit0 normally; private SQLite integrity checks pass.
- Guard probe calls the real `adaptExtensionTool`, but its policy is only a **synthetic Boolean callback**. Denied side-effect counter0 and allowed control1 validate that adapter fixture, **NOT actual MCP or Agent Mail authorization**.

## Verdict and remaining work

**INCONCLUSIVE**: no independent limiter profile, fixed-order confound, same host implementation, and run-local rather than self-contained workload joins. No winner, speedup, SDK migration, true-first-token, incremental-text, terminal-render, visible-paint, BB-browser latency, or guard-authorization claim is made. Twelve cores/load approximately3.8 do not identify the limiter. This is one protected session pair, not30 independent process-level runs; no production RUM evidence exists.

The preserved initial coalescing-observer failure (`run-sdl94qyx`) exposed a parser assumption. The replacement accepted complete-answer frames; it did **not** establish first incremental text or visible paint. Exploratory002 is not the protected baseline. Native BB child projection remains N/A, with no invented ratio or native-child PASS.

Required gates remain unavailable: valid submit-to-first-visible-text measurement, canonical visuals, final independent live/perf review+QA, and coordinated after-live input audit. No new timed run or heavy input scan was performed for this correction; ops/native probes retain priority. Full BB0 and all canonical ten-lane acceptance remain **NOT ACCEPTED**.

Raw result SHA256: `675d51b65b00cd2332a31bcae1ed7caf0aa0c1b5047d518506a814606e765c72`.

Raw samples SHA256: `7df8c23c2d9a85ba4b56b8013a83512b0c107841880dddb4761f67edf83722c7`.

Unchanged driver SHA256: `f7b7f0b67f7508f67e5f529b2bdbef72b3f6f1a6911d2bb826f2daafa9a7e924`.
