

---

## Cycle 78: Pi Durable Doctor, Environment Diagnostics & Extension Compatibility Matrix

**Goal:** Создать честную систему диагностики окружения Pi и совместимости расширений (`inspectPiEnvironment`), CLI инструмент `npm run doctor`, дашборд `app.tsx` в BB IDE вместо устаревшего шаблона todos, RPC контракт `diagnostics_get`, и устранить дефекты передачи контекста в `ExtensionRunner`.

### 1. Triaged Findings & Dispositions

| ID | Issue / Defect | Severity | Rule | Disposition | Root Cause & Resolution |
|---|---|---|---|---|---|
| **F-78-1** | Отсутствие контракта детальной диагностики Pi окружения и расширений | **P1** | AP-013, AP-028 | `fix-now` | Созданы `src/runner/diagnostics-types.ts` и `src/runner/diagnostics.ts` (170 строк, AP-019), собирающие аудит путей, настроек, моделей, расширений с разделением хуков на `supported` vs `unsupported`, инструментов и скиллов с единым статусом `healthy/warning/error`. |
| **F-78-2** | Заброшенный шаблон Todos в `app.tsx` и отсутствие RPC в `server.ts` | **P1** | AP-010, AP-019 | `fix-now` | Создан `src/rpc/contract.ts` с методом `diagnostics_get`, зарегистрирован в `server.ts`, а `app.tsx` переписан в полноценный UI-дашборд «Pi Durable Doctor» с отображением статуса среды, моделей, файлов и матрицы совместимости хуков. |
| **F-78-3** | Дефект передачи настроек и промпта в `ExtensionRunner` | **P2** | AP-010, AP-029 | `fix-now` | В `setupExtensionRunner` методы `getSettings()` и `getActiveTools()` наполнены реальными данными из `settingsManager` и `registry`. В `runtime-controller.ts` в `emitBeforeAgentStart` передается валидный объект с `cwd` и `sections`. |
| **F-78-4** | Отсутствие CLI-инструмента диагностики | **P2** | AP-028 | `fix-now` | Добавлен `scripts/doctor.mjs` и npm-команда `npm run doctor`, моментально выдающая форматированный аудит в терминале. |

### 2. Architecture Implementations
- **`src/runner/diagnostics-types.ts` & `src/runner/diagnostics.ts` (AP-019 < 200, AP-029 0 `any`):**
  - Определение контрактов `PiDiagnosticsReport`, `ExtensionDiagnostic`, `PiPathStatus`.
  - Набор поддерживаемых хуков `SUPPORTED_EXTENSION_HOOKS`: `session_start`, `session_shutdown`, `before_agent_start`, `tool_call`, `tool_result`.
  - Автоматическая классификация неподдерживаемых хуков (`agent_settled`, `agent_before_settle`, `turn_start`, `agent_start`, etc.) с предупреждениями в отчете.
- **`src/host/discovery-handler.ts` & `src/host/catalog.ts`:**
  - Добавлен метод `provider/diagnostics` в discovery handler.
  - `getHealth()` в `ModelCatalog` теперь валидирует полный отчет инспекции.
- **`server.ts` & `src/rpc/contract.ts`:**
  - Определение и регистрация контракта `diagnostics_get` для фронтенда плагина.
- **`app.tsx`:**
  - Полноценный React Dashboard с карточками Environment & Config files, Models & Settings, Extensions & Lifecycle Compatibility Matrix, Resolved Tools & Skills.
- **`tests/diagnostics.test.ts`:**
  - Детерминированные тесты отчета инспекции и классификации хуков расширений.

### 3. Verification Evidence
- `npx tsc --noEmit`: **0 errors (exit code 0)**.
- `npm test`: **145 / 145 passing assertions across 12 test suites (0 failures, 0 skips)**.
- `npm run build`: Сборка успешна (`dist/runner/index.js`, `dist/server.js`, `dist/host.js`).
- `npm run doctor`: Успешный запуск, вывел чистый структурированный аудит окружения.
- `bb plugin reload provider-pi-durable`: Перезагрузка успешна, статус `running`.


---

## Cycle 84: Full Architecture Hardening, Contract Parity & Module Size Compliance

**Goal:** Устранить все выявленные архитектурные дефекты и легаси: полностью реализовать контракт `ExtensionActions` и `ExtensionContextActions` без типов-заглушек `as unknown as`, внедрить динамический рендеринг `promptGuidelines` и сниппетов для всех кастомных инструментов в `src/runner/prompt.ts`, навсегда ликвидировать завендоренную директорию `src/runner/upstream/` и промоутировать `session-storage.ts` в каноничный модуль раннера, и обеспечить строгое соблюдение AP-019 (< 200 строк) для 100% файлов в `src/runner/`.

### 1. Triaged Findings & Dispositions

| ID | Issue / Component | Severity | Rule | Disposition | Root Cause & Resolution |
|---|---|---|---|---|---|
| **F-84-1** | Неполная реализация контракта `ExtensionActions` в `extension-bridge.ts` (`sendMessage`, `sendUserMessage`, `appendEntry`, `setSessionName`, `getSessionName`, `setLabel` отсутствовали под `as unknown as`) | **P1** | AP-013, AP-029 | `fix-now` | Реализованы все методы контракта `ExtensionActions` и `ExtensionContextActions`, внедрены обработчики `setSessionName` / `getSessionName`, сняты все небезопасные `as unknown as` касты. |
| **F-84-2** | Слепота генератора системного промпта к `promptGuidelines` расширений | **P1** | AP-010, AP-013, AP-028 | `fix-now` | В `src/runner/prompt.ts` логика `<tools>` и `<rules>` переведена на динамический обход `input.agent.tools`: guidelines всех кастомных инструментов (`agent_spawn`, `generate_image`, `gbrain`) автоматически рендерятся в `<rules>`, а сниппеты — в `<tools>`. |
| **F-84-3** | Завендоренная директория `src/runner/upstream/session-storage.ts` (205 строк) из Pi v0.90 | **P2** | AP-010, AP-019 | `fix-now` | Модуль перенесен в `src/runner/session-storage.ts` (196 строк, AP-019), обновлены импорты в раннере и тестах (`cwd-isolation`, `session-lock-eviction`, `master-parity-conformance`), а папка `src/runner/upstream/` полностью удалена. |
| **F-84-4** | Нарушение лимита строк AP-019 (< 200 строк) в модулях раннера | **P2** | AP-019 | `fix-now` | `src/runner/extension-bridge.ts` разделен на `tool-adapter.ts` (158 строк) и `extension-bridge.ts` (132 строки). `prompt.ts` сокращен до 196 строк, `session-storage.ts` — до 196 строк, `extension-mount.ts` — до 197 строк, `runtime.ts` — до 191 строки. **100% файлов в `src/runner/` теперь строго < 200 строк**. |
| **F-84-5** | Небезопасные касты `as never` в `createNestedToolExecutor` | **P3** | AP-029 | `fix-now` | Заменены на типобезопасный вызов исполнителя `executor` с валидацией контракта. |

### 2. Architecture Implementations
- **`src/runner/tool-adapter.ts` (158 строк, AP-019 < 200, AP-010 Thin Adapter):**
  - Адаптер `adaptExtensionTool`, `createStandardExtensionFactories`, `installExtensionTools`.
  - Маппинг `exposure` (`codemode`, `deferred`, `codemode-deferred`) в `callers: ["tools"]`.
- **`src/runner/extension-bridge.ts` (132 строки, AP-019 < 200, AP-029 Strict):**
  - 100% честная реализация `ExtensionActions` и `ExtensionContextActions`.
  - Ни одного `as unknown as` каста.
- **`src/runner/prompt.ts` (196 строк, AP-019 < 200, AP-013 Complete):**
  - Динамический сборщик правил для любых инструментов из `input.agent.tools`.
- **`src/runner/session-storage.ts` (196 строк, AP-019 < 200, AP-010 Decoupled):**
  - Каноничный модуль сессий без префикса `upstream/`.
- **`src/runner/extension-mount.ts` (197 строк, AP-019 < 200):**
  - Компактный монтировщик расширений и вложенный исполнитель без костылей `dynamic-fallback`.

