# PRD: Native Pi Durable Subagents & Composite Thread Routing in Beyond Boundaries

**Статус:** 📋 APPROVED FOR IMPLEMENTATION  
**Дата создания:** 2026-10-12  
**Цикл арх лупа:** Cycle 86  
**Автор:** Lead Architect & Agent Systems Engineer  
**Репозиторий:** `VanDalkvist/bb-plugin-provider-pi-durable`  
**Целевая ветка:** `feat/in-place-subagents`  

---

## 1. Executive Summary & Vision

### 1.1. Контекст
Исторически делегация задач субагентам опиралась либо на внешний пакет `npm:pi-agents` (`agent_spawn`), либо на экспериментальные обёртки. В PR #9 была предпринята попытка поддержать субагентов Pi Durable, но она привела к катастрофическому усложнению кодовой базы:
- **6400 строк самодельного сокет-сервера** (`native-child-intent-broker.ts`, `native-child-discovery.ts`, `native-child-bb-sync.ts`).
- **Гонки в планировщике Durable:** запуск `submit` до фиксации транзакции `commitWith`.
- **Попытка двухфазного распределённого консенсуса** между Runner, Host и Server BB для блокирующего создания слота треда до запуска задачи.

### 1.2. Цель (Cycle 86)
Реализовать **каноничную нативную делегацию `@earendil-works/pi-durable` Subagent (`tx.createConversation`)**, сохранив транзакционность внутри единого `session.sqlite`, и поддержать сквозную адресацию дочерних бесед через композитный `providerThreadId`:
1. **Каноничный Subagent:** Тул `subagent` запускается непосредственно внутри рантайма Pi Durable, создавая дочернюю беседу в SQLite с привязкой владения `ownership: { kind: "task", taskId: api.taskId }`.
2. **Timeline Delegation (нативный протокол BB):** Выполнение субагента транслируется в BB Provider Bridge через стандартную дельту `DeltaDelegationShape` (`type: "delegation"`, `childRef: conversationId`, `label: taskTitle`).
3. **Shared Owner по композитному ID (`${sessionKey}:${conversationId}`):** Провайдер-бридж прозрачно адресует дочерние беседы к уже запущенному `PiThreadSession`, исключая повторный спавн процессов раннера и файловые блокировки SQLite.
4. **Zero-Socket Architecture:** Полный отказ от самодельных сокет-серверов, фоновых наблюдателей и удержания воркер-лизов (соответствие AP-010, AP-015, AP-019).

---

## 2. Архитектурный аудит и устранение антипаттернов (Gap Analysis)

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              PR #9 ANTI-PATTERN (REJECTED)                              │
│                                                                                         │
│  Runner (Pi)                                  Host Bridge                     BB Server │
│   │                                                │                              │     │
│   ├── (1) Subagent intent ──[UNIX Socket 6.4k]───► │                              │     │
│   │   [BLOCKED waiting for BB slot]                ├── (2) Signal ──────────────► │     │
│   │                                                │                               ├── (3) threads.spawn
│   │                                                │   ◄── (4) thread/start ───────┤     │
│   │   ◄── (5) Ack with BB threadId ─────────────── │                              │     │
│   ├── (6) submit() [Scheduler race condition!]     │                              │     │
└─────────────────────────────────────────────────────────────────────────────────────────┘

                                           ▼

┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                           CANONICAL CYCLE 86 ARCHITECTURE                               │
│                                                                                         │
│  Runner (Pi Durable 1.1)                       Host Bridge                    BB IDE    │
│   │                                                │                            │       │
│   ├── (1) tx.createConversation() in session.sqlite│                            │       │
│   ├── (2) handle.submit() runs in-process          │                            │       │
│   ├── (3) tool_execution event                     │                            │       │
│   │   └─ details.conversationId ─────────────────► │                            │       │
│   │                                                ├── (4) thread/delta ──────► │       │
│   │                                                │   type: "delegation"       │       │
│   │                                                │   childRef: convId         │       │
│   │                                                │   [Timeline Card Renders]  │       │
│   │                                                │                            │       │
│   │   ◄── (5) turn/start targeting convId ──────── │ ◄── (4b) User prompt ──────┤       │
│   │       via composite id ${sessKey}:${convId}    │     on child thread        │       │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

### Gap 1: Отсутствие нативного расширения `Subagent` в реестре кодинга
- **Проблема:** В `src/runner/harness-setup.ts` в `createCodingRegistry` устанавливается только `CodingTools` и `createPiPrompt`. Тул `subagent` отсутствует в реестре.
- **Решение:** Подключить каноничный `Subagent` из `@earendil-works/pi-durable` непосредственно в реестр через `registry.install(Subagent)`.

### Gap 2: Однобеседный хардкод в Provider Bridge (`src/host/`)
- **Проблема:** `SessionRegistry` и `bridge-router.ts` считают `providerThreadId` монолитным идентификатором сессии и всегда адресуют вызовы в `ROOT_CONVERSATION_ID`. Если BB передаёт composite ID, бридж пытается открыть новую базу данных и падает из-за SQLite lock.
- **Решение:** Внедрить `src/host/composite-id.ts` (< 50 строк). При получении `${sessionKey}:${conversationId}`:
  - `SessionRegistry` находит существующий `PiThreadSession` для `${sessionKey}`.
  - `bridge-router.ts` передаёт `conversationId` в запрос хода.
  - `DurableRunner` выполняет `harness.conversation(conversationId).submit(...)`.

