# Arch Improvement Cycle 61: Territory Realignment & Decoupling Plan

**Статус:** PENDING APPROVAL (Не выполнять до явной команды пользователя)  
**Governing Standard:** `arch-rules.md` (AP-010 – AP-071) & `arch-improvement-loop`  
**PRD Reference:** `docs/superpowers/specs/2026-10-07-prd-pi-durable-territory-ownership-and-decoupling.md`  

---

## 1. Реестр находок и цели рефакторинга

| ID | Область | Severity | Паттерн / Code Smell | Правило | Решение |
|---|---|---|---|---|---|
| **F-61-1** | `src/runner/prompt.ts` | **P1** | **Feature Envy / Leaky Boundary:** плагин хардкодит правила, сниппеты тулов (`read/bash/edit/write`) и обход `AGENTS.md`, вместо использования API экосистемы Pi. | AP-010, AP-018 | `fix-in-cycle` — Заменить хардкод на динамическое извлечение сниппетов из `create*ToolDefinition()` и контекстных файлов из `resourceLoader.getAgentsFiles()`. |
| **F-61-2** | `src/runner/subagent.ts` & `sessions.ts` | **P1** | **Unclear Provenance / Domain Pollution:** в плагине завендорены прототипы из `packages/coding-agent/src/experimental/durable/`, которых нет в `@earendil-works/pi-durable`. Создается ложное впечатление, что мост владеет сабагентами и файловыми блокировками сессий. | AP-010, AP-011 | `fix-in-cycle` — Вынести эти модули в выделенный каталог `src/runner/upstream/` с фиксацией первоисточника и границ. |
| **F-61-3** | `src/runner/extension-bridge.ts` | **P2** | **Inappropriate Intimacy:** обращение к приватным свойствам через `(api as any).output` и моки внутренних контрактов `runner.bindCore(...)`. | AP-011, AP-029 | `fix-in-cycle` — Типизировать мост, устранить `as any`, оформить явный контракт потокового вывода. |
| **F-61-4** | `src/runner/runtime-loader.ts` | **P2** | **God Method:** 180 строк монолитной сборки рантайма, прокси, расширений и Harness в одном месте. | AP-018, AP-020 | `fix-in-cycle` — Декомпозировать на 3 чистые фазы сборки: чтение настроек, среда расширений, монтирование Harness. |

---

## 2. Пошаговые срезы реализации (Slices)

### Срез 1: Динамический промпт-адаптер (`src/runner/prompt.ts`)
1. **Тесты (TDD):**
   - Написать `tests/prompt-adapter.test.ts`.
   - Проверить, что сниппеты для `read`, `bash`, `edit`, `write` берутся из canonical `create*ToolDefinition()`.
   - Проверить, что файлы `AGENTS.md` извлекаются через `resourceLoader.getAgentsFiles()`.
   - Проверить, что при кастомном `systemPrompt` или `appendSystemPrompt` они прозрачно пробрасываются.
2. **Реализация:**
   - Переработать `src/runner/prompt.ts`: удалить захардкоженные словари `CONTRIBUTIONS` и ручную функцию `loadContextFiles`.
   - Подключить `createReadToolDefinition().promptSnippet`, `createBashToolDefinition().promptSnippet` и т.д.
   - Обеспечить размер файла < 150 строк (AP-019).

### Срез 2: Выделение `upstream/`
1. **Реализация:**
   - Создать папку `src/runner/upstream/`.
   - Переместить `src/runner/subagent.ts` -> `src/runner/upstream/subagent-tool.ts`.
   - Переместить `src/runner/sessions.ts` -> `src/runner/upstream/session-storage.ts`.
   - Добавить в заголовки файлов детальные комментарии о происхождении:
     `// Upstream Shim: Imported from @earendil-works/pi-coding-agent experimental/durable prototype`.
   - Обновить импорты в `runtime-loader.ts`, `session-commands.ts`, `index.ts`.
2. **Проверка:**
   - Запустить существующие тесты сессий (`tests/cwd-isolation.test.ts`, `tests/runner-discovery.test.ts`).

### Срез 3: Типизация и очистка `extension-bridge.ts`
1. **Тесты (TDD):**
   - Расширить `tests/extension-bridge.test.ts` тестами потокового вывода и типизированной передачи контекста.
2. **Реализация:**
   - Устранить `(api as any).output` — заменить на безопасный type-guard или типизированный интерфейс `DurableOutputApi`.
   - Устранить нетипизированные заглушки.
   - Обеспечить размер файла < 160 строк (AP-019).

### Срез 4: Декомпозиция `runtime-loader.ts`
1. **Реализация:**
   - Разбить `loadHarnessEnvironment` на:
     - `resolveHarnessSettings(...)` (настройки, прокси, тайм-ауты);
     - `initializeExtensionBridge(...)` (загрузчик расширений, MCP, провайдеры);
     - `openHarness(...)` (открытие SQLite и регистрация в FSM).
   - Уменьшить размер `runtime-loader.ts` со 188 до ~110 строк.

---

## 3. Критерии приемки и проверка (DoD)

1. [ ] **Никакого хардкода текстов тулов:** В кодовой базе плагина отсутствуют строки `"Read file contents"`, `"Execute bash commands"` и списки файлов `AGENTS.md`. Всё приходит из API Pi.
2. [ ] **Чистая структура:** Осиротевшие прототипы изолированы в `upstream/`.
3. [ ] **Требования очищены:** Устранено ложное требование `npm install -g @earendil-works/pi-durable` в документации и инструкциях.
4. [ ] **0 кастов `any` в адаптере:** `src/runner/extension-bridge.ts` строго типизирован.
5. [ ] **AP-019:** Все файлы в `src/` строго < 200 строк.
6. [ ] **Тесты:** 100% тестов проходят (`npm test`, 47+ тестов).
7. [ ] **Живая верификация:** Запуск сабтреда в BB IDE подтверждает корректность системного промпта, работы `codemode` и MCP серверов.