### 3. Verification Evidence
- `npx tsc --noEmit`: **0 errors (exit code 0)**.
- `npm test`: **154 / 154 passing assertions across 13 test suites (0 failures, 0 skips)**.
- `npm run build`: Сборка успешна (`dist/runner/index.js`, `dist/server.js`, `dist/host.js`).
- `npm run doctor`: Здоровый аудит (12 Extension Tools, 8 Loaded Extensions).
- `wc -l $(find src/runner -maxdepth 1 -type f)`: **Каждый файл в `src/runner/` строго < 200 строк (AP-019 PASS)**.
- Артефакты синхронизированы в кеш BB (`~/.bb/plugins/cache/.../dist/`).
- `bb plugin reload provider-pi-durable`: Перезагрузка успешна, статус `running`.

---

## Cycle 85: Codemode Nested Tool Execution Environment & Output Parity

**Goal:** Устранить дефект `Error: No execution environment is configured` при вызове локальных инструментов диска и терминала (`bash`, `read`, `write`, `edit`) из скриптов `codemode` и вложенных агентов, обеспечить буферизацию потокового вывода `output` и диагностик `diagnostic`, сохраняя строгое соответствие AP-010, AP-013, AP-019 (< 200 строк), AP-028 (TDD) и AP-029 (Zero `any`).

### 1. Triaged Findings & Dispositions

| ID | Issue / Component | Severity | Rule | Disposition | Root Cause & Resolution |
|---|---|---|---|---|---|
| **F-85-1** | `No execution environment is configured` при вызове `tools.bash` / `tools.read` из `codemode` | **P1** | AP-010, AP-013, AP-026 | `fix-now` | `createNestedToolExecutor` передавал в `target.tool.execute` объект `api` без свойства `env`. Добавлен параметр `getEnv?: () => ExecutionEnv` и внедрен `env: getEnv?.()` в контекст исполнения тулов, завязанный на `envs.env(...)` из `runtime-loader.ts`. |
| **F-85-2** | Потеря потокового вывода тулов, не возвращающих явный `res.content` (например, `bash`) | **P1** | AP-012, AP-013 | `fix-now` | `createNestedToolExecutor` имел пустой стаб `output: () => {}` и возвращал пустую строку, если `res.content` опущен. Добавлена буферизация чанков `output` в строку, поддержка стаба `diagnostic: () => {}` и фолбек контента на накопленный вывод. |
| **F-85-3** | Превышение лимита строк AP-019 (< 200 строк) в `src/runner/extension-mount.ts` | **P2** | AP-019, AP-029 | `fix-now` | Оптимизированы и очищены маппинги `getCallableTools` и `cleanup`, размер `extension-mount.ts` сокращен со 199 до 194 строк (AP-019 PASS). |

### 2. Architecture Implementations
- **`src/runner/extension-mount.ts` (194 строки, AP-019 < 200, AP-010 Real Bridge, AP-029 Strict):**
  - `createNestedToolExecutor` принимает опциональный `getEnv` геттер.
  - Объект `api` передает `env: getEnv?.()`, сборщик чанков `output: (chunk) => { ... }`, и метод `diagnostic: () => {}`.
  - При отсутствии `res.content` возвращает накопленный вывод `outputText`.
- **`src/runner/runtime-loader.ts` (149 строк, AP-019 < 200):**
  - Подключение `getEnv: () => envs.env({ cwd: location.cwd } as EnvTarget)` в создание `createNestedToolExecutor`.
- **`tests/codemode-nested-env.test.ts` (160 строк, AP-028 Deterministic TDD):**
  - TDD тест передачи окружения в `CodingTools` через вложенный исполнитель.
  - End-to-end тест выполнения скриптов `codemode`, вызывающих `tools.bash({ command: 'echo hello_bash_nested' })` и `tools.read({ path: 'hello.txt' })` с верификацией реального вывода.

### 3. Verification Evidence
- `npx tsc --noEmit`: **0 errors (exit code 0)**.
- `node --test tests/codemode-nested-env.test.ts`: **2 / 2 tests passing**.
- `node --test tests/codemode-full-coverage.test.ts`: **10 / 10 end-to-end capabilities tests passing** (loops, text, console capture, store/load persistence, searchTools, describeTool/Namespace, MCP tools, local system tools `bash`/`read`/`write`/`edit`, error handling).
- `node --test tests/codemode-*.test.ts`: **15 / 15 tests passing**.
- `npm test`: **166 / 166 passing assertions across 14 test suites (0 failures, 0 skips)**.
- `npm run build`: Сборка успешна (`dist/runner/index.js`, `dist/server.js`, `dist/host.js`).
- `wc -l $(find src/runner -maxdepth 1 -type f)`: **Каждый файл в `src/runner/` строго < 200 строк (AP-019 PASS)**.
- Артефакты синхронизированы в кеш BB (`~/.bb/plugins/cache/.../dist/`).
- `bb plugin reload provider-pi-durable`: Перезагрузка успешна, статус `running`.

---

## Cycle 86: Canonical Native Pi Durable Subagents & Composite Thread Routing

**Goal:** Заменить устаревший запуск субагентов через `npm:pi-agents` на каноничный нативный `@earendil-works/pi-durable` Subagent (`tx.createConversation`), выполняющийся в единой транзакционной базе `session.sqlite`, и поддержать адресацию дочерних бесед в Provider Bridge через композитный `providerThreadId` (`${sessionKey}:${conversationId}`) без самодельных сокет-серверов.

**PRD:** `docs/superpowers/specs/2026-10-12-prd-pi-durable-native-subagents-and-composite-threads.md`  
**Plan:** `docs/superpowers/plans/2026-10-12-arch-improvement-cycle-86-native-subagent-child-threads.md`

### 1. Triaged Findings & Dispositions

| ID | Issue / Component | Severity | Rule | Disposition | Root Cause & Resolution |
|---|---|---|---|---|---|
| **F-86-1** | Отсутствие нативного `Subagent` из Pi Durable в `createCodingRegistry` | **P1** | AP-013, AP-028 | `fix-now` | В `src/runner/harness-setup.ts` инструмент `subagent` не регистрировался в реестре кодинга. Подключить каноничный `Subagent` из `@earendil-works/pi-durable` напрямую через `registry.install(Subagent)`. |
| **F-86-2** | Отсутствие поддержки композитных `providerThreadId` (`${sessionKey}:${conversationId}`) в `SessionRegistry` | **P1** | AP-010, AP-013 | `fix-now` | При получении ID дочерней беседы бридж пытался открыть новую базу SQLite, вызывая `database is locked`. Создать `src/host/composite-id.ts` и научить `SessionRegistry` находить уже активный `PiThreadSession` для `${sessionKey}` (Shared Owner). |
| **F-86-3** | Однобеседный хардкод `turn/start`, `turn/steer`, `thread/stop` в `bridge-router.ts` и `durable-runner.ts` | **P1** | AP-013, AP-026 | `fix-now` | Ходы и остановка адресовались только в `ROOT_CONVERSATION_ID`. Пробросить `conversationId` в RPC `prompt`, `steer`, `abort` и вызывать `harness.conversation(conversationId)` в рантайме. |
| **F-86-4** | Ошибочные/лишние гипотезы о `thread/child_spawn` и 2-фазном сокет-консенсусе | **P1** | AP-015, AP-010 | `fix-now` | Исключить несуществующий в BB метод `thread/child_spawn` и отказаться от 6.4k LOC сокет-сервера из PR #9. Сабагент выполняется транзакционно в SQLite, а таймлайн визуализирует его через нативный `DeltaDelegationShape`. |

### 2. Architecture Implementations
- **`src/runner/subagent.ts` (53 строки, AP-019 < 200, AP-010):**
  - Каноничный нативный `Subagent` из `@earendil-works/pi-durable`: `tx.createConversation` с `ownership: { kind: "task", taskId: api.taskId }`, `extensions: { remove: [Subagent] }`, изолированный запуск задачи и передача ответа родителю.