### Gap 3: Корректное отображение в UI Beyond Boundaries
- **Проблема:** В черновом плане предполагалось использование несуществующего метода `thread/child_spawn`.
- **Решение:** Использовать официальный контракт BB Provider Bridge:
  - На уровне таймлайна: `DeltaDelegationShape` (`type: "delegation"`) рендерит интерактивную карточку сабагента с меткой задачи.
  - На уровне тредов: композитный ID `${sessionKey}:${conversationId}` гарантирует интерактивность при любом обращении BB к дочерней беседе.

---

## 3. Функциональные требования (FR)

- **FR-1:** При вызове LLM инструмента `subagent({ task: "..." })` рантайм обязан создать дочернюю беседу в SQLite с ownership `kind: "task"` и выполнить её изолированно без повторной рекурсии субагентов (`extensions: { remove: [Subagent] }`).
- **FR-2:** События дочерней беседы должны транслироваться через существующий `SubagentWatcher` и `BBChildEventAdapter` в ленту родительского треда без повреждения последовательности `seq`.
- **FR-3:** Провайдер-бридж обязан корректно парсить композитные идентификаторы `providerThreadId` формата `${sessionKey}:${conversationId}`.
- **FR-4:** При поступлении запросов `thread/start`, `thread/resume`, `turn/start`, `turn/steer`, `thread/stop` с композитным ID бридж обязан перенаправлять вызовы к уже активному экземпляру `RunnerProcess` сессии `${sessionKey}`, не создавая новых процессов и не открывая второй дескриптор SQLite.
- **FR-5:** При вызове `thread/stop` для композитного треда рантайм обязан вызывать `conversation.abort()` для конкретной дочерней беседы, не прерывая выполнение корневой сессии.

---

## 4. Нефункциональные требования и архитектурные инварианты (NFR)

- **AP-010 (Thin Adapter):** Никаких внешних сокет-демонов или HTTP-серверов. Вся связь между Runner и Host происходит строго по stdio JSON-RPC.
- **AP-013 (Contract Completeness):** Полная реализация протокола Provider Bridge для композитных ID без частичных стабов.
- **AP-015 (YAGNI & Dead Code):** 0 строк избыточной синхронизации, 0 неиспользуемых полей, 0 сокет-брокеров.
- **AP-019 (File Size Compliance):**
  - Все новые и модифицированные файлы в `src/runner/` строго **< 200 строк**.
  - Все файлы в `src/host/` строго **< 250 строк**.
- **AP-026 (No Silent Fallbacks):** Явные ошибки при невалидном формате сессии или отсутствии целевой дочерней беседы.
- **AP-028 (TDD Test Parity):** Разработка строго через Red-Green-Refactor. 100% прохождение тестов в наборе `node:test`.
- **AP-029 (TypeScript Strictness):** 0 `as unknown as`, 0 `as never`, 0 нетипизированных `any`.

---

## 5. План приёмки и верификации

1. **Unit-тесты (`tests/durable-subagent.test.ts`):**
   - Установка `Subagent` в реестр.
   - Проверка создания дочерней беседы в памяти/SQLite.
   - Возврат ответа сабагента в результат вызова тула.
2. **Интеграционные тесты (`tests/composite-thread-routing.test.ts`):**
   - Парсинг и форматирование композитных ID.
   - Разрешение сессии через `SessionRegistry`: root thread vs child thread используют один и тот же процесс.
   - Отправка `turn/start` в дочернюю беседу и получение результата.
   - Проверка `thread/stop` для дочерней беседы.
3. **Регрессионные тесты (`tests/subagent-in-place-streaming.test.ts`):**
   - Потоковая передача рассуждений и тулов сабагента в таймлайн через `SubagentWatcher`.
4. **Сквозная проверка:**
   - `npx tsc --noEmit` — 0 ошибок.
   - `npm test` — 100% тестов проходят.
   - `npm run build && npm run doctor` — сборка и диагностика валидны.

---

## 6. Архитектурное решение: Отказ от декларативного DSL графов (`tasks` / `chain`)

**Решение (2026-10-12, Post-Cycle 90 ADR):**
Было исследовано предложение добавить в инструмент `subagent` декларативные массивы `tasks: string[]` (автоматический fan-out) и `chain: string[]` (автоматический конвейер с интерполяцией `{previous}`).

**Вердикт: ОТКЛОНЕНО (YAGNI & Unix-philosophy). Не городить избыточный синтаксический сахар.**

### Обоснование:
1. **Атомарность примитива:** Инструмент `subagent` должен оставаться минималистичным, надёжным атомарным примитивом (`{ task: string, background?: boolean }`). 
2. **Оркестрация на стороне LLM/пользователя:**
   - **Параллелизм (Fan-out):** Современные LLM нативно умеют вызывать несколько инструментов параллельно в одном ходе (`tool_calls: [subagent(...), subagent(...)]`). Рантайм и TaskScheduler уже поддерживают одновременное фоновое исполнение в независимых SQLite-беседах.
   - **Конвейеры (Chains):** Легко строятся последовательными вызовами от шага к шагу или через вложенность (субагент вызывает субагента с передачей пэйлоада), что сохраняет полный контроль и возможность ветвления логики агентом без жесткого DSL.
3. **Сохранение лимитов сложности (AP-015, AP-019):** Добавление самодельного DSL графов с интерполяцией строк (`{previous}`) раздуло бы код раннера, усложнило обработку частичных отказов и создало хрупкий proprietary формат поверх стандартного протокола.

