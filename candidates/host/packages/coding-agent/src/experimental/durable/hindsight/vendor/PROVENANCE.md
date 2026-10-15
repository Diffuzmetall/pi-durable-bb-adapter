# Local Hindsight pin

This vendor boundary pins `@vectorize-io/hindsight-coding-agents` **0.8.0** from the already installed `/home/ubuntu/.hindsight/coding-agents`, not a guessed upstream commit. No install or download was used.

`provenance.json` records the exact source byte count and SHA-256, patched prefix and final bundle hashes, every reversible local dependency patch, and companion hashes. Source `dist/pi.js` SHA-256: `a29f38a67d84ecf375bccb7fd5e3560e2bb04baa8e50911ee5b0539d1f0e41c7`.

`pi.mjs` preserves the installed bundle and its default/extension exports, applies the recorded Durable effect-injection patches, and appends the existing 32 standalone helper exports. The daemon patch retains 0.8's cold-start serialization. Usage, diagnostics, seed and survey patches retain explicit host-owned effect boundaries.

The matching installed `dist/{deepen,daemon-start,mcp-server,survey-supervisor}.js` siblings and package metadata are copied unchanged. Bundle launchers resolve these siblings beside `pi.mjs`; the bridge supplies the vendor root for package-version lookup. This is a private bundle boundary, not a complete installable package: metadata's other dist exports/binaries are not supplied. The existing MIT LICENSE is preserved unchanged.

Durable owns admission, immutable outbox payloads, remote acceptance and replay. Native fire-and-forget session retention is not used. Configured retain context is constructed at admission and preserved in receipts; queued acceptance does not prove extraction. Native automatic retrieval modes and configured page limits remain native algorithms. Detached launches and real-service extraction were not exercised by the offline parity suite.