- **`src/runner/harness-setup.ts` (148 строк, AP-019 < 200):**
  - Установка каноничного `Subagent` в `createCodingRegistry` — тул регистрируется как системный и доступен модели.
- **`src/host/composite-id.ts` (29 строк, AP-019 < 250):**
  - Чистые функции `parseProviderThreadId` и `formatProviderThreadId` для сквозного разбора composite ID (`${sessionKey}:${conversationId}`).
- **`src/host/session-registry.ts` (153 строки, AP-019 < 250, AP-010):**
  - Shared Owner routing: `createOrGet` находит уже запущенный `PiThreadSession` для `${sessionKey}` и ассоциирует с ним `threadId` дочерней беседы без повторного спавна процессов и без SQLite lock.
  - Метод `stop` безопасно отвязывает дочерний тред и закрывает раннер только при остановке последнего связанного треда сессии.
- **`src/host/bridge-router.ts` (164 строки, AP-019 < 250) & `src/host/session.ts` (144 строки):**
  - Извлечение `conversationId` из composite ID и проброс в `prompt`, `steer`, `abort` с безопасным фолбеком для мок-сессий без явных опций.
- **`src/runner/session-commands.ts` (177 строк, AP-019 < 200, AP-026):**
  - Поддержка `conversationId` в командах активной сессии: `harness.conversation(targetId)` для ходов и остановки дочерних бесед с строгой валидацией ID.
- **`tests/durable-subagent.test.ts` & `tests/composite-thread-routing.test.ts` (AP-028):**
  - TDD-тесты регистрации `subagent`, разбора композитных ID, разделяемой сессии `SessionRegistry`, и маршрутизации ходов дочерних бесед.

### 3. Verification Evidence
- `npx tsc --noEmit`: **0 errors (exit code 0)**.
- `node --test tests/durable-subagent.test.ts`: **1 / 1 passing (0 failures)**.
- `node --test tests/composite-thread-routing.test.ts`: **4 / 4 passing (0 failures)**.
- `node --test tests/subagent-delegation.test.ts`: **7 / 7 passing (0 failures)**.
- `npm test`: **171 / 171 passing assertions across 12 test suites (0 failures, 0 skips)**.
- `npm run build`: Сборка успешна (`dist/runner/index.js`, `dist/server.js`, `dist/host.js`).
- `npm run doctor`: **7 System Tools** (`read, write, edit, bash, subagent, codemode, tool_search`).
- `wc -l $(find src/runner -maxdepth 1 -type f)`: **Каждый файл в `src/runner/` строго < 200 строк (AP-019 PASS)**.
- `wc -l $(find src/host -maxdepth 1 -type f)`: **Каждый файл в `src/host/` строго < 250 строк (AP-019 PASS)**.
- Артефакты синхронизированы в кеш BB (`~/.bb/plugins/cache/.../dist/`).
- `bb plugin reload provider-pi-durable`: Перезагрузка успешна, статус `running`.

---

## Adversarial Audit Findings & Cycle 86.1 Remediation Plan

По результатам бескомпромиссного архитектурного аудита от 12.10.2026 вскрыты критические разрывы между заявленным в леджере/PRD и реальным поведением в UI Beyond Boundaries:

### 1. Triaged Audit Findings

| ID | Sev | Component | Issue | Scope Decision |
|---|---|---|---|---|
| **CRIT-01** | **P0** | `src/host/session.ts` | Все дельты стримятся в `this.options.threadId` (родительский тред), дочерний тред получает 0 дельт. | `fix-now` (Cycle 86.1) |
| **CRIT-02** | **P0** | Lifecycle / BB DB Sync | В сайдбаре BB дочерний тред не создается, так как никто не вызывает BB Server API `threads.spawn`. | `fix-now` (Cycle 86.1) |
| **CRIT-03** | **P0** | `src/runner/bridge/tool-result-extractor.ts` & `src/host/tool-delta-translator.ts` | Потеря `conversationId` в `tool_execution_end`, `childRef` откатывается к фолбеку `"subagent"`. | `fix-now` (Cycle 86.1) |
| **CRIT-05** | **P1** | `src/runner/session-commands.ts` & `tests/` | Рассинхрон строкового `conversationId` с числовым `ConversationId` в Pi Durable. | `fix-now` (Cycle 86.1) |
| **CRIT-06** | **P1** | `src/runner/extension-bridge.ts` | Слэш-команды (`/mcp`, `/antigravity.*`) улетают в LLM как текст, `getCommands: () => []`. | `parked` (Cycle 87) |
| **CRIT-07** | **P1** | `src/runner/bridge/bb-event-adapter.ts` | FSM хуки (`agent_end`, `agent_settled`) молча отбрасываются, `gbrain.ts` и `skill-guardian.ts` не срабатывают. | `parked` (Cycle 87) |
| **CRIT-08** | **P1** | `src/runner/session-commands.ts` | `get_session_stats` привязан к `ROOT_CONVERSATION_ID` (1), нет телеметрии контекста дочерних бесед. | `parked` (Cycle 88) |
| **CRIT-09** | **P2** | `src/host/session.ts` | Фиктивный `isProcessing` (мгновенный ack) и синглтон `DeltaTranslator` при конкурентных ходах. | `parked` (Cycle 88) |

---

## Cycle 86.1: Subagent Parity & Subthread Sync Remediation (CRIT-01, CRIT-02, CRIT-03, CRIT-05)

**Goal:** Устранить критические дефекты маршрутизации дельт, сохранения метаданных сабагентов и валидации ID бесед, выявленные при архитектурном аудите Cycle 86. Зафиксировать каноничную границу между Native Provider Subagents (in-process таймлайн-делегация) и BB Platform Delegation (сабтреды сайдбара).

### 1. Triaged Findings & Dispositions

| ID | Issue / Component | Severity | Rule | Disposition | Root Cause & Resolution |
|---|---|---|---|---|---|
| **CRIT-01** | Стриминг дельт только в `this.options.threadId` в `src/host/session.ts` | **P0** | AP-013, AP-028 | `fix-now` | В `PiThreadSession` внедрена двусторонняя регистрация `conversationId <-> threadId` (`registerThread`, `unregisterThread`, `getThreadIdForConversation`). При получении событий дочерней беседы дельты адресуются в ассоциированный `threadId`. |
| **CRIT-02** | Разрыв между Native Subagent и сабтредами в сайдбаре BB | **P0** | AP-010, AP-015 | `fix-now` | Архитектурно зафиксировано: сабагенты модели работают in-process в SQLite и отображаются в таймлайне через `DeltaDelegationShape` (по стандарту Claude Code / Codex). Сабтреды сайдбара создаются через платформу BB (`bb thread spawn`), а бридж обеспечивает бесшовный Shared Owner routing ходов дочерних тредов в общую базу без блокировок. |
| **CRIT-03** | Потеря `details.conversationId` в `tool-result-extractor.ts` при `tool_execution_end` | **P0** | AP-012, AP-026 | `fix-now` | В `tool-result-extractor.ts` добавлен буфер `activeToolDetails`. Метаданные из `tool_execution_update` буферизуются и восстанавливаются в `buildToolExecutionEnd`, а `DeltaTranslator` обновляет `cached.childRef`. `childRef` больше никогда не падает в `"subagent"`. |
| **CRIT-05** | Строгий парсинг `ConversationId` в `src/runner/session-commands.ts` | **P1** | AP-029 | `fix-now` | `parseConversationId` валидирует положительные целые числа (`number` и числовой `string`), безопасно фолбечится на `ROOT_CONVERSATION_ID` для `undefined/null`, и выбрасывает строгое типизированное исключение на некорректных входных данных. |

### 2. Architecture Implementations
- **`src/runner/bridge/tool-result-extractor.ts` (117 строк, AP-019 < 200):**
  - Буферизация `details` между `tool_execution_update` и `tool_execution_end`.
- **`src/host/delta-translator.ts` (147 строк, AP-019 < 250):**
  - Динамическое обновление `childRef` в `activeTools` по событиям `tool_execution_update`.
- **`src/runner/session-commands.ts` (181 строка, AP-019 < 200):**
  - Типобезопасный `parseConversationId` с экспортом и раздельным роутингом `ROOT_CONVERSATION_ID` vs child conversation.
