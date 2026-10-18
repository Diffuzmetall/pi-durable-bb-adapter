# Native-primary acceptance scope

Date: 2026-10-18. Package: `0.3.0-beta.1`.

This is fresh acceptance of the **new native-primary flow**, not a claim that every historical BBx milestone or native transcript format is complete.

## Executed checks

| Check | Result |
|---|---|
| Clean root `npm ci` (no dependency symlink to another checkout) | PASS; prepare/build succeeded; npm reported zero vulnerabilities |
| Regression suite on that installation | 238 PASS, 1 optional SKIP, 0 FAIL |
| Offline doctor | PASS; all nine compatibility SDK packages resolved at 1.2.0, including nested ESM-only packages |
| Normal `bb plugin build` and main-instance install/reload | PASS |
| Native default without classic Pi extension auto-loading | PASS; runtime/catalog canary regression retained |
| Native launch failure followed by a safe retry | RED on old code, GREEN after per-attempt diagnostics fix; faux CLI/PTY only, no Harness/model |
| Independent code review | READY after review of the retry fix and doctor resolution |
| Main BB prompt to actual native CLI | PASS; execution reported native SDK 1.3.0 |
| Actual native shell tool | PASS; expected stdout observed in the native tool result |
| Actual native subagent | PASS; one child, validated native ChildReport |
| Separate BB child | PASS; Core native registration, correct parent and provider |
| Browser parent → child → reload | PASS; completed native child result remained visible |
| No duplicate execution on browser attach/reload | PASS; same native PID, entries and task count |
| Main BB, existing terminal and queued messages | Preserved; neither running process restarted; both queued messages unchanged |
| Existing main event rows during activation | Hashes unchanged; only a new owned synthetic project/thread pair was added for acceptance |

The real native profile exposed **18 admitted extensions and 257 tools**, with one native subagent/configured-MCP/coding-tools/Hindsight owner each. These are observations of the selected profile, **not** hard-coded requirements or bundled private configuration. The earlier minimal private-profile fixture had different inventory counts and is not substituted for this main-instance proof.

The native child had one user entry and one assistant entry (plus its native system entry). Total native tasks were nine and remained nine across navigation and reload. The main host artifact digest was `e5dddfbca289e2a2a0c1a99f85becc4c42773058ef8ff29127ad31910a27697e`; the clean-root rebuild produced that same artifact.

## Visibility finding adjudication

An independent browser check initially reported a lingering `Working...` string. The string belonged to a retained **hidden animation subtree**, not painted running UI. A separate visibility check before and after reload established `Element.checkVisibility(...) === false`, ancestor opacity zero, height zero and clipping; the completed child result was visibly present. No CSS/DOM alteration or frontend workaround was applied.

A text-body or accessibility snapshot alone is not evidence that an element is painted. The final verdict uses visibility and screenshot evidence, while preserving the initial finding in private acceptance records.

## Publication/privacy checks

The complete reachable Git history and the contents of the compatibility archive were scanned, including upstream vendor source. Findings were classified by exact context: source-file SHA-256 pairs, SQLite identifiers, a canonical public JWT example, an upstream `example.com` parser fixture and one JavaScript property access. Exclusions match those reviewed literals; no broad vendor-directory exclusion was added.

The historical blob inventory found no checked-in live auth/settings/owner/store/key files or private user contact details. Upstream image/binary assets, license attribution, noreply commit identity and synthetic examples remain. Current operator state, grants, accounts, native manifests, screenshots, raw browser/scan reports and live stores are excluded from the public tree.

Private paths, account configuration, raw runtime records and browser screenshots are deliberately not published as proof artifacts. The source tests and commands are reproducible; live native acceptance additionally requires the admitted external installation described in the README.

## Not covered by this verdict

- Automatic legacy-managed-history migration.
- General rich/native transcript-format coverage or every background/follow-up report-delivery path.
- Child write controls (projected existing children are read-only).
- Arbitrary BB, SDK, operating-system or Node versions.
- Full BB9 cross-feature/performance/recovery acceptance.

Those limits do not authorize fallback, replay, a replacement store, or a second execution owner.
