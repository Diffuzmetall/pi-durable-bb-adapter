# SDK leaf QA plan v3 — NEEDS_CHECKS / NOEXEC

This is a private source-only candidate for review. It does not grant SDK runtime GO. The FS3 attempt was NOT_RUN after its lease deadline; Root 316–322 remain expired. No project source, helper, parent, SDK, config, or runtime state is changed.

## Minimal v2 changes
- `supervisor.py`: keep helper BASE canonical (`resolve(strict=True) == literal`), reject symlink ancestors, preserve directory type/owner/exact `S_IMODE == 0700` including special bits; report POSIX ACL-name presence informationally, without reading values or rejecting presence. Any recorded timeout is HOLD/124 regardless of kill result, late child return code, or reap status; timeout retains cleanup UNKNOWN and forbids retry.
- `inner-witness.py`: preserve exact mode/owner checks; report ACL-name presence as booleans only; remove duplicated `capabilities` / `env_exact_match` keys and duplicate comment.
- `manifest.json`: record actual SHA-256 and byte lengths for the 13 pinned source inputs and v2 artifacts. It deliberately does not contain its own hash.

## Linux POSIX ACL interpretation
For a directory whose actual mode is exactly `0700`, the POSIX ACL group-class mask is `0` and `other` is `0`; named user/group entries therefore have effective permissions `0`. A default ACL affects creation/inheritance only; each created private directory is checked independently for exact `0700`, and ACL-name presence is informational only (no ACL values are read or changed).

## Checks still required
Exact four-file v1 pins and 13 source pins are recorded in the v3 manifest. This prep runs only Python AST/JSON parsing and a pure outcome function extracted from v3 source: timeout+late 0 => 124; timeout+late -9 => 124; normal target 0 => 0; reap unknown => 124. Whole supervisor/helper, Node, namespaces, SDK/public sweep, builds, installs, and runtime remain NOT RUN. Independent source review is required before any later separately authorized GO.

Model routing: Gemini unavailable; Luna-high requested fallback; effective model UNKNOWN. No Root project token/lease was claimed.