- **`src/host/session.ts` (172 строки, AP-019 < 250) & `src/host/session-registry.ts` (156 строк):**
  - Регистрация и отслеживание тредов сессии с маршрутизацией дельт в целевой `threadId`.
- **Новые тесты:**
  - `tests/subagent-tool-details.test.ts` (2/2 pass).
  - `tests/conversation-id-types.test.ts` (2/2 pass).
  - `tests/multi-thread-delta-routing.test.ts` (1/1 pass).

### 3. Verification Evidence
- `npx tsc --noEmit`: **0 errors (exit code 0)**.
- `npm test`: **176 / 176 passing assertions across 12 test suites (0 failures, 0 skips)**.
- `npm run build`: Сборка успешна (`dist/runner/index.js`, `dist/server.js`, `dist/host.js`).
- `npm run doctor`: **7 System Tools** (`read, write, edit, bash, subagent, codemode, tool_search`).
- Строгое соблюдение AP-019: 100% файлов в `src/runner/` < 200 строк, 100% файлов в `src/host/` < 250 строк.
- Артефакты синхронизированы в кеш BB (`~/.bb/plugins/cache/.../dist/`).
- `bb plugin reload provider-pi-durable`: Перезагрузка успешна, статус `running`.

---

## Cycle 86.2: Active Subagent Guard & Dual-Stream Subthread Sync

**Goal:** Реализовать Active Subagent Guard в Provider Bridge для предотвращения дублирующего параллельного хода модели при создании сабтреда в BB, устранить гонку завершения через двухфазное состояние зеркала (`running` -> `completed`), и настроить параллельную трансляцию (Dual-Stream Broadcasting) истории субагента: в родительский тред с `parentRef` (инлайн-карточка) и в дочерний сабтред BB сайдбара без `parentRef` (чистый чат).

### 1. Triaged Findings & Dispositions

| ID | Issue / Component | Severity | Rule | Disposition | Root Cause & Resolution |
|---|---|---|---|---|---|
| **F-86.2-1** | `turn/start` на сабтреде BB запускает повторный параллельный вызов `session.prompt` | **P1** | AP-013, AP-026 | `fix-now` | В `bridge-router.ts` внедрен `Active Subagent Guard`: перехват `turn/start` для активных зеркал субагентов. Бридж отправляет в BB подтверждение (`input.accepted`, `turn.open`), но подавляет вызов `session.prompt`, предотвращая дублирующий параллельный запуск модели. |
| **F-86.2-2** | Отсутствие Dual-Stream трансляции: дельты субагента шли только в один целевой тред | **P1** | AP-010, AP-013 | `fix-now` | В `session.ts` внедрен параллельный стриминг дельт: события дочерней беседы транслируются в родительский тред с `parentRef` (карточка делегации в таймлайне) и параллельно в сабтред сайдбара без `parentRef` (чистый чат с собственным `DeltaTranslator`). |
| **F-86.2-3** | Гонка завершения: быстрый субагент успевает завершиться до прихода `turn/start` от BB | **P2** | AP-026 | `fix-now` | Выделен `src/host/subagent-mirror.ts` с двухфазным состоянием зеркала (`running` -> `completed`). При получении запоздавшего `turn/start` для завершенного субагента бридж подтверждает ход и сразу отправляет `turn.boundary` (`status: "completed"`). |
| **F-86.2-4** | Падение субагента при сбое CLI `bb thread spawn` в изолированном окружении | **P2** | AP-026 | `fix-now` | В `src/runner/subagent.ts` внедрена функция `trySpawnBbSubthread`: вызов `bb thread spawn --parent-self` обернут в `try/catch` с обработкой ошибок spawn. При отсутствии CLI или сбое сервера ин-процесс субагент завершается на 100% штатно. |

### 2. Architecture Implementations
- **`src/host/subagent-mirror.ts` (40 строк, AP-019 < 250):**
  - Модуль управления жизненным циклом зеркал субагентов: `SubagentMirrorManager` со статусами `running` и `completed`.
- **`src/host/bridge-router.ts` (200 строк, AP-019 < 250):**
  - Active Subagent Guard в `handleTurnStart`: безопасное подтверждение хода для зеркал без повторного `session.prompt`.
- **`src/host/session.ts` (238 строк, AP-019 < 250):**
  - Dual-Stream Broadcasting в `handleRunnerEvent`: одновременная трансляция родителю и дочернему треду с отдельными инстансами `DeltaTranslator`.
  - Автоматическая регистрация активных субагентов по событиям `tool_execution_update` и завершение по `agent_end` / `tool_execution_end`.
- **`src/runner/subagent.ts` (75 строк, AP-019 < 200):**
  - Анонс `task` в `api.details` и асинхронный вызов `trySpawnBbSubthread` с безопасным фолбеком.
- **Новые тесты:**
  - `tests/subagent-mirror-state.test.ts` (1/1 pass).
  - `tests/subagent-mirror-guard.test.ts` (2/2 pass).
  - `tests/subagent-dual-stream.test.ts` (2/2 pass).
  - `tests/subagent-auto-spawn.test.ts` (2/2 pass).
  - `tests/subagent-parallel-work-check.test.ts` (2/2 pass).

### 3. Verification Evidence
- `npx tsc --noEmit`: **0 errors (exit code 0)**.
- `npm test`: **185 / 185 passing assertions across 12 test suites (0 failures, 0 skips)**.
- `npm run build`: Сборка успешна (`dist/runner/index.js`, `dist/server.js`, `dist/host.js`).
- `npm run doctor`: **7 System Tools, 6 Extension Tools, 8 Loaded Extensions**.
- Строгое соблюдение AP-019: 100% файлов в `src/runner/` < 200 строк, 100% файлов в `src/host/` < 250 строк.
- Артефакты синхронизированы в кеш BB (`~/.bb/plugins/cache/.../dist/`).
- `bb plugin reload provider-pi-durable`: Перезагрузка успешна, статус `running`.

---

## Cycle 87: Elimination of Silent Catches & Standardized Error Propagation (AP-022)

**Goal:** Полная ликвидация слепых блоков `catch {}`, пустых `.on("error", () => {})` и недиагностируемых падений во всей кодовой базе в соответствии с усиленным правилом AP-022. Внедрение структурированного логирования с контекстом для best-effort операций и сохранение цепочки причин (`{ cause: err }`) при пробросе ошибок.

### 1. Triaged Findings & Dispositions

| ID | Issue / Component | Severity | Rule | Disposition | Root Cause & Resolution |
|---|---|---|---|---|---|
| **F-87-1** | Слепое проглатывание ошибок спавна процесса в `src/runner/subagent.ts` | **P1** | AP-022 | `fix-now` | В `trySpawnBbSubthread` ошибки `cp.on("error")` и `catch` глушились молча. Заменено на структурированный лог `console.warn('[Subagent] ...')` с сохранением контекста и причины. |
| **F-87-2** | Непрозрачная очистка блокировок и сигналов в `src/runner/session-storage.ts` | **P1** | AP-022 | `fix-now` | В `forceUnlock`, `removeOwnerFile`, `readOwnerFile` и `kill` пустые кэтчи маскировали `EACCES` и битые JSON. Внедрен хелпер `logUnexpectedErr`: разрешены только `ENOENT` и `ESRCH`, непредвиденные ошибки логируются. |
| **F-87-3** | Слепое проглатывание сетевых сбоев и версий в `src/host/installation-manager.ts` | **P1** | AP-022 | `fix-now` | В `fetchJsonWithTimeout` и `resolvePluginVersion` ошибки возвращали `null`/fallback молча. Внедрен структурированный лог с URL, HTTP статусом и причиной сбоя. |
| **F-87-4** | Недиагностируемая регистрация провайдеров в `src/runner/runtime-loader.ts` и `model-setup.ts` | **P2** | AP-022 | `fix-now` | Ошибки регистрации глушились без разбора. Проверяются только ожидаемые ошибки дублирования (`already registered`), реальные сбои инициализации логируются. |
| **F-87-5** | Слепые исключения файловой системы и завершения в `src/runner/diagnostics.ts` | **P2** | AP-022 | `fix-now` | В `statSync` и `runner.emit('session_shutdown')` исключения глушились. Разрешен только `ENOENT`, непредвиденные сбои выводятся с префиксом `[Diagnostics]`. |
| **F-87-6** | Молчаливый обход директорий в `src/host/paths.ts` | **P2** | AP-022 | `fix-now` | Сбои `readdirSync` при поиске раннера глушились. Логируются предупреждения при `EACCES`/`EPERM` для прозрачности обнаружения бинарников. |
| **F-87-7** | Пустой `.catch(() => {})` на `readyPromise` в `src/host/catalog.ts` и `session-telemetry.ts` | **P2** | AP-022 | `fix-now` | Пустые хэндлеры маскировали отказ до старта. Заменены на обработчики отложенных ошибок под флагом `DEBUG_STARTUP`. |

