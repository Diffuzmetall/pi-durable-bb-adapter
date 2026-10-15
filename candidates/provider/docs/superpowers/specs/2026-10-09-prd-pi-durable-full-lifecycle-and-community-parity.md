# PRD: Полноценный жизненный цикл расширений Pi, слэш-команды и Community Doctor в `bb-plugin-provider-pi-durable`

**Статус:** 📋 APPROVED FOR IMPLEMENTATION  
**Дата создания:** 2026-10-09  
**Автор:** Lead Architect & Agent Systems Engineer  
**Целевой релиз:** `v0.2.23` – `v0.2.25` (Cycles 79–82)  
**Репозиторий:** `VanDalkvist/bb-plugin-provider-pi-durable`  

---

## 1. Executive Summary & Vision

### 1.1. Контекст
В Cycles 56–78 плагин `bb-plugin-provider-pi-durable` реализовал базовый паритет инструментов (Tools), сессий SQLite, Diff-вьюверов, форков и базовой диагностики окружения (`PiDoctor`). 
Однако аудит первоисточников (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-durable`, `host-daemon` BB) выявил фундаментальный архитектурный разрыв:
> **Плагин успешно адаптирует инструменты (Tools) и MCP-серверы, но изолирован от событийной модели Pi Extensions API.**

В результате пользовательские расширения Pi (`gbrain.ts`, `skill-guardian.ts`, `pi-antigravity`, `pi-exa`) запускаются в «усеченном» режиме: их инструменты работают, но хуки жизненного цикла (`agent_end`, `agent_settled`, `agent_before_settle`, `turn_start`) и слэш-команды (`registerCommand`) молча отбрасываются.

### 1.2. Цель
Достичь **100% паритета возможностей Pi Extensions API и безупречного опыта комьюнити (Community DX)**:
1. Замкнуть события FSM Durable Harness в `ExtensionRunner` (двунаправленный мост жизненного цикла).
2. Поддержать перехват и выполнение слэш-команд расширений (`/antigravity.*`, `/exa-*`, `/mcp`).
3. Предоставить комьюнити CLI-команду `bb provider-pi-durable doctor` и экспорт диагностики в 1 клик для прозрачного саппорта.

---

## 2. Архитектурный аудит дефицитов (The 4 Gaps)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           DURABLE HARNESS FSM                                   │
│  Emits AgentEvents: turn_start, turn_end, run_start, run_end, compaction_start  │
└────────────────────────────────────────┬────────────────────────────────────────┘
                                         │
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                       BBEventAdapter (RUNNER BRIDGE)                            │
│  Translates events TO BB HOST:                                                  │
│    - agent_start, turn_start, message_update, tool_execution_*, turn_end        │
│                                                                                 │
│  ❌ GAP 1: НЕ ТРАНСЛИРУЕТ СОБЫТИЯ В ExtensionRunner!                            │
│     extensionRunner.emit({ type: "agent_end" })      ──► DROPPED               │
│     extensionRunner.emit({ type: "agent_settled" })  ──► DROPPED               │
│     extensionRunner.emit({ type: "turn_start" })     ──► DROPPED               │
└────────────────────────────────────────┬────────────────────────────────────────┘
                                         │
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                      ExtensionRunner (PI ECOSYSTEM)                             │
│  - gbrain.ts: hook stop (ambient buffer) & cache refresh ──► NEVER CALLED!      │
│  - skill-guardian.ts: Hard Admissibility Check (HAC)    ──► NEVER CALLED!      │
│  - Registered commands (/antigravity.doctor, /exa-login) ──► GAP 2: DROPPED!    │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Gap 1: Односторонний эмит событий FSM (Event Lifecycle Disconnect)
- **Суть:** `AgentEventStream` из `@earendil-works/pi-durable` генерирует полный спектр событий хода (`run_start`, `run_end`, `turn_start`, `turn_end`, `compaction_start`). Раннер транслирует их только наружу в BB Host через `WireEvent`.
- **Последствия:** `gbrain.ts` не сбрасывает амбиентный буфер на `agent_end` и не обновляет кэш на `agent_settled`. `skill-guardian.ts` не может выполнить `agent_before_settle` проверку.

### Gap 2: Слепота к слэш-командам расширений (Slash Commands Blind Spot)
- **Суть:** В Pi расширения регистрируют команды через `pi.registerCommand(name, def)`. `ExtensionRunner` хранит их в `commands: Map<string, RegisteredCommand>`.
- **Последствия:** Пользователь вводит `/antigravity.usage` или `/exa-status`. Раннер воспринимает это как текст промпта и отправляет в LLM. Модель галлюцинирует, команда расширения не выполняется.

### Gap 3: Изоляция Doctor от CLI и саппорта комьюнити (Community DX Gap)
- **Суть:** Диагностика доступна только через `node scripts/doctor.mjs` (внутри репозитория) или UI вкладку.
- **Последствия:** Пользователь, установивший плагин через маркетплейс BB, не имеет легкой глобальной CLI команды и не может одной кнопкой скопировать отчет об ошибках для issue на GitHub.

---

## 3. Функциональные требования (Functional Requirements)

### FR-1: Двунаправленный мост событий жизненного цикла
1. В `src/runner/bridge/bb-event-adapter.ts` (или выделенный `extension-event-bridge.ts`) добавить трансляцию событий Durable в `ExtensionRunner`:
   - `run_start` -> `extensionRunner.emit({ type: "agent_start" })`
   - `turn_start` -> `extensionRunner.emit({ type: "turn_start" })`
   - `turn_end` -> `extensionRunner.emit({ type: "turn_end" })`
   - `run_end` -> `extensionRunner.emit({ type: "agent_end" })` и последующий `extensionRunner.emit({ type: "agent_settled" })`
   - `compaction_start` -> `extensionRunner.emit({ type: "session_before_compact" })`
2. Все вызовы `extensionRunner.emit` должны быть безопасными (Fail-Open Guarantee per AP-012): ошибка в хуке расширения логируется как notice, но не прерывает сессию Durable.

### FR-2: Поддержка `agent_before_settle` и Hard Admissibility Check
1. Перед фиксацией ответа хода проверять, есть ли у зарегистрированных расширений обработчики `agent_before_settle`.
2. Если обработчик вернул `{ continue: true }` (например, `skill-guardian` поймал отсутствие сохранения факта), раннер инжектирует директиву довыполнения в текущий диалог.

### FR-3: Диспетчер слэш-команд расширений (Slash Command Dispatcher)
1. В `src/runner/session-commands.ts` и `runtime-controller.ts` добавить проверку первого токена пользовательского сообщения на префикс `/`.
2. Если введено `/commandName [args]`:
   - Запрашивать команду у `extensionRunner.getCommand(commandName)`.
   - Если команда найдена — выполнять `command.handler(args, ctx)` без обращения к LLM.
   - Эмиттировать результат выполнения команды в таймлайн BB как системный ответ.
3. Если команда не найдена — продолжать стандартную обработку (передавать в LLM).

### FR-4: Глобальная CLI команда `bb provider-pi-durable doctor`
1. В `server.ts` через `bb.cli.register` объявить команду `doctor`.
2. При вызове в любом терминале выполнять `inspectPiEnvironment` и выводить форматированный терминальный отчет.

### FR-5: 1-Click экспорт отчета для саппорта комьюнити
1. В `app.tsx` добавить кнопку `Copy Report for Support`.
2. Форматировать полный снимок окружения (ОС, Node, плагин, Durable, пути, модели, расширения, неподдерживаемые хуки) в чистый Markdown и копировать в `navigator.clipboard`.

---

## 4. Пользовательский путь (User Journeys)

### Journey 1: Оператор (Ваня) со сложным сетапом gbrain и skill-guardian
1. Ваня открывает тред в BB IDE с провайдером Pi Durable.
2. `before_agent_start` инжектирует контекст памяти gbrain в промпт (0ms).
3. Ваня пишет сообщение: *«Запомни, что мы перенесли релиз на пятницу»*.
4. Агент отвечает: *«Хорошо, я запомнил»*, но забыл вызвать тул `mcp__gbrain__remember`.
5. Срабатывает хук `agent_before_settle` в `skill-guardian.ts`: ловит pseudo-compliance, возвращает требование довыполнить тул.
6. Агент вызывает тул сохранения.
7. На `agent_settled` расширение `gbrain.ts` в фоновом режиме инвалидирует кэш и синхронизирует память.
8. **Результат:** 100% надежность и отсутствие скрытых потерь данных.

### Journey 2: Пользователь из комьюнити (Андрей Кирюшкин / сторонний разработчик)
1. Андрей устанавливает плагин из маркетплейса BB IDE.
2. У Андрея настроены расширения для Pi со своими слэш-командами (`/antigravity.doctor`, кастомные тулы).
3. Андрей вводит `/antigravity.doctor` прямо в чат BB — плагин мгновенно исполняет команду его расширения без отправки в LLM.
4. Если что-то идет не так — Андрей вводит `bb provider-pi-durable doctor` в терминале или открывает вкладку плагина в BB IDE.
5. Нажимает кнопку *«Copy Report for Support»* и присылает готовый Markdown-снимок в чат или issue.
6. **Результат:** Нулевое трение при онбординге и мгновенная локализация любых проблем.

---

## 5. Архитектурные ограничения и инварианты (Invariants)

1. **AP-010 (The Thin Adapter Invariant):** Плагин не пишет свою логику слэш-команд — он лишь делегирует в `ExtensionRunner.getCommand()` и передает ответ в BB.
2. **AP-019 (File Line Budgets):** Все новые модули строго < 200 строк.
3. **AP-028 (Deterministic Testing):** Каждый хук и диспетчер команд покрыт unit-тестами с имитацией вызовов.
4. **AP-029 (Zero `any`):** Строгая типизация всех параметров событий и команд.
