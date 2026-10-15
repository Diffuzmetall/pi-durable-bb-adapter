# Arch Improvement Cycle 87: Elimination of Silent Catches & Standardized Error Propagation (AP-022)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Полная ликвидация слепых блоков `catch {}`, пустых `.on("error", () => {})` и недиагностируемых падений во всей кодовой базе в соответствии с усиленным правилом AP-022. Внедрение структурированного логирования с контекстом для best-effort операций и сохранение цепочки причин (`{ cause: err }`) при пробросе ошибок.

---

### Architecture Context Map Reference
- **Stage:** `prod` (BB Provider Plugin).
- **Source Docs:** `/Users/vanya/Projects/arch-rules/arch-rules.md` (AP-022), `docs/arch-improvement/ledger.md`.
- **Critical AP Gates:**
  - **AP-022 (Typed Errors & Explicit Handling):** Пустые `catch {}`, пустые `.catch(() => {})` и пустые `.on("error", () => {})` запрещены. Любой non-fatal перехват обязан логировать структурированный контекст (`[Component] Action failed: ...`, err). Намеренное игнорирование допустимо только для явных кодов (`ENOENT`, `ESRCH`). При переупаковке ошибок обязателен `{ cause: err }`.
  - **AP-010 (Thin Adapter):** Ошибки на RPC-границах транслируются в типизированные JSON-RPC коды (`-32000`, `-32602`), не прерывая протокол и не теряя трассировку в логах.
  - **AP-019 (File Size Compliance):** 100% файлов в `src/runner/` строго < 200 строк; 100% файлов в `src/host/` < 250 строк.
  - **AP-028 (TDD Test Parity):** Все новые пути обработки ошибок покрываются детерминированными тестами.
  - **AP-029 (TypeScript Strictness):** 0 `as unknown as`, 0 `as never`, 0 невалидированных `any`.

---

### Triaged Findings Selected for Fix-Now

| ID | Issue / Component | Severity | Rule | Disposition | Root Cause & Resolution |
|---|---|---|---|---|---|
| **F-87-1** | Слепое проглатывание ошибок спавна процесса в `src/runner/subagent.ts` | **P1** | AP-022 | `fix-now` | В `trySpawnBbSubthread` ошибки `cp.on("error")` и `catch` глушились молча. Заменить на структурированный лог `console.warn('[Subagent] ...')` с сохранением ошибки. |
| **F-87-2** | Непрозрачная очистка блокировок и сигналов в `src/runner/session-storage.ts` | **P1** | AP-022 | `fix-now` | В `forceUnlock`, `removeOwnerFile`, `readOwnerFile` и `kill` пустые кэтчи маскировали `EACCES` и битые JSON. Проверять `ENOENT`/`ESRCH`, а непредвиденные сбои логировать. |
| **F-87-3** | Слепое проглатывание сетевых сбоев и версий в `src/host/installation-manager.ts` | **P1** | AP-022 | `fix-now` | `fetchJson` и `resolveDynamicPluginVersion` возвращали `null`/fallback молча. Внедрить лог с URL, кодом статуса и причиной ошибки. |
| **F-87-4** | Недиагностируемая регистрация провайдеров в `src/runner/runtime-loader.ts` и `model-setup.ts` | **P2** | AP-022 | `fix-now` | Ошибки регистрации отбрасывались в `catch { /* ignore duplicate */ }`. Проверять код дубликата, остальные ошибки регистрации логировать как варнинг с контекстом. |
| **F-87-5** | Слепые исключения файловой системы и завершения в `src/runner/diagnostics.ts` | **P2** | AP-022 | `fix-now` | В `statSync` и `runner.emit('session_shutdown')` ошибки глушились без анализа. Игнорировать только `ENOENT`, другие ошибки логировать. |
| **F-87-6** | Молчаливый обход директорий в `src/host/paths.ts` | **P2** | AP-022 | `fix-now` | Сбои `readdirSync` глушились. Логировать предупреждение при `EACCES` / `EPERM` для прозрачности поиска раннера. |
| **F-87-7** | Пустой `.catch(() => {})` на `readyPromise` в `src/host/catalog.ts` и `session-telemetry.ts` | **P2** | AP-022 | `fix-now` | Пустые хэндлеры маскировали отказ до старта. Зафиксировать причину через обработчик, логирующий отложенную ошибку. |

*Exclusions: `log-only`: none; `blocked`: none.*

---

### Task 1: Transparent Error Handling in `src/runner/subagent.ts` (Slice F-87-1)

**Files:**
- Modify: `src/runner/subagent.ts`
- Test: `tests/subagent-error-handling.test.ts`

- [ ] **Step 1: Написать падающий тест на логирование ошибок спавна сабтреда**

```typescript
// tests/subagent-error-handling.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { Subagent } from "../src/runner/subagent.ts";

test("trySpawnBbSubthread warns with context instead of swallowing errors", () => {
    // Проверка, что при ошибке спавна пишется внятный console.warn с префиксом [Subagent]
    assert.ok(Subagent);
});
```

- [ ] **Step 2: Запустить тест и убедиться в падении / фиксации требований**

- [ ] **Step 3: Устранить пустой catch и пустой on("error") в `src/runner/subagent.ts`**

Заменить:
```typescript
cp.on?.("error", (err: unknown) => {
    console.warn(`[Subagent] Background thread spawn failed: ${err instanceof Error ? err.message : String(err)}`);
});
} catch (err: unknown) {
    console.warn(`[Subagent] Failed to initiate thread spawn: ${err instanceof Error ? err.message : String(err)}`);
}
```

- [ ] **Step 4: Проверить тесты и AP-019 (< 200 строк)**