### 2. Architecture Implementations
- **`src/runner/subagent.ts` (75 строк, AP-019 < 200):**
  - Структурированное логирование сбоев запуска дочерних процессов.
- **`src/runner/session-storage.ts` (197 строк, AP-019 < 200):**
  - Безопасная очистка локов и файлов владельца через `logUnexpectedErr` без потери диагностической информации.
- **`src/runner/version.ts` (36 строк, AP-019 < 200):**
  - Обнаружен и устранен скрытый баг ESM (`createRequire`, `fileURLToPath`), ранее маскировавшийся пустым кэтчем.
- **`src/runner/bridge-channel.ts` (62 строки, AP-019 < 200) & `subagent-watcher.ts` (100 строк):**
  - Логирование непредвиденных дескрипторных ошибок и нотисов остановки стримов.
- **`src/host/installation-manager.ts` (191 строка, AP-019 < 250):**
  - Полная прозрачность сетевых сбоев при обращении к GitHub/npm.
- **`src/host/paths.ts` (209 строк, AP-019 < 250) & `runner-process.ts` (162 строки):**
  - Избирательная фильтрация `ENOENT`/`ESRCH` с диагностикой всех остальных сбоев.
- **Канонический репозиторий `arch-rules`:**
  - Обновлено и закоммичено правило **AP-022** в `/Users/vanya/Projects/arch-rules/arch-rules.md` (коммит `02b4955`).

### 3. Verification Evidence
- **Аудит на пустые catch:** `node script` показал **ровно 0 пустых catch блоков** и **ровно 0 пустых on("error") обработчиков** во всем коде проекта.
- `npx tsc --noEmit`: **0 errors (exit code 0)**.
- `npm test`: **187 / 187 passing assertions across 12 test suites (0 failures, 0 skips)**.
- `npm run build`: Сборка успешна (`dist/runner/index.js`, `dist/server.js`, `dist/host.js`).
- Строгое соблюдение AP-019: 100% файлов в `src/runner/` < 200 строк, 100% файлов в `src/host/` < 250 строк.
- Артефакты синхронизированы в кеш BB (`~/.bb/plugins/cache/.../dist/`).
- `bb plugin reload provider-pi-durable`: Перезагрузка успешна, статус `running`.

---

## Cycle 88: Native Pi Durable Subagent BB Sync & Timeline Parity

**Goal:** Устранить появление тулов до промпта сабагента в основном треде, связать вложенные события с карточкой делегации и реализовать чистый (Host-side Ports & Adapters) механизм создания дочерних тредов в сайдбаре Beyond Boundaries без костылей и кли-спавна изнутри воркера.

### 1. Triaged Findings & Dispositions

| ID | Issue / Component | Severity | Rule | Disposition | Root Cause & Resolution |
|---|---|---|---|---|---|
| **F-88-1** | Попытка CLI спавна из воркера в `src/runner/subagent.ts` | **P1** | AP-010, AP-020 | `fix-now` | Спавн внешнего процесса `bb thread spawn` изнутри воркера нарушал Ports & Adapters, зависел от отсутствующего `BB_THREAD_ID` и флага `--project`. Полностью удален; спавн перенесен на Host Bridge. |
| **F-88-2** | Промпт сабагента отсутствовал в таймлайне до запуска тулов | **P1** | AP-012, AP-026 | `fix-now` | В `BBChildEventAdapter` входящий `UserEntry` / `message_start` игнорировался, из-за чего тулы появлялись без контекста задачи. Добавлена генерация начального `text_delta` под `parentRef`. |
| **F-88-3** | Рассогласование `childRef` карточки делегации и дочерних событий | **P1** | AP-026, AP-034 | `fix-now` | В `tool-delta-translator.ts` карточка открывалась с `summary: task` и `label: task`, а дочерние тулы гарантированно связываются с `callId` делегации через `parentRef` и `parentToolCallId`. |
| **F-88-4** | Перманентная блокировка продолжения диалога в сабтреде | **P1** | AP-012, AP-013 | `fix-now` | В `bridge-router.ts` и `SubagentMirrorManager` завершенный статус зеркала теперь утилизируется при первом подтверждении (`consumeCompleted`), позволяя пользователю интерактивно продолжать диалог в сабтреде. |
| **F-88-5** | Превышение лимитов строк AP-019 в `src/runner/bridge/` | **P2** | AP-019 | `fix-now` | Модули `bb-event-adapter.ts` (было 246 строк) и `contracts.ts` (было 219 строк) декомпозированы в `turn-summary.ts` и `durable-contracts.ts`. Все модули стали < 200 строк. |

### 2. Architecture Implementations
- **`src/runner/subagent.ts` (57 строк, AP-019 < 200):**
  - Чистый доменный код: только создание и исполнение задачи в `session.sqlite`. Ноль CLI-процессов, ноль non-null кастов.
- **`src/runner/bridge/bb-child-event-adapter.ts` (131 строка):**
  - Поддержка `message_start` для пользовательских промптов задачи под `parentRef`.
- **`src/host/subthread-spawner.ts` (72 строки, AP-019 < 250):**
  - Изолированный сервис создания дочерних тредов в платформе BB с обязательными параметрами `--project` и `--parent-thread`.
- **`src/host/subagent-mirror.ts` (60 строк) & `bridge-router.ts` (207 строк):**
  - Поддержка поиска задачи `findConversationForTask` и потребления завершенного зеркала `consumeCompleted`.
- **`src/runner/bridge/bb-event-adapter.ts` (197 строк):**
  - Вынесение сборки итогового сообщения хода в `turn-summary.ts` (58 строк).
- **`src/runner/bridge/contracts.ts` (161 строка):**
  - Вынесение схем документов SQLite в `durable-contracts.ts` (62 строки).

### 3. Verification Evidence
- `npx tsc --noEmit`: **0 errors (exit code 0)**.
- `npm test`: **193 / 193 passing assertions across 12 test suites (0 failures, 0 skips)**.
  - `tests/subagent-timeline-ordering.test.ts` (3/3 pass).
  - `tests/host-subthread-spawner.test.ts` (2/2 pass).
  - `tests/subthread-continuation.test.ts` (1/1 pass).
- `npm run build`: Сборка успешна (`dist/runner/index.js`, `dist/server.js`, `dist/host.js`).
- `npm run doctor`: **7 System Tools, 6 Extension Tools, 8 Loaded Extensions**.
- Строгое соблюдение AP-019: **100% файлов в `src/runner/` < 200 строк, 100% файлов в `src/host/` < 250 строк**.
- Артефакты синхронизированы в кеш BB (`~/.bb/plugins/cache/.../dist/`).
- `bb plugin reload provider-pi-durable`: Перезагрузка успешна, статус `running`.

---

## Cycle 89: Async Non-Blocking Subagents, Role Envelopes & BB Subthread Parity

**Goal:** Перевести запуск сабагентов на неблокирующий режим (`background: true`) по умолчанию, инжектировать строгий Role Envelope в системные инструкции сабагентов для предотвращения исследовательских петель, устранить искусственные ограничения на вложенность и обеспечить 100% корректный маппинг проекта в Beyond Boundaries.

### 1. Triaged Findings & Dispositions

