# Architecture Improvement Plan: Cycle 77 - Provider Update Resolution, GitHub Tag Sync & Remote Release (v0.2.22)

**Document ID:** `plans/2026-10-09-arch-improvement-cycle-77-provider-update-resolution`  
**Target Repository:** `/Users/vanya/Projects/bb-plugin-provider-pi-durable`  
**Governing Standards:** `arch-rules.md` (AP-010 – AP-071), `arch-improvement-review`, `arch-rules-implementation-review`  
**Status:** DRAFT -> IN REVIEW -> APPROVED

---

## 1. Goal & Context
Resolve the BB IDE Updates page issue where `Pi Durable` version check reports `latestVersion: null` and displays `(?)` (state `latest-unknown`) instead of "Up to date" or showing updates:
1. `fetchLatestVersion()` in `src/host/installation-manager.ts` currently only queries `https://registry.npmjs.org/bb-plugin-provider-pi-durable` (which 404s because the plugin is hosted on GitHub, not published on npm).
2. Enhance `fetchLatestVersion()` to check GitHub releases/tags (`https://api.github.com/repos/VanDalkvist/bb-plugin-provider-pi-durable/tags`).
3. If remote latest version is `<` or `=` current local version (or in offline mode with no higher version known), resolve `latestVersion` to `currentVersion` so BB IDE's `Ga` state becomes `"up-to-date"` rather than `"latest-unknown"`.
4. Rebuild plugin bundles (`npm run build`), reload plugin in BB IDE (`bb plugin reload provider-pi-durable`).
5. Verify live endpoint `/api/v1/hosts/:id/provider-clis/status` returns `currentVersion: "0.2.22"`, `latestVersion: "0.2.22"`, `needsUpdate: false`.
6. Tag release `v0.2.22` and push to remote (`git push origin main --tags`) per user's explicit instruction.

---

## 2. Findings Selected for Fix-Now
- **[P1] D-22 Remediation:** `fetchLatestVersion()` fails for GitHub-hosted plugin, causing `latestVersion: null` and `(?)` badge in BB Settings.
- **[P1] Stale Host Artifact Process:** BB host daemon was caching old `host.mjs` with hardcoded `1.0.4`. Ensure build and `bb plugin reload` are automated and verified.

---

## 3. Implementation Tasks

### Task 1: Enhance `fetchLatestVersion` in `src/host/installation-manager.ts`
- Query GitHub tags API with timeout (2000ms) and user-agent header.
- Parse tags (e.g. `v0.2.22` -> `0.2.22`) and extract highest semver version.
- If highest remote version is `<= currentVersion`, return `currentVersion`.
- Fallback gracefully to `currentVersion` if GitHub/npm are offline or 404.
- Keep file strictly < 200 lines (AP-019).
- Zero `as any` (AP-029).

### Task 2: Unit Testing
- Update `tests/provider-installation.test.ts` to test GitHub tag parsing and fallback to `currentVersion`.
- Ensure 100% deterministic test execution without mandatory external network connection.

### Task 3: Build & Host Reload Verification
- Run `npm run build`.
- Run `bb plugin reload provider-pi-durable`.
- Curl `/api/v1/hosts/:id/provider-clis/status` to verify live response.

### Task 4: Git Tag & Remote Push
- Tag `v0.2.22`.
- Push to GitHub remote `origin main` and `--tags`.

### Task 5: Documentation & Ledger Update
- Record Cycle 77 in `docs/arch-improvement/ledger.md`.
