# PRD: Архитектурное выравнивание территорий и устранение чужого владения в `bb-plugin-provider-pi-durable`

**Статус:** ⏳ IN PROGRESS (Cycles 61–72 Completed & Verified, Cycles 73–76 Scheduled)  
**Дата создания:** 2026-10-07  
**Дата актуализации:** 2026-10-08 (полная синхронизация нумерации, D-7, D-20, Issue #7, Delegation Cards, BB Update Lifecycle)  
**Автор:** Lead Architect & Agent Systems Engineer  
**Реализовано в релизах:** `v0.2.7` (Cycles 61–62), `v0.2.8` (Cycle 63), `v0.2.9` (Cycle 64), `v0.2.10` (Cycle 65), `v0.2.11` (Cycle 66), `v0.2.12` (Cycle 67), `v0.2.13` (Cycle 68), `v0.2.14` (Cycle 68.1), `v0.2.15` (Cycle 69), `v0.2.16` (Cycle 70), `v0.2.17` (Cycle 71), `v0.2.18` (Cycle 72)  

---

## 1. Введение и постановка проблемы

### 1.1. Контекст
Плагин `bb-plugin-provider-pi-durable` разрабатывался как мост между Beyond Boundaries (BB IDE) и транзакционным ACID SQLite движком `@earendil-works/pi-durable`. 

### 1.2. Проблема (Диагноз независимого ревью)
В ходе независимого архитектурного аудита (сабтред `thr_vmhmq2bgra`) было выявлено фундаментальное несоответствие архитектурному контракту:
> **Плагин позиционируется как тонкий двусторонний адаптер (GoF Adapter), но внутри владел чужими доменными территориями и содержал завендоренные куски кода, которые должны принадлежать ядру `pi-durable` или экосистеме `pi-coding-agent`.**

Вместо того чтобы быть чистой прослойкой между протоколом BB и Harness ядра Durable, плагин взял на себя:
1. **Генерацию системного промпта и правил агента (`src/runner/prompt.ts`)** — хардкод сниппетов базовых инструментов, XML-структуры правил и ручной обход `AGENTS.md` (Feature Envy по отношению к `pi-coding-agent`).
2. **Низкоуровневую реализацию сабагента (`src/runner/subagent.ts`)** — завендоренную агентскую механику рекурсивных под-сессий через транзакции Durable.
3. **Хеширование директорий сессий и lockfile-менеджмент (`src/runner/sessions.ts`)** — код управления директориями, скопированный из прототипа `experimental/durable`.
4. **Неуместную близость (Inappropriate Intimacy) в сборке расширений (`src/runner/runtime-loader.ts` + `extension-bridge.ts`)** — эмуляция внутренних контрактов `ExtensionRunner` через хаки `(api as any).output` и ручной перебор внутренних очередей провайдеров.

---

## 2. Анализ первоисточников: Что есть в Pi, а чего нет

Мы провели глубокий аудит локальных первоисточников `~/Projects/pi` (`packages/durable` и `packages/coding-agent`):

| Компонент / Функционал | Есть ли в npm пакете `@earendil-works/pi-durable`? | Есть ли в `@earendil-works/pi-coding-agent`? | Где он живет в репозитории Pi? | Вывод для нашего плагина |
|---|---|---|---|---|
| **Ядро Durable (Harness, SQLite, FSM, Storage)** | **ДА** (Harness, ToolTask, GenerationTask, CompactionTask, LiveDoc) | Нет (потребляет durable) | `packages/durable/src/` | **Переиспользуем на 100%** через публичный API пакета. |
| **Базовые инструменты разработчика (read, write, edit, bash)** | **ДА** (`@earendil-works/pi-durable/tools`) | ДА (`create*Tool`) | `packages/durable/src/tools/` | **Переиспользуем на 100%**. |
| **Промптинг, сниппеты тулов, гайдлайны** | **НЕТ** (durable агностичен к промпту, дает только `section`) | **ДА** (`create*ToolDefinition().promptSnippet`, `formatSkillsForPrompt`) | `packages/coding-agent/src/core/system-prompt.ts` | **Устранено в Cycle 61:** сниппеты и файлы контекста берутся из `pi-coding-agent`. |
| **Инструмент `Subagent`** | **НЕТ** (не экспортируется из пакета `pi-durable`) | Нет в публичном API | `packages/coding-agent/src/experimental/durable/subagent.ts` | **Изолировано в Cycle 61:** вынесено в `src/runner/upstream/` с фиксацией provenance. |
| **Управление директориями сессий и Lockfile (`sessions.ts`)** | **НЕТ** (`pi-durable` дает только `openNodeSqliteStorage(file)`) | Нет в публичном API | `packages/coding-agent/src/experimental/durable/sessions.ts` | **Изолировано в Cycle 61:** вынесено в `src/runner/upstream/`. |
| **Инструменты `codemode` и `mcp`** | **НЕТ** | **ДА** (`createCodemodeExtension`, `createMcpExtension`) | `packages/coding-agent/src/extensions/` | **Реализовано в Cycle 60/60.1:** подключаются через `DefaultResourceLoader`. |

### Ключевое открытие аудита: 4 Территории Владения
Причина исторического смешения слоёв:
> **Пакет `@earendil-works/pi-durable` является низкоуровневым вычислительным ядром (Engine), а не законченным агентом.**
> В монорепозитории Pi авторы создали директорию `packages/coding-agent/src/experimental/durable/`, где лежали прототипы клея (`sessions.ts`, `subagent.ts`, `prompt.ts`, `runtime.ts`). 
> Создатель плагина скопировал эту экспериментальную папку целиком в `src/runner/`.

**Каноническая модель 4 Территорий:**
1. **Территория 1 (BB IDE Host & UI):** Протоколы `turn/start`, `turn/steer`, дельты, Diff Viewers, аккордеон Thinking, счетчик Context Window. Принадлежит десктопному приложению BB и хост-демону.
2. **Территория 2 (Pi Durable Core):** Harness, SQLite WAL, FSM задачи (`GenerationTask`, `ToolTask`, `CompactionTask`), транзакционный поток `watchEvents`. Пакет `@earendil-works/pi-durable`.
3. **Территория 3 (Pi Ecosystem / CLI):** SettingsManager, MCP discovery, ToolDefinitions, skills, расширения (`codemode`, `mcp`, `tool-search`). Пакет `@earendil-works/pi-coding-agent`.
4. **Территория 4 (Provider Plugin):** Исключительно тонкий двусторонний адаптер (GoF Adapter). Не владеет чужими сущностями, а только переводит запросы BB в команды Durable и события Durable в дельты BB.

---

## 3. Целевая архитектура (Clean Architecture & Refactoring Guru)

Чётко разграничены папки и обязанности внутри репозитория плагина по принципу **Ports and Adapters**:

```
src/
├── host/                              ◄── ТЕРРИТОРИЯ 1: BB IDE HOST ADAPTER
│   ├── bridge.ts                      (Прием JSON-RPC от BB демона, диспетчеризация)
│   ├── bridge-router.ts               (Роутинг методов JSON-RPC: turn/start, turn/steer, stop)
│   ├── delta-translator.ts            (Трансляция AgentEvent -> BB turn/delta)
│   ├── message-delta-translator.ts    (Трансляция текста, reasoning, usage)
│   ├── tool-delta-translator.ts       (Преобразование diffs/write в виджеты BB)
│   ├── session-telemetry.ts           (Синхронизация контекстного окна и расхода токенов)
│   └── runner-process.ts              (Управление дочерним процессом раннера)
│
├── runner/                            ◄── ТЕРРИТОРИЯ 4: RUNNER PROTOCOL BRIDGE
│   ├── index.ts                       (CLI точка входа --mode rpc)
│   ├── session-commands.ts            (Диспетчер команд prompt, steer, stats)
│   ├── runtime.ts                     (Фасад жизненного цикла Durable)
│   ├── runtime-controller.ts          (Управление FSM и циклом выполнения)
│   ├── runtime-loader.ts              (Трёхфазная инициализация окружения)
│   ├── bridge/
│   │   ├── bb-event-adapter.ts        (Трансляция FSM событий в поток WireEvent)
│   │   └── contracts.ts               (Строгие DTO и интерфейсы wire-протокола)
│   │
│   ├── adapters/                      ◄── АДАПТЕРЫ К ЭКОСИСТЕМЕ PI
│   │   ├── extension-bridge.ts        (Адаптер Pi Extension -> Durable ToolRegistration)
│   │   └── prompt.ts                  (Формирование системного промпта через pi-coding-agent)
│   │
│   └── upstream/                      ◄── КАРАНТИН ПРОТОТИПОВ АПСТРИМА
│       ├── subagent.ts                (Foreground subagent prototype из experimental)
│       └── sessions.ts                (Session directories, SQLite locking prototype)
```

---

## 4. Статус реализации срезов (Refactoring Slices Status)

### Срез 1: Декуплинг системного промпта (`prompt.ts`) [✅ Выполнено в Cycle 61]
- **Результат:** Ликвидированы 120 строк захардкоженного текста правил. Сниппеты инструментов и гайдлайны динамически читаются из фабрик `@earendil-works/pi-coding-agent`. Файлы контекста (`AGENTS.md`) и навыки извлекаются через `resourceLoader.getAgentsFiles()` и `resourceLoader.getSkills()`.

### Срез 2: Изоляция и типизация моста расширений (`extension-bridge.ts`) [✅ Выполнено в Cycles 60–62]
- **Результат:** Класс `PiExtensionBridge` строго типизирован (AP-029). Устранены все касты `(api as any).output`. Реализована поддержка динамической синхронизации инструментов `refreshTools` при асинхронном запуске MCP серверов.

### Срез 3: Выделение `upstream/` [✅ Выполнено в Cycle 61]
- **Результат:** Прототипы `subagent.ts` и `sessions.ts` изолированы в `src/runner/upstream/` с явной фиксацией происхождения из `packages/coding-agent/src/experimental/durable/`.

### Срез 4: Декомпозиция God-модулей хоста и раннера [✅ Выполнено в Cycles 61–62]
- **Результат:** Хост-слой декомпозирован на модули < 150 строк (`bridge-router.ts`, `message-delta-translator.ts`, `runner-rpc-channel.ts`, `session-telemetry.ts`). Все файлы кодовой базы строго укладываются в лимит AP-019 (< 250 строк).

### Срез 5: Паритет отображения рассуждений и устранение холостых настроек [✅ Выполнено в Cycles 63–66]
- **Результат:**
  - Внедрен Brain-аккордеон рассуждений (`glyph: "Brain"`, каналы `reasoningText` и `thinking-${idx}`).
  - В `BBEventAdapter` внедрено гарантированное закрытие стрима мыслей `closeThinkingIfNeeded()` при переходах на текст, тулы или завершение хода.
  - Проведён аудит ядра BB IDE (`start-server.js` и `workspace-checkout-display`), доказавший, что строки `operationKind: "reasoning"` захардкожены на состояние «свернуто по умолчанию». Холостая настройка `openThinkingByDefault` выпилена; сохранена реально работающая настройка `hideThinking` (`suppress: true`).

### Срез 6: Отказоустойчивость тулов, diff-метаданные и диагностики (D-5, D-6, D-9) [✅ Выполнено в Cycle 67, v0.2.12]
- **Результат:** Ликвидировано маскирование сбоев при `event.entry === undefined` (эмитится `isError: true`), проброшены diff/patch в `fileChange`, проброшен `trimStart`.

### Срез 7: Чекпоинты истории, snapshot и форки тредов (D-3, D-10, D-11) [✅ Выполнено в Cycles 68–69, v0.2.13–v0.2.15]
- **Результат:**
  - В `turn.boundary` проброшен `providerCheckpointId` из tail `EntryId` SQLite.
  - Обработан `snapshot` на реконнекте и `auto_retry` события.
  - В Cycle 68.1 (`v0.2.14`) устранена дубликация SDK в `devDependencies`, блокировавшая marketplace-инсталляцию.
  - В Cycle 69 (`v0.2.15`) реализован нативный `thread/fork` RPC через atomic SQLite copy, `PRAGMA wal_checkpoint(TRUNCATE)` и параметризованную обрезку записей.

### Срез 8: Монотонный учет кумулятивного расхода токенов через pi.usage (D-7) [✅ Выполнено в Cycle 70, v0.2.16]
- **Результат:** Суммирование `models` и `tools` из документа `docs["pi.usage"]` и проброс строго монотонного `total` в дельтах `usage`.

### Срез 9: Вытеснение сирот, Teardown воркеров и переносимость BB_DATA_DIR (D-20, Issue #7) [⏳ Cycle 71, v0.2.17]
- **Проблема:**
  1. **Session Lock Contention (D-20, thr_ugw2px7ntq):** При фоновой пересборке плагина или релоаде старый runner-процесс держит lockfile на каталог сессии (`session.sqlite`), новый раннер падает с кодом 1 / 502.
  2. **Отсутствие Teardown хоста:** Воркер `src/host/index.ts` не имел подписчиков на `disconnect`, `SIGTERM`, `SIGINT`.
  3. **Data-Dir Lock-in (Issue #7, Diffuzmetall):** `resolveRunnerPath()` предполагает путь `~/.bb`, из-за чего на инстансах с `--data-dir /path` раннер не обнаруживается.
- **Решение:**
  1. **PID-файл владения (`session.owner.json`):** При захвате сессии записывать `{ pid, startedAt, providerThreadId, cwd }`, удалять при `release()`.
  2. **Orphan Eviction Protocol (AP-034):** Если лок занят, читать `session.owner.json`. Если PID мёртв — сброс лока. Если жив и принадлежит нашему раннеру — посылать `SIGTERM` на graceful exit (`activeDurable.close()`), ожидать до 3 сек и забирать лок.
  3. **Worker Teardown (AP-027):** Обработчики `disconnect`, `SIGTERM`, `SIGINT` в `src/host/index.ts` с вызовом `bridge.shutdown()`.
  4. **BB_DATA_DIR Portability (Issue #7):** Поддержка `process.env.BB_DATA_DIR` с фоллбеком на `~/.bb` для поиска `bb.db` и кэша плагинов.

### Срез 10: Визуальные карточки сабагентов (Cycle 72, v0.2.18) [✅ Выполнено в Cycle 72, v0.2.18]
- **Результат:**
  - В `buildToolItemShape` добавлена поддержка инструмента `subagent` с трансляцией в форму `deltaDelegationShapeSchema` (`{ type: "delegation", childRef, label, background: false, summary }`).
  - В `translateToolStart` добавлена презентация с бот-иконкой (`glyph: "Bot"`).
  - В `translateToolEnd` реализовано извлечение `conversationId` из `event.details.conversationId` для обновления `childRef`, усечение резюме до 300 символов и сохранение презентации карточки. Все дельты валидируются runtime Zod-схемой `threadDeltaSchema`. 105/105 тестов зеленые.

### Срез 11: Прерывание хода и отмена очереди (Cycle 73, v0.2.19) [⏳ В РАБОТЕ, v0.2.19]
- Прерывание по `thread/stop` (`intent: "interrupt"`) через `submission.abort` в `docs["pi.inbox"]`.

### Срез 12: Паритет жизненного цикла расширений Pi и надёжность MCP (D-16..D-19) [Cycle 74, v0.2.20]
- Ожидание `waitForDirectServers`, динамический промпт на `before_agent_start`, хуки `tool_call`/`tool_result`.

### Срез 13: Итоговый аудит паритета и E2E верификация (Cycle 75, v0.2.21) [✅ Выполнено в Cycle 75, v0.2.21]
- Комплексная валидация всех сквозных пользовательских сценариев против нативного провайдера (131/131 тестов).

### Срез 13.1: Синтез Git Diff для write и очистка префиксов путей (D-21) [✅ Выполнено в Cycle 75.1, v0.2.21]
- **Проблема:** При создании файлов через `write` тул в BB IDE развернутая карточка файла отображала `b/<path>` с `+0 -0` diffStats (хотя строка заголовка показывала `Created <filename> +<lines>`).
- **Первоисточники:** Pi's `write` tool не вычисляет diff; в BB IDE frontend `parsePatch` (`dist-CETM3qzT.js`) без `diff --git` заголовка воспринимает патч как переименование (`rename-changed`), из-за чего префикс `b/` утекает в карточку файла, а diffStats сбрасываются в `+0 -0`.
- **Решение (D-21):**
  1. Синтез канонического git diff (`diff --git a/${cleanPath} b/${cleanPath}`) для операций `write` с точным подсчетом добавленных строк (`@@ -0,0 +1,${lineCount} @@`).
  2. Нормализация путей и удаление ложных префиксов `b/`, `a/` и `./` в `normalizeFilePath`.
  3. Стандартизация патчей для инструмента `edit` с чистыми заголовками `diff --git`.
  4. Модульная архитектура: утилиты вынесены в `src/host/diff-utils.ts` (< 250 строк, AP-019). 135/135 тестов зеленые.

### Срез 14: Нативное обновление плагина средствами BB IDE (Cycle 76, v0.2.22)
- **Проблема:** Сейчас в `src/host/discovery-handler.ts` методы `provider/installation/status` и `provider/installation/run` возвращают захардкоженные заглушки (`currentVersion: "1.0.4"`, `needsUpdate: false`, `npmPackageName: "@earendil-works/pi-durable"`). Из-за этого обновление плагина через BB IDE сломано: BB не видит доступных апдейтов и не может выполнить реальный `installAction`.
- **Решение:** Динамическое определение версии из `package.json`, проверка обновлений в реестре, генерация честного `installAction` и выполнение обновления в `provider/installation/run`.

---

## 5. Аудит требований к установке (Requirements Audit)

### Что обязан предоставить пользователь:
1. **BB IDE >= 0.45**
2. **Node.js >= 22.19** (для встроенного в Node движка `node:sqlite`)
3. **Авторизованный CLI `pi`** (хотя бы один вход через `pi` / `/login` для сохранения ключей в `~/.pi/agent/auth.json`)
4. **Конфигурации по желанию:** `~/.pi/agent/settings.json`, `~/.pi/agent/mcp.json`.

### Что предоставляет плагин (всё остальное "из коробки"):
- Встроенный самодостаточный раннер с зависимостями `@earendil-works/pi-durable` и `@earendil-works/pi-coding-agent`.
- **Никаких `npm install -g @earendil-works/pi-durable`!**
- Автоматический поиск сессий и SQLite хранилище в `~/.bb/pi-bridge-sessions/`.

---

## 6. Метрики успеха и верификация

1. **AP-010 / AP-018 Compliance:** PASS — системный промпт не содержит хардкод-правил; 4 территории строго изолированы.
2. **AP-019 Modularity Compliance:** PASS — все 33 файла `.ts` строго < 220 строк (максимум `message-delta-translator.ts` — 214 строк при хард-лимите 250).
3. **AP-026 / AP-029 Strict TypeScript:** PASS — zero `as any` в мостах расширений и DTO; нулевые расхождения схем.
4. **Тесты:** PASS — 63 / 63 теста проходят успешно.
5. **Runtime Parity:** PASS — полное соответствие поведению эталонного `provider-pi` в BB IDE.  

---

## 1. Введение и постановка проблемы

### 1.1. Контекст
Плагин `bb-plugin-provider-pi-durable` разрабатывался как мост между Beyond Boundaries (BB IDE) и транзакционным ACID SQLite движком `@earendil-works/pi-durable`. 

### 1.2. Проблема (Диагноз независимого ревью)
В ходе независимого архитектурного аудита (сабтред `thr_vmhmq2bgra`) было выявлено фундаментальное несоответствие архитектурному контракту:
> **Плагин позиционируется как тонкий двусторонний адаптер (GoF Adapter), но внутри владеет чужими доменными территориями и содержит завендоренные куски кода, которые должны принадлежать ядру `pi-durable` или экосистеме `pi-coding-agent`.**

Вместо того чтобы быть чистой прослойкой между протоколом BB и Harness ядра Durable, плагин взял на себя:
1. **Генерацию системного промпта и правил агента (`src/runner/prompt.ts`)** — хардкод сниппетов базовых инструментов, XML-структуры правил и ручной обход `AGENTS.md` (Feature Envy по отношению к `pi-coding-agent`).
2. **Низкоуровневую реализацию сабагента (`src/runner/subagent.ts`)** — завендоренную агентскую механику рекурсивных под-сессий через транзакции Durable.
3. **Хеширование директорий сессий и lockfile-менеджмент (`src/runner/sessions.ts`)** — код управления директориями, скопированный из прототипа `experimental/durable`.
4. **Неуместную близость (Inappropriate Intimacy) в сборке расширений (`src/runner/runtime-loader.ts` + `extension-bridge.ts`)** — эмуляция внутренних контрактов `ExtensionRunner` через хаки `(api as any).output` и ручной перебор внутренних очередей провайдеров.

---

## 2. Анализ первоисточников: Что есть в Pi, а чего нет

Мы провели глубокий аудит локальных первоисточников `~/Projects/pi` (`packages/durable` и `packages/coding-agent`):

| Компонент / Функционал | Есть ли в npm пакете `@earendil-works/pi-durable`? | Есть ли в `@earendil-works/pi-coding-agent`? | Где он живет в репозитории Pi? | Вывод для нашего плагина |
|---|---|---|---|---|
| **Ядро Durable (Harness, SQLite, FSM, Storage)** | **ДА** (Harness, ToolTask, GenerationTask, CompactionTask, LiveDoc) | Нет (потребляет durable) | `packages/durable/src/` | **Переиспользуем на 100%** через публичный API пакета. |
| **Базовые инструменты разработчика (read, write, edit, bash)** | **ДА** (`@earendil-works/pi-durable/tools`) | ДА (`create*Tool`) | `packages/durable/src/tools/` | **Переиспользуем на 100%**. |
| **Промптинг, сниппеты тулов, гайдлайны** | **НЕТ** (durable агностичен к промпту, дает только `section`) | **ДА** (`create*ToolDefinition().promptSnippet`, `formatSkillsForPrompt`) | `packages/coding-agent/src/core/system-prompt.ts` | **У нас дубликат!** Нужно брать сниппеты и файлы контекста из `pi-coding-agent`, а не хардкодить в `prompt.ts`. |
| **Инструмент `Subagent`** | **НЕТ** (не экспортируется из пакета `pi-durable`) | Нет в публичном API | `packages/coding-agent/src/experimental/durable/subagent.ts` | **Осиротевший прототип.** Авторы Pi написали его в `experimental/durable/`, но не включили в пакет. У нас лежит его точная копия. |
| **Управление директориями сессий и Lockfile (`sessions.ts`)** | **НЕТ** (`pi-durable` дает только `openNodeSqliteStorage(file)`) | Нет в публичном API | `packages/coding-agent/src/experimental/durable/sessions.ts` | **Осиротевший прототип.** `pi-durable` не решает вопрос «где на диске лежат сессии проекта и как их лочить». |
| **Инструменты `codemode` и `mcp`** | **НЕТ** | **ДА** (`createCodemodeExtension`, `createMcpExtension`) | `packages/coding-agent/src/extensions/` | **Публичные фабрики Pi.** Подключаются через `DefaultResourceLoader`. |

### Ключевое открытие аудита
Причина, по которой в нашем плагине оказались `subagent.ts`, `sessions.ts` и `prompt.ts`:
> **Пакет `@earendil-works/pi-durable` является низкоуровневым вычислительным ядром (Engine), а не законченным агентом.**
> В монорепозитории Pi авторы создали директорию `packages/coding-agent/src/experimental/durable/`, где лежали прототипы клея (`sessions.ts`, `subagent.ts`, `prompt.ts`, `runtime.ts`). 
> Создатель плагина скопировал эту экспериментальную папку целиком себе в `src/runner/`.
> В результате в кодовой базе плагина **смешались 3 слоя:**
> 1. Недостающие части апстрима Pi Durable (сессии, сабагент);
> 2. Слой адаптера к экосистеме Pi (промптинг, расширения);
> 3. Собственно адаптер к Beyond Boundaries (RPC команды, трансляция дельт в чат BB).

---

## 3. Целевая архитектура (Clean Architecture & Refactoring Guru)

Мы должны чётко разграничить папки и обязанности внутри репозитория плагина по принципу **Ports and Adapters**:

```
src/
├── host/                              ◄── ТЕРРИТОРИЯ 1: BB IDE HOST ADAPTER
│   ├── bridge.ts                      (Прием JSON-RPC от BB демона)
│   ├── delta-translator.ts            (Трансляция AgentEvent -> BB turn/delta)
│   ├── tool-delta-translator.ts       (Преобразование diffs/write в виджеты BB)
│   └── runner-process.ts              (Управление дочерним процессом раннера)
│
├── runner/                            ◄── ТЕРРИТОРИЯ 4: RUNNER PROTOCOL BRIDGE
│   ├── index.ts                       (CLI точка входа --mode rpc)
│   ├── session-commands.ts            (Диспетчер команд turn/start, turn/steer)
│   ├── bridge/
│   │   └── bb-event-adapter.ts        (Трансляция FSM событий в поток WireEvent)
│   │
│   ├── adapters/                      ◄── АДАПТЕРЫ К ВНЕШНИМ СИСТЕМАМ (Экосистема Pi)
│   │   ├── extension-bridge.ts        (Адаптер Pi Extension -> Durable ToolRegistration)
│   │   └── prompt-adapter.ts          (Адаптер системного промпта через pi-coding-agent)
│   │
│   └── upstream/                      ◄── ЯВНО ВЫДЕЛЕННЫЙ СЛОЙ ШИМОВ АПСТРИМА
│       │                              (Недостающие в pi-durable утилиты, взятые из experimental)
│       ├── subagent-tool.ts           (Foreground subagent tool)
│       └── session-storage.ts         (Session directories, SQLite locking)
```

### Преимущества разделения:
1. **Никакой иллюзии, что это наш код:** слой `upstream/` изолирован и помечен как временные полифилы апстрима Pi Durable до их стабилизации в основном пакете.
2. **Устранение Feature Envy в промптинге:** `prompt-adapter.ts` перестает хардкодить текст правил и сниппетов. Он запрашивает сниппеты у фабрик тулов Pi (`createReadToolDefinition().promptSnippet` и др.) и файлы контекста у `DefaultResourceLoader.getAgentsFiles()`.
3. **Чистые границы DTO:** мост между BB и Durable не содержит размазанной логики сборки промптов.

---

## 4. План изменений по шагам (Refactoring Slices)

### Срез 1: Декуплинг системного промпта (`prompt.ts` -> `prompt-adapter.ts`)
- **Проблема:** Хардкод правил `<rules>`, сниппетов тулов и ручной обход `AGENTS.md`.
- **Решение:**
  - Получать сниппеты и гайдлайны инструментов динамически из фабрик `@earendil-works/pi-coding-agent` (`createReadToolDefinition`, `createWriteToolDefinition`, `createEditToolDefinition`, `createBashToolDefinition`).
  - Получать проектные файлы контекста через `resourceLoader.getAgentsFiles()`.
  - Получать навыки через `resourceLoader.getSkills()`.
  - Устранить 120 строк захардкоженного текста правил.

### Срез 2: Изоляция и типизация `extension-bridge.ts`
- **Проблема:** Неуместная близость с `ExtensionRunner`, касты `(api as any).output`, захардкоженные заглушки.
- **Решение:**
  - Создать формальный типизированный класс `PiExtensionBridge`.
  - Оформить контракт обратного вызова для стриминга вывода тулов без кастов `any`.
  - Обеспечить строгую передачу контекста `createToolContext` и снимка `getCallableTools`.

### Срез 3: Выделение `upstream/` (Карантин чужого кода)
- **Проблема:** `subagent.ts` и `sessions.ts` лежат в корне раннера так, будто это специфика BB плагина.
- **Решение:**
  - Перенести `subagent.ts` и `sessions.ts` в `src/runner/upstream/`.
  - Добавить исчерпывающую документацию происхождения (provenance): ссылка на `packages/coding-agent/src/experimental/durable/` и причины отсутствия в `@earendil-works/pi-durable`.
  - Оформить их как чистые плагины расширения ядра Durable.

### Срез 4: Декомпозиция God-метода `loadHarnessEnvironment`
- **Проблема:** 180 строк сборки всех подсистем в одном файле `runtime-loader.ts`.
- **Решение:**
  - Разделить на 3 детерминированные фазы (AP-020):
    1. `resolveRuntimeSettings(location)` — чтение конфигов и прокси.
    2. `initializeExtensionEnvironment(...)` — запуск расширений, MCP и регистрация моделей.
    3. `mountHarness(...)` — открытие SQLite и монтирование реестра Durable.

### Срез 5 (Новый скоуп): Синхронизация жизненного цикла расширений Pi и надёжность MCP-серверов (Cycle 74)
- **Проблема (выявлена в ходе live-аудита интеграции):**
  1. **Гонка старта MCP (D-16):** Тяжелые MCP-серверы (Bun/Postgres `gbrain`, время старта ~3.5–4.5с) не успевают зарегистрироваться к моменту отправки первого запроса в Durable, так как раннер шлет `ready: true` без ожидания direct-серверов. Быстрые серверы (Node `telegram-mcp`, ~200мс) успевают, создавая иллюзию избирательной работоспособности.
  2. **Статический системный промпт (D-17):** Системный промпт в `src/runner/prompt.ts` формируется статически (`createPiPrompt`). В него не попадают динамические секции расширений Pi (каталог серверов `mcp_servers`, Ambient Recall памяти из `gbrain.ts`), которые в Pi генерируются на хуке `before_agent_start`.
  3. **Отсутствие хуков `tool_call` / `tool_result` (D-18):** В каноническом Pi `codemode` использует хук `tool_call` для ленивого ожидания фоновых серверов (`scriptNeedsServer` / `waitForServers`). Из-за отсутствия проброса `tool_call` в `ExtensionRunner`, скрипты в песочнице не ждут сервер и падают с пустым списком тулов; также отключаются guardrail-расширения (`skill-guardian.ts`).
  4. **Глушение UI и диагностических notice (D-19):** Ошибки и предупреждения MCP-серверов (`MCP servers need attention`, `Sign-in required`) тонут в `noOpUIContext`, так как `runner.setUIContext` не сконфигурирован.
- **Решение:**
  1. В `src/runner/extension-mount.ts` реализовать ожидание `waitForDirectServers` перед готовностью раннера и запуском первого хода (с таймаутом до 5–10с).
  2. В `src/runner/prompt.ts` пробросить хук `extensionRunner.emit({ type: "before_agent_start", ... })` и мерджить динамические секции расширений (`event.systemPromptOptions.sections`) в Durable Registry / Agent.
  3. В `src/runner/extension-mount.ts` (`createNestedToolExecutor`) и `adaptExtensionTool` эмитить `tool_call` перед вызовом тула и `tool_result` после.
  4. Привязать `runner.setUIContext({ notify: ... })` к каналу `sendToBridge({ kind: "notice", ... })` и структурированным логам хоста.

### Срез 6 (Zero-Day Hardening): Управление жизненным циклом сессий, вытеснение сирот и Teardown воркеров (Cycle 70, D-20)
- **Проблема (выявлена в бою при активной разработке плагина):**
  1. **Session Lock Contention (D-20):** При фоновой пересборке плагина (`npm run build`), смене артефакта (`~/.bb/plugin-host-artifacts/provider-pi-durable/`) или краше воркера дочерний runner-процесс (`RunnerProcess`) остаётся висеть в памяти (сирота с PPID 1).
  2. **Непреодолимая блокировка:** Сиротский раннер продолжает удерживать `proper-lockfile` на каталог сессии (`session.sqlite`), обновляя mtime каждые несколько секунд. Новый воркер при `turn/start` падает с `Session is already open in another process: ...` (код 1, 502 Bad Gateway), навсегда блокируя тред пользователя до ручного `kill -9` в терминале.
  3. **Отсутствие Teardown хоста:** `src/host/index.ts` не имел подписчиков на `process.on('disconnect')`, `SIGTERM`, `SIGINT`, бросая запущенные процессы раннеров при перезапуске воркера.
- **Решение:**
  1. **PID-файл владения (`session.owner.json`):** При захвате сессии в `selectSession` записывать метаданные `{ pid, startedAt, providerThreadId, cwd }` рядом с `session.sqlite`, удаляя файл при штатном `release()`.
  2. **Orphan Eviction Protocol (AP-034):** Если `proper-lockfile` сообщает о занятом локе:
     - Считать PID владельца из `session.owner.json`.
     - Проверить статус процесса (`isProcessAlive`). Если процесс мёртв (`ESRCH`) — сбросить застрявший лок.
     - Если процесс жив и принадлежит раннеру того же пользователя — отправить сигнал мягкого завершения `SIGTERM`. Раннер получает `handleExit("SIGTERM")`, корректно вызывает `activeDurable.close()`, сбрасывает SQLite WAL и удаляет лок.
     - Ожидать до 3 секунд освобождения сессии и повторить захват лока.
     - Если вытеснить не удалось — выбросить явную типизированную ошибку с PID и контекстом (AP-012).
  3. **Worker Disconnect & Signal Teardown (AP-027):** В `src/host/index.ts` зарегистрировать обработчики `disconnect`, `SIGTERM`, `SIGINT`, гарантированно вызывающие `await bridge.shutdown()` (которая завершает все сессии через `registry.stopAll()`) перед выходом.
  4. **Graceful Runner Termination:** В `RunnerProcess.kill()` сначала посылать `SIGTERM` для штатного закрытия SQLite и освобождения `proper-lockfile`, и только при отсутствии ответа форсировать `SIGKILL`.

---

## 5. Аудит требований к установке (Requirements Audit)

По тем же принципам Clean Architecture устраняем путаницу в требованиях:

### Что обязан предоставить пользователь:
1. **BB IDE >= 0.45**
2. **Node.js >= 22.19** (для встроенного в Node движка `node:sqlite`)
3. **Авторизованный CLI `pi`** (хотя бы один вход через `pi` / `/login` для сохранения ключей в `~/.pi/agent/auth.json`)
4. **Конфигурации по желанию:** `~/.pi/agent/settings.json`, `~/.pi/agent/mcp.json`.

### Что предоставляет плагин (всё остальное "из коробки"):
- Встроенный самодостаточный раннер с зависимостями `@earendil-works/pi-durable` и `@earendil-works/pi-coding-agent`.
- **Никаких `npm install -g @earendil-works/pi-durable`!** Требование глобальной установки пакета устранено как устаревший артефакт.
- Автоматический поиск сессий и SQLite хранилище в `~/.bb/pi-bridge-sessions/`.

---

## 6. Метрики успеха и верификация

1. **AP-010 / AP-018 Compliance:** Ни один файл плагина не содержит захардкоженных текстов инструкций и сниппетов тулов Pi.
2. **AP-019 Compliance:** Все модули строго < 200 строк (с запасом от лимита 250).
3. **AP-029 Strict TypeScript:** 0 использований `as any` в `src/runner/extension-bridge.ts`.
4. **Тесты:** 100% сохранение зелёного статуса тест-сьюта (47+ тестов).
5. **Live Verification:** Успешный запуск сабтреда в BB IDE с подтверждением работы `read`, `bash`, `codemode` и `mcp__*`.