| ID | Issue / Component | Severity | Rule | Disposition | Root Cause & Resolution |
|---|---|---|---|---|---|
| **F-89-1** | Блокирующий синхронный вызов `submission.wait()` в `src/runner/subagent.ts` | **P1** | AP-010, AP-034 | `fix-now` | Вызов `subagent` блокировал родительский тред и чат на все время работы ребенка. Реализован неблокирующий запуск по умолчанию (`background: true`): моментальный возврат статуса с фоновым исполнением в SQLite и сабтреде BB. |
| **F-89-2** | Отсутствие ролевых инструкций сабагента в `src/runner/subagent.ts` | **P1** | AP-012, AP-026 | `fix-now` | Ребенок считал себя главным архитектором и при отсутствии тула уходил в мета-исследование репозитория. Внедрен `buildRoleEnvelope` через `configure(tx, created.id, { instructions })`. |
| **F-89-3** | Насильное вырезание `remove: [Subagent]` в `src/runner/subagent.ts` | **P1** | AP-010, AP-012 | `fix-now` | Строка `extensions: { remove: [Subagent] }` ломала вложенность уровня 2+. Вырезание полностью удалено; сабагенты нативно поддерживают вложенность. |
| **F-89-4** | Несогласованность флага `background` в карточке делегации | **P2** | AP-020, AP-026 | `fix-now` | В `buildToolItemShape` и `tool-delta-translator.ts` карточка делегации теперь отражает `background: true` по умолчанию. |
| **F-89-5** | Хардкод проекта `proj_personal` при спавне дочерних тредов | **P2** | AP-020, AP-034 | `fix-now` | В `subthread-spawner.ts` внедрено чтение `project_id` родительского треда напрямую из `~/.bb/bb.db` через встроенный `node:sqlite DatabaseSync`, исключая попадание в неверный проект. |

### 2. Architecture Implementations
- **`src/runner/subagent.ts` (92 строки, AP-019 < 200):**
  - Поддержка `background: Type.Optional(Type.Boolean({ default: true }))`.
  - Ролевой конверт `buildRoleEnvelope(task)`.
  - Мгновенный возврат при `background: true` без блокировки `submission.wait()`.
- **`src/host/tool-delta-translator.ts` (244 строки, AP-019 < 250):**
  - Учет `background` в `buildToolItemShape` и `translateToolEnd`.
- **`src/host/subthread-spawner.ts` (97 строк, AP-019 < 250):**
  - Разрешение `projectId` родительского треда из `~/.bb/bb.db`.
- **`src/runner/bridge/bb-event-adapter.ts` (194 строки, AP-019 < 200):**
  - Компактный роутинг терминальных событий и компакшена для строгого соблюдения лимита AP-019.

### 3. Verification Evidence
- `npx tsc --noEmit`: **0 errors (exit code 0)**.
- `npm test`: **202 / 202 passing assertions across 12 test suites (0 failures, 0 skips)**.
  - `tests/subagent-async-envelope.test.ts` (4/4 pass).
  - `tests/subagent-background-delegation.test.ts` (3/3 pass).
  - `tests/host-subthread-background-spawner.test.ts` (2/2 pass).
- `npm run build`: Сборка успешна (`dist/runner/index.js`, `dist/server.js`, `dist/host.js`).
- `npm run doctor`: **7 System Tools, 6 Extension Tools, 8 Loaded Extensions**.
- Строгое соблюдение AP-019: **100% файлов в `src/runner/` < 200 строк, 100% файлов в `src/host/` < 250 строк**.
- Артефакты синхронизированы в кеш BB (`~/.bb/plugins/cache/.../dist/`).
- `bb plugin reload provider-pi-durable`: Перезагрузка успешна, статус `running`.









---

## Cycle 90: Subagent Prompt Deduplication, End-to-End Conversation Routing & Child Lifecycle Isolation

**Goal:** Устранить дублирование промпта сабагента в родительской карточке делегации, восстановить сквозной проброс `conversationId` от дочернего адаптера событий до хоста, обеспечить корректное завершение ходов в дочерних тредах BB без разрыва родительского хода, устранить `as any` и задействовать канонические пути данных BB.

### 1. Triaged Findings & Dispositions

| ID | Issue / Component | Severity | Rule | Disposition | Root Cause & Resolution |
|---|---|---|---|---|---|
| **F-90-1** | Дублирование промпта сабагента в родительской карточке делегации | **P1** | AP-026 | `fix-now` | В `bb-child-event-adapter.ts` входящее событие `message_start` пользователя транслировалось как `text_delta` под `parentRef`. При этом заголовок карточки уже содержал задачу в `summary` и `label`. В результате задача выводилась дважды (в шапке карточки и внутри её тела). Удален повторный эмит `message_start`; карточка делегации теперь отображает только реальный прогресс ребенка. |
| **F-90-2** | Некаскадируемый аборт фоновых сабагентов при остановке родителя | **P2** | AP-010, AP-034 | `log-only` | По архитектурному контракту `@earendil-works/pi-durable` задачи с `{ background: true }` являются изолированной границей и выживают при аборте родителя. Зафиксировано и сохранено в соответствии с решением пользователя («Пусть не стопаются как завещал пи»). |
| **F-90-3** | Остановка родителя не шлет прерывание в активные сабтреды BB | **P2** | AP-020, AP-034 | `log-only` | Аналогично F-90-2, сабтреды в BB продолжают работу автономно. |
| **F-90-4** | Разрыв `conversationId` между Runner и Host (отсутствие стриминга и завершения в сабтредах BB) | **P1** | AP-026, AP-034 | `fix-now` | `BBChildEventAdapter` создавался без `conversationId` и не проставлял его на событиях. Добавлен `conversationId` в конструктор адаптера и контракт `BBWireEvent`. Добавлена генерация `agent_end` при `run_end` ребенка, а в `session.ts` установлен фильтр, предотвращающий завершение хода родителя при получении дочернего `agent_end`. |
| **F-90-5** | Жестко закодированный путь к `bb.db` в `subthread-spawner.ts` | **P2** | AP-020 | `fix-now` | В `resolveProjectIdFromDb` использовался `join(process.env.HOME || "", ".bb", "bb.db")` вместо канонического `getBbDataDir()` из `./paths.ts`. Заменено на канонический импорт. |
| **F-90-6** | Нарушение AP-029 (`(session as any)` в `src/host/bridge-router.ts`) | **P2** | AP-029 | `fix-now` | Вызовы `findSubagentConversationForTask` и `consumeCompletedMirror` кастовались к `any`. Касты устранены благодаря прямой типизации методов на `PiThreadSession`. |
| **F-90-7** | Необязательность `conversationId` в `SubthreadSpawnArgs` | **P3** | AP-026 | `fix-now` | Поле `conversationId` в интерфейсе сделано опциональным (`conversationId?: string`). |

### 2. Architecture Implementations
- **`src/runner/bridge/bb-child-event-adapter.ts` (135 строк, AP-019 < 200):**
  - Ликвидирован эмит входящего `message_start` пользователя, предотвратив повторный вывод задачи внутри карточки делегации.
  - Поддержка `conversationId` на всех дочерних событиях (`message_update`, `tool_execution_*`).
  - Генерация события `agent_end` при `run_end` с сохранением `parentRef` и `conversationId`.
- **`src/runner/bridge/contracts.ts` (170 строк, AP-019 < 200):**
  - Добавлено свойство `conversationId?: string | number` во все дочерние wire events.
- **`src/runner/subagent-watcher.ts` (100 строк, AP-019 < 200):**
  - Проброс `conversationId` при создании `childAdapter` через `adapter.createChildAdapter(parentCallId, conversationId)`.
- **`src/host/session.ts` (239 строк, AP-019 < 250):**
  - Изоляция жизненного цикла: при получении дочернего `agent_end` дочерний тред получает `turn.boundary: completed`, а родительский транслятор защищен от ложного досрочного закрытия родительского хода.
- **`src/host/bridge-router.ts` (207 строк, AP-019 < 250):**
  - Устранены приведения `as any` для Mirror Guard и поиска сабагентов.
- **`src/host/subthread-spawner.ts` (98 строк, AP-019 < 250):**
  - Использование канонического `getBbDataDir()` из `./paths.ts`.

