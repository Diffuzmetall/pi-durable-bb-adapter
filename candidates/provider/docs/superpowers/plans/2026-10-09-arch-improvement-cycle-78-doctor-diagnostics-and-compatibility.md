# Cycle 78 — Pi Durable Doctor, Environment Diagnostics & Extension Compatibility Matrix

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Date:** 2026-10-09  
**Cycle:** arch-improvement cycle 78  
**Goal:** Реализовать всестороннюю систему диагностики окружения Pi и совместимости расширений (`PiDoctor`), RPC-контракты в хосте и сервере, интерактивный UI-дашборд диагностики в BB IDE вместо устаревшего шаблона todos, CLI-команду `npm run doctor` и устранить дефекты передачи контекста настроек и промпта в `ExtensionRunner`.

---

## Architecture Context Map

- **Stage:** Enhancement & Observability (Cycle 78)
- **Source docs:**
  - `AGENTS.md`
  - `docs/arch-improvement/ledger.md` (Cycles 76, 77)
  - `src/runner/extension-bridge.ts`, `src/runner/extension-mount.ts`, `src/runner/runtime-controller.ts`
- **Active paths:**
  - `src/runner/diagnostics.ts` (NEW — ядро инспекции окружения Pi, AP-019 < 200 строк)
  - `src/host/discovery-handler.ts` (расширение `provider/diagnostics` & `provider/health`)
  - `server.ts` (RPC endpoint `diagnostics_get` для UI плагина)
  - `app.tsx` (UI Dashboard диагностики среды и совместимости расширений)
  - `scripts/doctor.mjs` (CLI диагностика)
  - `src/runner/extension-bridge.ts` (исправление `getSettings` и `getActiveTools` в `bindCore`)
  - `src/runner/runtime-controller.ts` (исправление `emitBeforeAgentStart` параметров)
  - `tests/diagnostics.test.ts` (NEW — детерминированный test suite)
- **Critical gates (arch-rules):**
  - `AP-010`: The Thin Adapter Invariant. Не владеть текстами промптов, не изобретать свой FSM.
  - `AP-019`: Все `.ts` файлы строго < 200 строк (soft 150, hard 250).
  - `AP-026`: Схемы данных и строгая валидация типов.
  - `AP-027`: Безопасная очистка процессов и таймеров.
  - `AP-028`: Детерминированное тестирование `node --test` (100% green).
  - `AP-029`: Zero `any` на границах и типах.
- **Verification surface:**
  - `npx tsc --noEmit` -> 0 errors.
  - `npm test` -> All tests pass (включая `diagnostics.test.ts`).
  - `npm run build` -> Clean bundle (runner + host + server).
  - `node scripts/doctor.mjs` -> Вывод чистой диагностики реального окружения.

---

## Findings selected for fix-now

| ID | Issue / Defect | Severity | Rule | Disposition | Root Cause & Resolution |
|---|---|---|---|---|---|
| **F-78-1** | Отсутствие контракта детальной диагностики Pi окружения | **P1** | AP-013, AP-028 | `fix-now` | Создать `src/runner/diagnostics.ts`, возвращающий структурированный отчет: paths, settings, models, extensions с аудитом поддерживаемых vs неподдерживаемых хуков, tools, skills, health status. |
| **F-78-2** | Заброшенный шаблон Todos в `app.tsx` и `server.ts` | **P1** | AP-010, AP-019 | `fix-now` | Переписать `app.tsx` в полнофункциональный Pi Durable Doctor Dashboard, а в `server.ts` определить метод `diagnostics_get`. |
| **F-78-3** | Дефект передачи контекста в `ExtensionRunner` | **P2** | AP-010, AP-029 | `fix-now` | В `setupExtensionRunner` наполнить `getSettings()` реальными настройками, `getActiveTools()` актуальными тулами. В `runtime-controller.ts` передавать `BuildSystemPromptOptions` в `emitBeforeAgentStart`. |
| **F-78-4** | Отсутствие удобной CLI команды диагностики | **P2** | AP-028 | `fix-now` | Добавить скрипт `scripts/doctor.mjs` и npm-скрипт `"doctor": "node scripts/doctor.mjs"`. |