Run: `node --test tests/subagent-error-handling.test.ts`
Run: `wc -l src/runner/subagent.ts` (< 200 строк).

---

### Task 2: Explicit Error Inspection in `src/runner/session-storage.ts` (Slice F-87-2)

**Files:**
- Modify: `src/runner/session-storage.ts`
- Test: `tests/session-storage-errors.test.ts`

- [ ] **Step 1: Написать тест на прозрачную обработку ошибок локфайла и файлов владельца**

- [ ] **Step 2: Устранить пустые catch в `src/runner/session-storage.ts`**

1. В `readOwnerFile`:
   Если ошибка `ENOENT` — возвращать `null`. Если `SyntaxError` (битый JSON) или `EACCES` — логировать `console.warn("[SessionStorage] Corrupted or unreadable session.owner.json:", err)`.
2. В `forceUnlock`:
   Перехватывать ошибки `unlock` и `rm`: игнорировать `ENOENT`, остальные логировать: `console.warn("[SessionStorage] forceUnlock cleanup warning:", err)`.
3. В `removeOwnerFile`:
   Игнорировать `ENOENT`, остальные логировать: `console.warn("[SessionStorage] Failed to remove owner file:", err)`.
4. В `kill(owner.pid, "SIGTERM")`:
   Игнорировать `ESRCH` (процесс уже завершен), остальные логировать: `console.warn("[SessionStorage] Failed to send SIGTERM to orphan process:", err)`.

- [ ] **Step 3: Запустить тест и проверить AP-019 (< 200 строк)**

Run: `node --test tests/session-storage-errors.test.ts`
Run: `wc -l src/runner/session-storage.ts` (< 200 строк).

---

### Task 3: Transparent Network & Update Error Logging in `src/host/installation-manager.ts` (Slice F-87-3)

**Files:**
- Modify: `src/host/installation-manager.ts`
- Test: `tests/installation-manager-errors.test.ts`

- [ ] **Step 1: Написать тест на логирование сбоев сетевого запроса обновлений**

- [ ] **Step 2: Устранить пустые catch в `src/host/installation-manager.ts`**

1. В `resolveDynamicPluginVersion`:
   При сбое чтения `package.json` логировать `console.warn("[InstallationManager] Could not read package.json version, falling back to default:", err)`.
2. В `fetchJson`:
   При сетевой ошибке/таймауте логировать: `console.warn(`[InstallationManager] HTTP request failed for ${url}: ${err instanceof Error ? err.message : String(err)}`)`.

- [ ] **Step 3: Запустить тест и проверить AP-019 (< 250 строк)**

Run: `node --test tests/installation-manager-errors.test.ts`
Run: `wc -l src/host/installation-manager.ts` (< 250 строк).

---

### Task 4: Explicit Provider Registration Error Handling (Slice F-87-4)

**Files:**
- Modify: `src/runner/runtime-loader.ts`
- Modify: `src/runner/model-setup.ts`
- Test: `tests/provider-registration-errors.test.ts`

- [ ] **Step 1: Написать тест на проверку ошибок регистрации провайдеров**

- [ ] **Step 2: Заменить пустые catch на избирательную обработку дубликатов с логированием реальных сбоев**

Если ошибка содержит `already registered` или `duplicate` — это ожидаемое поведение.
Если ошибка другая (невалидный конфиг, ошибка парсинга) — логировать `console.warn(`[RuntimeLoader] Provider registration failed for ${name}: ${err.message}`)`.

- [ ] **Step 3: Проверить тесты и AP-019 (< 200 строк)**

Run: `node --test tests/provider-registration-errors.test.ts`
Run: `wc -l src/runner/runtime-loader.ts src/runner/model-setup.ts` (< 200 строк).

---

### Task 5: Diagnostics & Path Traversal Error Transparency (Slices F-87-5, F-87-6, F-87-7)

**Files:**
- Modify: `src/runner/diagnostics.ts`
- Modify: `src/host/paths.ts`
- Modify: `src/host/catalog.ts`
- Modify: `src/host/session-telemetry.ts`
- Test: `tests/diagnostics-errors.test.ts`

- [ ] **Step 1: Устранить пустые catch в `diagnostics.ts` (проверять `ENOENT`, логировать остальное)**
- [ ] **Step 2: Устранить пустые catch в `paths.ts` (логировать permission warnings при обходе)**
- [ ] **Step 3: Устранить пустые `.catch(() => {})` в `catalog.ts` и `session-telemetry.ts` (заменить на структурированный safety-хэндлер)**
- [ ] **Step 4: Проверить лимиты строк AP-019 для всех затронутых файлов**

---

### Task 6: Full Verification, Static Analysis & Ledger Update

- [ ] **Step 1: Полный grep-аудит отсутствия пустых catch в кодовой базе**
Run: `git grep -E "catch\s*\{\s*\}" src/` (Должно быть ровно 0 совпадений!).
Run: `git grep -E "\.catch\(\(\)\s*=>\s*\{\s*\}\)" src/` (Должно быть ровно 0 совпадений!).

- [ ] **Step 2: TypeScript проверка типов**
Run: `npx tsc --noEmit` (0 errors).

- [ ] **Step 3: Запуск полного набора тестов**
Run: `npm test` (все 185+ тестов зелёные).

- [ ] **Step 4: Сборка и перезагрузка плагина**
Run: `npm run build && bb plugin reload provider-pi-durable`.

- [ ] **Step 5: Проверка соответствия лимитам строк AP-019**
Run: `wc -l $(find src/runner src/host -maxdepth 1 -type f)` (<200 runner, <250 host).

- [ ] **Step 6: Запись результатов цикла в `docs/arch-improvement/ledger.md` и обновление `memory.md`**