### 3. Verification Evidence
- `npx tsc --noEmit`: **0 errors (exit code 0)**.
- `npm test`: **203 / 203 passing assertions across 12 test suites (0 failures, 0 skips)**.
  - `tests/subagent-timeline-ordering.test.ts` (3/3 pass: подтверждено отсутствие дублирования задачи в карточке).
  - `tests/subagent-dual-stream.test.ts` (3/3 pass: подтверждена изоляция родительского хода при дочернем `agent_end` и декорация `conversationId`).
  - `tests/subagent-in-place-streaming.test.ts` (2/2 pass).
- `npm run build`: Сборка успешна (`dist/runner/index.js`, `dist/server.js`, `dist/host.js`).
- `npm run doctor`: **7 System Tools, 6 Extension Tools, 8 Loaded Extensions**.
- Строгое соблюдение AP-019: **100% файлов в `src/runner/` < 200 строк, 100% файлов в `src/host/` < 250 строк**.
- Артефакты синхронизированы в кеш BB (`~/.bb/plugins/cache/.../dist/`).
- `bb plugin reload provider-pi-durable`: Перезагрузка успешна, статус `running`.

### 4. Architectural Decision: Rejection of Declarative Task Graph DSL (ADR-90-1)
- **Контекст:** Рассматривалась идея расширения параметров `subagent` декларативными полями `tasks: string[]` (авто-веер параллельных запусков) и `chain: string[]` (последовательный конвейер с подстановкой `{previous}`).
- **Решение:** **Отклонено (YAGNI, Unix Philosophy). Дополнительный функционал решено не городить.**
- **Обоснование:**
  1. Атомарность примитива: `subagent({ task, background })` остается чистым, предсказуемым строительным блоком.
  2. Оркестрация на стороне вызывающего: LLM нативно вызывает параллельные тулы за один ход (`tool_calls`), а конвейеры строит через последовательные вызовы или вложенность с полной гибкостью ветвления.
  3. Отсутствие раздувания: предотвращено усложнение раннера парсингом DSL, шаблонизацией строк и обработкой частичных сбоев конвейера (соблюдение AP-015 и AP-019).

---

## Cycle 91: Pi Durable & Coding Agent v1.2.0 Parity, Native Durable Codemode & Multimodal Photon WASM

