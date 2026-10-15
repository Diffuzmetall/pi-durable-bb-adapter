# PRD: Pi Durable & Coding Agent v1.2.0 Upgrade, Native Codemode & Decoupling

**Статус:** 📋 APPROVED SPECIFICATION (READY FOR PLANNING)  
**Дата создания:** 2026-10-14  
**Цикл арх лупа:** Cycle 91  
**Автор:** Lead Architect & Agent Systems Engineer  
**Репозиторий:** `VanDalkvist/bb-plugin-provider-pi-durable`  
**Целевая ветка:** `main`  
**Зависимости апстрима:** `@earendil-works/pi-durable@^1.2.0`, `@earendil-works/pi-coding-agent@^1.2.0`, `@earendil-works/pi-codemode@^1.2.0`, `@silvia-odwyer/photon@^0.3.3`

---

## 1. Executive Summary & Vision

### 1.1. Контекст
В апстриме монорепозитория `earendil-works/pi` состоялся синхронный релиз стека **v1.2.0** (`pi-durable`, `pi-coding-agent`, `pi-ai`, `pi-codemode`). 
Исторически наш плагин `bb-plugin-provider-pi-durable` содержал значительный объём вспомогательных адаптеров («монтажной пены»), компенсировавших ограничения ранних версий:
- **Ручной исполнитель вложенных тулов (`createNestedToolExecutor` в `src/runner/extension-mount.ts`):** ~120 строк ad-hoc кода с эмуляцией `api.callId`, ручной буферизацией чанков `output`, эмуляцией `diagnostic: () => {}`, пробросом `env` и ручным вызовом хуков `tool_call`/`tool_result`.
- **Заимствование in-memory расширений из `pi-coding-agent`:** `createCodemodeExtension` и `createToolSearchExtension` импортировались из пакета `pi-coding-agent`, не имели контекста Durable, теряли всё состояние при краше и требовали внешних костылей `env` (Cycle 85).
- **Ручной маппинг `exposure` в `callers`:** Сложные эвристики вместо декларативной схемы.
- **Ошибки сигнатур и контрактов:** В v1.2.0 метод `emitBeforeAgentStart` перешёл на 2 аргумента (`BeforeAgentStartTrigger`), а `ToolExecutionResult.content` переименован в `output`.