---

## Tasks & Slice Planning

### Task 1 — Diagnostics Engine (`src/runner/diagnostics.ts` & `tests/diagnostics.test.ts`)
- [ ] **Step 1.1:** Написать тест `tests/diagnostics.test.ts` с проверкой контракта `inspectPiEnvironment()`.
- [ ] **Step 1.2:** Создать `src/runner/diagnostics.ts` (< 200 строк, AP-019, 0 `any` AP-029), собирающий:
  - Проверку путей (`agentDir`, `settings.json`, `mcp.json`, `auth.json`, `models-store.json`, `extensions/`, `skills/`).
  - Настройки из `SettingsManager` (провайдер, модель, thinking, пакеты).
  - Модели и доступные провайдеры из `ModelRuntime`.
  - Список расширений из `DefaultResourceLoader` с аудитом хуков (supported vs unsupported).
  - Список тулов (MCP, custom, built-in) и скиллов.
  - Вердикт `health`: `"healthy" | "warning" | "error"`.
- [ ] **Step 1.3:** Запустить `npm test` и убедиться в прохождении тестов.

### Task 2 — Context Corrections in Runner (`extension-bridge.ts` & `runtime-controller.ts`)
- [ ] **Step 2.1:** В `src/runner/extension-bridge.ts` обновить `setupExtensionRunner`:
  - `getSettings: () => ({ ...(settingsManager.getGlobalSettings() ?? {}), ...(settingsManager.getProjectSettings() ?? {}) })`.
  - `getActiveTools: () => options.getCallableTools ? options.getCallableTools().map(t => t.name) : []`.
- [ ] **Step 2.2:** В `src/runner/runtime-controller.ts` передавать корректный объект `BuildSystemPromptOptions` в `emitBeforeAgentStart`.
- [ ] **Step 2.3:** Проверить тесты `npm test`.

### Task 3 — Host Discovery & Server RPC Integration (`src/host/discovery-handler.ts`, `catalog.ts`, `server.ts`)
- [ ] **Step 3.1:** В `src/host/catalog.ts` добавить метод `getDiagnostics()`, который безопасно вызывает инспекцию или запрашивает раннер.
- [ ] **Step 3.2:** В `src/host/discovery-handler.ts` добавить обработку `provider/diagnostics` и обогатить `provider/health`.
- [ ] **Step 3.3:** В `server.ts` зарегистрировать RPC контракт `diagnostics_get` и подключить к инспектору.

### Task 4 — UI Dashboard (`app.tsx`)
- [ ] **Step 4.1:** Переписать `app.tsx`:
  - Загрузка данных через `rpc.call("diagnostics_get")`.
  - Статусный баннер (Healthy / Warnings / Misconfigured).
  - Блоки: Agent Directory & Config files, Active Model & Provider, Extensions & Hook Support Matrix, MCP & Custom Tools, Skills.
  - Кнопка «Re-run Diagnostics».
- [ ] **Step 4.2:** Проверить сборку `npm run build` (`bb plugin build`).

### Task 5 — CLI Doctor & npm script
- [ ] **Step 5.1:** Добавить `"doctor": "node scripts/doctor.mjs"` в `package.json`.
- [ ] **Step 5.2:** Проверить выполнение `npm run doctor`.

### Task 6 — Verification & Ledger Update
- [ ] **Step 6.1:** Выполнить полную верификацию (`tsc`, `npm test`, `npm run build`).
- [ ] **Step 6.2:** Обновить `docs/arch-improvement/ledger.md` (Cycle 78).
- [ ] **Step 6.3:** Commit and push to main (AGENTS.md hard invariant).