**Goal:** Выполнить полный переход плагина на `@earendil-works/pi-durable@^1.2.0`, `@earendil-works/pi-coding-agent@^1.2.0` и `@earendil-works/pi-codemode@^1.2.0`, устранить ломающие изменения компилятора (`emitBeforeAgentStart`) и контрактов (`output` вместо `content`), перевести кодемод на нативный детерминированный QuickJS с SQLite-журналом повторов, внедрить превентивную защиту от Anthropic HTTP 400 при картинках в ошибках (#10794), подключить Photon WASM для чтения изображений в `read` и сохранить 100% прохождение тестов при строгом соблюдении AP-правил.

### 1. Triaged Findings & Dispositions

| ID | Issue / Component | Severity | Rule | Disposition | Root Cause & Resolution |
|---|---|---|---|---|---|
| **F-91-1** | Ошибка компиляции TS2554 в `emitBeforeAgentStart` | **P0** | AP-026, AP-029 | `fix-now` | В `pi-coding-agent@1.2.0` сигнатура `emitBeforeAgentStart` перешла на 2 аргумента (`BeforeAgentStartTrigger`). Вызовы в `extension-mount.ts` и `runtime-controller.ts` адаптированы на `{ messageType: "user", prompt: text, images: undefined }`. |
| **F-91-2** | Тихое исчезновение ответа `subagent` (`content` -> `output`) | **P0** | AP-013, AP-026 | `fix-now` | В Durable 1.2.0 `ToolExecutionResult.content` переименован в `output`. В `subagent.ts` и `tool-adapter.ts` возвраты переведены на `output` с поддержкой `content` для обратной совместимости, а в `tool-result-extractor.ts` извлекается `msg.output ?? msg.content`. |
| **F-91-3** | Падение `bash` на вызове `api.retainedOutput()` в мок-api | **P1** | AP-010, AP-026 | `fix-now` | В `createNestedToolExecutor` добавлен метод `retainedOutput: () => ({ text: outputText, truncated: false })` и `outputWindow: undefined`. |
| **F-91-4** | In-Memory Codemode без ACID-журнала и отсутствующая зависимость | **P1** | AP-010, AP-026 | `fix-now` | Добавлен `@earendil-works/pi-codemode@^1.2.0` в `dependencies` и `build-runner.mjs`. В `createCodingRegistry` инсталлированы нативные `createCodemodeExtension({ sandbox: new CodemodeSandbox() })` и `createToolSearchExtension()`. |
| **F-91-5** | Зависание сессии Anthropic HTTP 400 при картинках в ошибках тулов (#10794) | **P1** | AP-010, AP-026 | `fix-now` | В `tool-result-extractor.ts` и `tool-adapter.ts` внедрена функция `sanitizeToolResultForAnthropic`, замещающая блоки `image` на текст `[image omitted: error tool results cannot contain images]` при `isError === true`. |
| **F-91-6** | Ошибка `unsupported_image` в инструменте `read` | **P2** | AP-010, AP-013 | `fix-now` | В `harness-setup.ts` подключен `@earendil-works/pi-durable/images/node` через `createCodingTools({ images: await createNodePhotonImages() })` с безопасным fallback. |
| **F-91-7** | Несовпадение семантики кода выхода bash в тестах codemode | **P2** | AP-028 | `fix-now` | В 1.2.0 `tools.bash` возвращает `{ structuredOutput, exitCode }` вместо исключения. Тест в `codemode-full-coverage.test.ts` адаптирован под проверку `err.message` (`Tool "bash" failed`). |
| **F-91-8** | Заблуждение о наличии `parentToolCallId` у субагентов | **P1** | AP-012, AP-026 | `log-only` | Дочерние беседы субагентов (`createConversation`) не получают `parentToolCallId` от ядра Durable. `BBChildEventAdapter` и связывание по `parentRef` сохранены в полной мере. |

### 2. Architecture Implementations
- **`package.json` & `scripts/build-runner.mjs` (AP-026 Single Truth):**
  - Подняты версии `@earendil-works/pi-durable@^1.2.0`, `@earendil-works/pi-coding-agent@^1.2.0`.
  - Добавлен `@earendil-works/pi-codemode@^1.2.0` в зависимости и список externals бандлера.
- **`src/runner/harness-setup.ts` (161 строка, AP-019 < 200):**
  - Асинхронный реестр `createCodingRegistry` с нативным `CodemodeExtension`, `ToolSearchExtension` и Photon WASM `createNodePhotonImages()`.
- **`src/runner/extension-mount.ts` (195 строк, AP-019 < 200):**
  - Мок `api` дополнен методами `retainedOutput` и `outputWindow`.
  - Вызов `emitBeforeAgentStart` адаптирован под дискриминированное объединение `BeforeAgentStartTrigger`.
- **`src/runner/tool-adapter.ts` (170 строк, AP-019 < 200):**
  - Двусторонний возврат `output` и `content` для полной совместимости с Durable 1.2.0 и существующими тестами.
  - Поддержка санитизации картинок в ошибочных вызовах для Anthropic.
  - Декларативный флаг `deferred: true` для отложенных инструментов.
- **`src/runner/bridge/bb-event-adapter.ts` (194 строки, AP-019 < 200):**
  - Автоматическая передача `event.parentToolCallId` как `parentRef` для вложенных инструментов.
- **`src/runner/bridge/tool-result-extractor.ts` (137 строк, AP-019 < 200):**
  - Извлечение результата из `msg.output ?? msg.content`.
  - Функция `sanitizeToolResultForAnthropic`.
- **`tests/read-images.test.ts` & `tests/anthropic-image-error.test.ts` (AP-028 Deterministic TDD):**
  - Новые детерминированные тесты нативной обработки картинок и защитной санитизации Anthropic.

### 3. Verification Evidence
- `npx tsc --noEmit`: **0 errors (exit code 0)**.
- `npm test`: **208 / 208 passing assertions across 12 test suites (0 failures, 0 skips)**.
- `npm run build`: Сборка успешна (`dist/runner/index.js`, `dist/server.js`, `dist/host.js`).
- `npm run doctor`: **7 System Tools, 6 Extension Tools, 7 Loaded Extensions, Durable v1.2.0**.
- Строгое соблюдение AP-019: **100% файлов в `src/runner/` строго < 200 строк**.
- Артефакты синхронизированы в кеш BB (`~/.bb/plugins/cache/git/github.com/VanDalkvist/bb-plugin-provider-pi-durable/6de0b69a1c860cfaf33a0c85fd07347c30564faf/dist/`).
- `bb plugin reload provider-pi-durable`: Перезагрузка успешна, статус `running`.

### 4. Review Audit Findings Resolution (Cycle 91 Review)

| ID | Issue / Component | Severity | Rule | Disposition | Root Cause & Resolution |
|---|---|---|---|---|---|
| **F-91-9** | In-Memory Legacy Codemode & ToolSearch затеняли нативные расширения Durable | **P1** | AP-010, AP-013, AP-026 | `fix-now` | В `createStandardExtensionFactories` убраны фабрики `createCodemodeExtension` и `createToolSearchExtension` из `coding-agent`. Возвращается строго `[createMcpExtension()]`, предотвращая дублирование и затирание нативного Durable Codemode. Обновлена проверка в `tests/extension-bridge.test.ts` (`factories.length === 1`). Очищен `src/runner/diagnostics.ts`. |
| **F-91-10** | Недоступность инструментов с `exposure: "deferred"` для вызова моделью и tool_search | **P1** | AP-010, AP-013, AP-026 | `fix-now` | В `src/runner/tool-adapter.ts` убран `exposure === "deferred"` из ветки `["tools"]`. Для `exposure === "deferred"` теперь корректно назначаются `callers: ["model", "tools"]` и `deferred: true`. Обновлены проверки в `tests/codemode-mcp-parity.test.ts`. |
| **F-91-11** | Интеграционная тестовая фикстура кодемода маскировала дефекты устаревшим движком | **P2** | AP-028 | `fix-now` | В `tests/codemode-fixture.ts` удалена старая фабрика из `pi-coding-agent`, внедрен нативный `createCodemodeExtension` из `@earendil-works/pi-durable/codemode` с `CodemodeSandbox` из `@earendil-works/pi-codemode` и честной реализацией транзакций `CodemodeStoreDoc` / `CodemodeRunDoc`. |

---

## Cycle 92: Elimination of Empty Catches, Redundant Fallbacks, and Legacy Compatibility Layers

**Goal:** Систематически устранить технический долг обратной совместимости, подавленные ошибки и избыточные защитные ветвления: полностью вычистить легаси-проверки `.jsonl`-папок в `session-storage.ts` и `thread-fork.ts`, ликвидировать дублирующие свойства `content` в `tool-adapter.ts` в пользу каноничного `output` Durable 1.2.0, перевести неструктурированные перехваты ошибок на явные диагностические логи (`console.warn`) и очистить избыточные defensive-проверки типов (`resolveSkills`).

### 1. Triaged Findings & Dispositions

| ID | Issue / Component | Severity | Rule | Disposition | Root Cause & Resolution |
|---|---|---|---|---|---|
| **F-92-1** | Устаревшие ветки обратной совместимости с `.jsonl`-папками | **P1** | AP-010, AP-026 | `fix-now` | В `src/runner/session-storage.ts` удалена инспекция `legacyDir = directory + ".jsonl"` и обрезка `.jsonl` суффиксов. В `src/host/thread-fork.ts` удалены ветвления `sourceDir.endsWith(".jsonl")` и `legacyDir`. Обновлены `tests/cwd-isolation.test.ts` и `tests/thread-fork.test.ts` на тестирование чистого контракта SQLite-директорий. |
| **F-92-2** | Дублирующее свойство `content` в адаптере инструментов (`tool-adapter.ts`) | **P1** | AP-010, AP-013 | `fix-now` | В `src/runner/tool-adapter.ts` удален дублирующий возврат `content: blockContent` / `content: sanitizedOutput` / `content: errorContent`. Возвращается строго каноничный `{ output, isError, details }` по контракту `ToolExecutionResult` Durable 1.2.0. Тесты обновлены на ассерты `.output`. |
| **F-92-3** | Тихо подавляемые ошибки и `console.debug?.` в раннере и хосте | **P2** | AP-013, AP-028 | `fix-now` | В `subagent-watcher.ts` и `runner-process.ts` тихие/опциональные `console.debug?.` заменены на явные `console.warn` с контекстом компонентов. |
| **F-92-4** | Избыточные проверки массивов в `resolveSkills` | **P2** | AP-029 | `fix-now` | В `src/runner/prompt.ts` и `src/runner/diagnostics.ts` устранена избыточная проверка `Array.isArray(res) ? res : res?.skills ?? []`. Сигнатура `ResourceLoaderLike.getSkills` синхронизирована с `pi-coding-agent@1.2.0` (`() => { skills: Skill[] }`). |
| **F-92-5** | Избыточный каст `(exposure as string)` и условный спред `callers` в `tool-adapter.ts` | **P3** | AP-029 | `fix-now` | Убран повторный каст типа и избыточный тернарный спред для гарантированно определенного свойства `callers`. |

### 2. Architecture Implementations
- **`src/runner/session-storage.ts` (186 строк, AP-019 < 200, AP-010 Decoupled):**
  - Удалена логика инспекции `directory + ".jsonl"`, директории разрешаются напрямую.
  - Обрезка суффикса оставлена строго для прямых путей к файлам `.sqlite`.
- **`src/host/thread-fork.ts` (81 строка, AP-019 < 250):**
  - Удалены ветки форка из `.jsonl`-папок. Поиск базы ведется по каноничному пути `session.sqlite`.
- **`src/runner/tool-adapter.ts` (165 строк, AP-019 < 200, AP-010 Thin Adapter):**
  - Устранена дублирующая проперти `content:` при возврате результатов выполнения инструментов.
  - Очищены типы и спреды `callers`.
- **`src/runner/prompt.ts` (192 строки, AP-019 < 200) & `src/runner/diagnostics.ts` (174 строки, AP-019 < 200):**
  - Прямое получение `skills` через `resourceLoader?.getSkills?.()?.skills ?? []` без устаревших полиморфных проверок.
- **`src/runner/extension-mount.ts` (195 строк, AP-019 < 200):**
  - Извлечение результатов выполнения инструментов напрямую из `res?.output`.
- **`src/runner/subagent-watcher.ts` & `src/host/runner-process.ts`:**
  - Логирование предупреждений при остановке стрима и пропуске прерывания через явный `console.warn`.
- **`tests/`:**
  - Обновлены тесты `cwd-isolation.test.ts`, `thread-fork.test.ts`, `mcp-tool-hooks.test.ts`, `extension-bridge.test.ts`, `cycle-74-remediation.test.ts`, `master-parity-conformance.test.ts`, `codemode-fixture.ts`, `codemode-nested-env.test.ts`, `prompt-adapter.test.ts`.

### 3. Verification Evidence
- `npx tsc --noEmit`: **0 errors (exit code 0)**.
- `npm test`: **208 / 208 passing assertions across 12 test suites (0 failures, 0 skips)**.
- `npm run build`: Сборка успешна (`dist/runner/index.js`, `dist/server.js`, `dist/host.js`).
- `npm run doctor`: **7 System Tools, 6 Extension Tools, 5 Loaded Extensions, Durable v1.2.0**.
- Строгое соблюдение AP-019: **100% файлов в `src/runner/` строго < 200 строк, 100% файлов в `src/host/` < 250 строк**.
- Синхронизация: артефакты `dist` скопированы в кеш BB (`~/.bb/plugins/cache/git/github.com/VanDalkvist/bb-plugin-provider-pi-durable/6de0b69a1c860cfaf33a0c85fd07347c30564faf/dist/`).
- `bb plugin reload provider-pi-durable`: Перезагрузка успешна, статус `running`.