### 1.2. Цель (Cycle 91)
Перевести плагин на нативные примитивы **`@earendil-works/pi-durable@1.2.0`**, сохранив строгую архитектурную чистоту (AP-010, AP-013, AP-019 < 200 строк, AP-026, AP-028, AP-029):
1. **Durable Codemode:** Заменить in-memory кодемод на нативный `@earendil-works/pi-durable/codemode` с персистентным QuickJS-рантаймом (`CodemodeSandboxBase`), журналом повторов в SQLite (`pi.codemode.journal`) и детерминированным выживанием при падениях процесса.
2. **First-class Nested Tool Calls & Structured Output:** Делегировать выполнение вложенных тулов в нативный `api.executeTool(name, args, context)`, переведя обработку вывода на `output` + `structuredOutput` (устранение бага [#10815](https://github.com/earendil-works/pi/issues/10815)).
3. **Native Tool Search & Deferred Tools:** Подключить нативный `@earendil-works/pi-durable/tool-search` и декларативный флаг `deferred: true`.
4. **Photon WASM Image Processor:** Внедрить нативную обработку картинок в `read` через `@earendil-works/pi-durable/images/node` с обработкой в Worker-потоке.
5. **Defensive Hardening:** Внедрить защиту от падения Anthropic API (HTTP 400 из-за картинок в ошибочных вызовах — [#10794](https://github.com/earendil-works/pi/issues/10794)) и адаптировать Breaking Changes компилятора (`emitBeforeAgentStart`).

---

## 2. Глубокий анализ: Что выпиливаем и что задействуем

### 2.1. ЧТО ВЫПИЛИВАЕМ (Деконструкция самописного легаси)

1. **Выпиливаем `createCodemodeExtension` и `createToolSearchExtension` из `@earendil-works/pi-coding-agent` (`src/runner/tool-adapter.ts`):**
   * *Что было:* Мы импортировали in-memory реализации из пакета агентского CLI. Они ожидали коллбеки `createToolContext` и глобальный `executeToolFn`, выполнялись в оперативной памяти и теряли весь контекст при перезапуске демона или падении процесса.
   * *Действие:* Удалить импорты `createCodemodeExtension` и `createToolSearchExtension` из `@earendil-works/pi-coding-agent`. Удалить их из `createStandardExtensionFactories()`.

2. **Выпиливаем ad-hoc сборщик вывода и сложный диспетчер в `createNestedToolExecutor` (`src/runner/extension-mount.ts`):**
   * *Что было:* 110 строк ручного кода: генерация id `${callerId}/nested`, ручной вызов хуков `emitToolCall`/`emitToolResult`, конкатенация строк `outputText += chunk`, создание фальшивого `api` без методов Durable. В 1.2.0 это приводило к фатальному `TypeError: api.retainedOutput is not a function`.
   * *Действие:* Сократить `createNestedToolExecutor` до минимального легкого шлюза (не более 30 строк), который для тулов предоставляет валидный мок с `retainedOutput: () => ({ text: outputText, truncated: false })`, а для всех вызовов внутри рантайма Durable опирается на нативный `api.executeTool()`.

3. **Выпиливаем ручной эвристический маппинг `exposure` (`src/runner/tool-adapter.ts`):**
   * *Что было:*
     ```typescript
     const callers = exposure === "model-only" ? ["model"] : exposure === "codemode" || exposure === "deferred" ? ["tools"] : ...
     ```
     Из-за этого инструменты с `exposure: "deferred"` помечались только как вызываемые из инструментов (`callers: ["tools"]`) и были невидимы для модели даже после поиска!
   * *Действие:* Выпилить устаревший свитч. Для `exposure === "deferred"` выставлять `deferred: true, callers: ["model", "tools"]`. Для `exposure === "codemode-deferred"` выставлять `deferred: true, callers: ["tools"]`.

4. **Выпиливаем устаревший контракт возврата `content` (`src/runner/subagent.ts`, `src/runner/tool-adapter.ts`):**
   * *Что было:* Возврат `{ content: [...] }`. В Durable 1.2.0 поле `content` не читается, в результате чего родительская беседа получала пустой ответ от сабагента (баг [#10815](https://github.com/earendil-works/pi/issues/10815)).
   * *Действие:* Заменить свойство `content` на `output` во всех реализациях `ToolRegistration.execute`.

5. **Выпиливаем 3-аргументный вызов `emitBeforeAgentStart` (`src/runner/extension-mount.ts`, `src/runner/runtime-controller.ts`):**
   * *Что было:* `emitBeforeAgentStart(text, undefined, promptOptions)` вызывал ошибку TypeScript `TS2554: Expected 2 arguments, but got 3`.
   * *Действие:* Переписать на 2-аргументную форму с дискриминированным объединением `{ messageType: "user", prompt: text, images: undefined }`.

---

### 2.2. ЧТО ЗАДЕЙСТВУЕМ ИЗ НОВОЙ ВЕРСИИ 1.2.0 (Нативные примитивы)

1. **Задействуем `@earendil-works/pi-durable/codemode`:**
   * *Что дает:* Персистентный запуск QuickJS. Скрипт логирует вызовы в `pi.codemode.journal`. При падении или рестарте раннера скрипт детерминированно реплеится из SQLite, повторно подхватывая уже созданные задачи через `NestedCallDoc`. Поддерживаются глобалы `models.classify()` и `models.generateImages()`, автоматическая генерация Lark-грамматики и персистентное хранилище `store()` / `load()`.
   * *Действие:* Установить `@earendil-works/pi-codemode: "^1.2.0"` в `dependencies`. В `harness-setup.ts` инсталлировать в реестр:
     ```typescript
     registry.install(createCodemodeExtension({ sandbox: new CodemodeSandbox() }));
     ```

2. **Задействуем `@earendil-works/pi-durable/tool-search`:**
   * *Что дает:* Нативный BM25-поиск по отложенным инструментам (`deferred: true`). При нахождении инструментов ядро Durable само динамически добавляет их в `modelTools` текущей сессии через транзакцию SQLite.
   * *Действие:* В `harness-setup.ts` инсталлировать в реестр:
     ```typescript
     registry.install(createToolSearchExtension());
     ```

3. **Задействуем `@earendil-works/pi-durable/images/node` (Photon WASM):**
   * *Что дает:* Полноценное чтение картинок (PNG, JPEG, GIF, WebP) в инструменте `read`. Картинки автоматически поворачиваются по EXIF, приводятся к допустимым габаритам модели (до 2000x2000, 4.5 MB base64). Обработка вынесена в Worker-поток и не блокирует Event Loop основного процесса.
   * *Действие:* В `harness-setup.ts` инициализировать:
     ```typescript
     registry.install(createCodingTools({ images: await createNodePhotonImages() }));
     ```

4. **Задействуем нативный `api.executeTool` и Structured Output в `ToolExecutionApi`:**
   * *Что дает:* Каждое вложенное действие выполняется как изолированный таск `pi.tool` с привязкой `parentTaskId`, отображается в `pi.live.nestedTools` и автоматически абортится при отмене родительской задачи.
   * *Действие:* Использовать `api.executeTool(name, args, context)` напрямую.

5. **Задействуем нативный `parentToolCallId` для вложенных вызовов в `BBEventAdapter`:**
   * *Что дает:* Все события вложенных инструментов из Durable (`tool_execution_start`, `tool_execution_update`, `tool_execution_end`) автоматически содержат `parentToolCallId`.
   * *Действие:* В `src/runner/bridge/bb-event-adapter.ts` передавать `event.parentToolCallId` в качестве `parentRef`. При этом для дочерних бесед сабагентов **сохранить** `BBChildEventAdapter`, так как для отдельных бесед `parentToolCallId` не проставляется ядром Durable.

6. **Задействуем защитный механизм Anthropic Error Sanitization ([#10794](https://github.com/earendil-works/pi/issues/10794)):**
   * *Что дает:* Предотвращение краша диалога с ошибкой `HTTP 400: all content must be type text if is_error is true`.
   * *Действие:* В `src/runner/bridge/tool-result-extractor.ts` и `tool-adapter.ts` гарантировать, что при `isError === true` любые блоки `image` замещаются на текст `[image omitted: error tool results cannot contain images]`.

---

## 3. Архитектурная диаграмма взаимодействий

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              BB IDE (Provider Bridge)                                  │
└──────────────────────────────────────────┬─────────────────────────────────────────────┘
                                           │ JSON-RPC IPC (RunnerRpcChannel)
                                           ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                     RUNNER PROCESS (bb-plugin-provider-pi-durable)                     │
│                                                                                        │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐  │
│  │                            PI DURABLE REGISTRY                                   │  │
│  │                                                                                  │  │
│  │  [CodingTools] ───────────► Photon WASM (/images/node Worker)                    │  │
│  │  [Durable Codemode] ──────► QuickJS Sandbox + SQLite Replay Journal              │  │
│  │  [Durable ToolSearch] ────► BM25 Search over Deferred Tools                      │  │
│  │  [Subagent Extension] ────► tx.createConversation() + Composite Threads          │  │
│  │  [Pi Prompt] ─────────────► Dynamic Rules & Prompt Guidelines                    │  │
│  │  [Extension Bridge] ──────► Custom Tools (MCP, local extensions via adaptTool)   │  │
│  └──────────────────────────────────────────────────────────────────────────────────┘  │
│                                          │                                             │
│                                          ▼                                             │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐  │
│  │                         PI DURABLE HARNESS & ACID ENGINE                         │  │
│  │                                                                                  │  │
│  │  • First-class `api.executeTool()` with Task Ownership (`parentTaskId`)          │  │
│  │  • Native Structured Output (`output` + `structuredOutput`)                     │  │
│  │  • Native `parentToolCallId` in AgentEvent Stream                                │  │
│  │  • In-Memory Document LRU Cache (`documentRetentionMs`)                          │  │
│  │  • Session State & Journal in SQLite (`session.sqlite`)                          │  │
│  └──────────────────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Контрактные требования и правила валидации

### 4.1. Архитектурные правила
- **AP-010 (The Thin Adapter Invariant):** Плагин не реализует собственные FSM планирования задач или парсеры скриптов, а прозрачно делегирует исполнение в Durable Harness и Codemode.
- **AP-013 (Zero Placeholders):** Запрещены неполные заглушки. Мок `api` в `createNestedToolExecutor` обязан честно реализовывать `retainedOutput()` и буферизацию.
- **AP-019 (Modularity and File Line Budgets):** Все файлы в `src/runner/` строго < 200 строк (soft limit 150).
- **AP-026 (Single Source of Truth):** Все зависимости (`@earendil-works/pi-codemode`, `@earendil-works/pi-durable`, `@earendil-works/pi-coding-agent`) согласованы в `package.json` и `scripts/build-runner.mjs`.
- **AP-028 (Deterministic Testing):** Тесты покрывают семантику возврата `output` у субагента, структурированный вывод bash (`exitCode`), защиту от ошибок Anthropic и запуск Durable Codemode.
- **AP-029 (Zero any):** Строгая типизация без `any` и `as unknown as`.
