# BB0 SDK 1.2 baseline performance report

**Verdict: INCONCLUSIVE for a performance comparison.** This is a descriptive record of one completed baseline session, not evidence that either loader is faster, that BB0 meets a performance budget, or that any optimization occurred. The root plan's 15% p95 non-regression rule applies to subsequent slices; it is not a pass/fail target for this BB0 baseline. Unsupported native-BB-child capability is N/A, with no fabricated ratio.

## Run and provenance

- One immutable run: 2026-10-16 08:48:11.499649–08:48:49.141732 UTC; one attempt, exit code 0, no outer timeout. Measurement window: 08:48:11.771130–08:48:26.335711 UTC.
- 62 timed rows: one cold and 30 warm per side. Warm repetitions are paired at the same index. Reference ran first and candidate second in every pair; not randomized or counterbalanced.
- The compared sides use the **same corrected host implementation** and identical growing histories, but different managed-loader paths (reference/original-parent vs candidate/adjusted-location). This is not an implementation change or SDK migration comparison.
- Evidence: inner raw result `../lead-private/.cache/run-1dt3wg80/baseline-live-result.json` (87,909 bytes; SHA-256 `e0957d0bd83289966efcb13e7fddf16b1d165bf481a0eeddafe0ea1887a775a0`); outer coordinator receipt `../coordinator-sdk12-live-result.json` (SHA-256 `9fa03acbeca6b809ff163b4a33a953ccee328278d88607c6efcaba06d8d78f4f`). Receipt pins outer result SHA-256 `f898cb7a02c4964d3124f9583e75ea270df860266cb8ef70f9a1afc3b12eddc6`.
- Host overlay `packages/coding-agent/src/extensions/codemode/tool.ts`: original SHA-256 `67216b67186567278527edc5c6544cbb7e52a515a4887b4cf433299f8d1e9113`; corrected overlay `f9495350672382574ee8f1e8b3e4c8e46ceb9ef3dd521b28cf2ffbeed900004f`.
- Actual inner raw JSON was rehashed. Its nested `metricSummary` is not used for reported statistics: values here are recomputed from `samples` using Python standard-library `statistics.median`, sorted nearest-rank p95 `sorted[ceil(.95*n)-1]`, and min/max. Exact input and derived values are in `derived.json`.

## Measurements (milliseconds)

Warm: 30 observations per side; shown as **median / nearest-rank p95 [min–max]**.

| Metric | Reference | Candidate |
|---|---:|---:|
| Attach | 5.857 / 9.206 [3.620–14.577] | 7.154 / 30.855 [4.042–32.862] |
| Submit to fixture request | 14.446 / 18.972 [11.236–22.383] | 15.689 / 24.041 [11.391–26.251] |
| Fixture first chunk to shared-wire incremental text | 107.047 / 110.535 [104.816–115.712] | 107.183 / 117.111 [104.677–121.490] |
| Submit to first shared-wire incremental text observed | 122.250 / 128.898 [117.382–132.813] | 123.412 / 141.288 [116.626–145.804] |
| Fixture first chunk to terminal PTY incremental bytes | 108.666 / 112.236 [105.896–117.378] | 109.406 / 121.676 [106.049–123.006] |
| Submit to terminal PTY incremental bytes observed | 123.832 / 130.987 [118.462–134.479] | 125.261 / 145.853 [117.998–147.321] |
| Fixture trace duration (through tail/completion) | 109.102 / 112.489 [106.200–117.662] | 109.656 / 121.877 [106.319–123.325] |

Cold had only one observation per side (not a stable comparison): attach 27.333 ms reference / 24.703 ms candidate; submit-to-wire-first-text 370.743 / 377.280 ms; submit-to-PTY-first-text-bytes 377.254 / 384.072 ms. Cold means a fresh process/session, **not** a flushed OS page cache. Full cold values and the separate submit/fixture timings are in `derived.json`.

## What was measured

The fixture was a local two-chunk faux SSE response. It held the first `ALPHA` chunk until incremental text was observed at the shared-wire and native-renderer PTY boundaries, then released `OMEGA`/tail. All 62 timed rows record first text before tail release. The first 31 request indices (one cold plus 30 warm) have matching reference/candidate message SHA-256 values at each index (31/31); the 30 warm pairs therefore match 30/30. The candidate's index 31 request is an extra functional diagnostic, not a timing sample: 31 reference requests versus 32 candidate requests total.

The wire metric is an `agent_events` / `message_start` observation. The terminal metric is **PTY byte arrival**, not parsed terminal paint, browser paint, or proof that text was visible to a person. `submitToFixtureRequestMs` ends at local fixture receipt; `fixtureTraceDurationMs` measures the fixture's trace through tail/completion; first-chunk-to-wire/PTY begins at first fixture chunk flush. They are separate boundary intervals, not interchangeable latency labels. No model inference or external network was involved.

## Checklist and limits

- **Errors/work happened:** raw result has an empty `errors` array; outer receipt reports 11/11 standalone-host scenarios exit 0 and records expected denial probes. The measured output was observed before tail release. This only establishes the recorded fixture/probe boundaries, not universal error coverage.
- **Limiter:** NOT IDENTIFIED. No independent limiter profile or counter trace exists. The recorded 12 logical CPUs and load averages (5.092/4.374/4.254 before; 4.775/4.339/4.245 after) do not attribute the limiter. Competing workload attribution is UNKNOWN.
- **Reproducibility/confounds:** this is one run, with one cold observation per side; warm pairs are fixed reference-first, so order/drift can favor a side. The benchmark checklist's five-runs-per-side and alternating-order guidance is not met and must remain a limitation; the task explicitly forbids rerunning.
- **Relevance:** local faux workload only; no browser/UI paint, user-perceived latency, production RUM, or throughput/concurrency claim.

Thus the sample distributions are reportable observations, but a claim of faster/slower winner or acceptable regression is not supported. No speedup, optimization, current BB0 performance-budget PASS, or absent-feature ratio is claimed.

## Recalculation

This report was derived from the already-finished raw JSON only. No benchmark, model call, network request, or benchmark process was started. To recalculate from the repository root using Python 3 standard library:

```python
import json, math, statistics
p = 'evidence/BB0/lead-private/.cache/run-1dt3wg80/baseline-live-result.json'
d = json.load(open(p))
for side in ('reference', 'candidate'):
    for metric in ('attachMs', 'wireFirstIncrementalTextObservedMs', 'terminalFirstIncrementalTextBytesObservedMs', 'submitToFixtureRequestMs', 'fixtureTraceDurationMs', 'fixtureFirstChunkToWireMs', 'fixtureFirstChunkToTerminalMs'):
        v = [r[metric] for r in d['samples'] if r['phase'] == 'warm' and r['side'] == side]
        print(side, metric, statistics.median(v), sorted(v)[math.ceil(.95 * len(v)) - 1], min(v), max(v))
```
