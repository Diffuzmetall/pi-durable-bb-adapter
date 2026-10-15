# Архитектурное исследование экосистемы Pi Durable и интеграции с BB IDE

**Дата:** 9 октября 2026 г.  
**Авторы:** Команда архитектуры BB & Pi Integration  
**Статус:** Утверждено (Approved Architectural Whitepaper)  
**Репозиторий:** `bb-plugin-provider-pi-durable`  

---

## 1. Контекст и цели исследования

В ходе развития провайдера возник фундаментальный спор о границах возможностей `@earendil-works/pi-durable`:
- **Позиция А (Андрей Кирюшкин):** «Всё, что лежит в `~/.pi/agent/`, должно работать из коробки в Pi Durable: скиллы, тулы, MCP, расширения, хуки жизненного цикла и слэш-команды».
- **Позиция Б (Ваня Афанасов):** «Pi Durable — это принципиально другой движок (транзакционный Harness), а не терминальный `AgentSession`. Модели, инструменты, MCP и скиллы работают штатно, но терминальные хуки (`agent_settled`) и слэш-команды CLI там не исполняются по дизайну».

**Цель настоящего исследования:**
1. Изучить первоисточники Earendil (Mario Zechner, Armin Ronacher) — манифест релиза, спецификацию `docs/spec.md`, документацию Chord и монорепозиторий Pi.
2. Провести четкую демаркацию зон ответственности между BB IDE, адаптером плагина, движком `pi-durable` и экосистемой `~/.pi/agent/`.
3. Оценить риски оверинжиниринга (попытки создания эмулятора терминального TUI `AgentSession` внутри плагина).
4. Зафиксировать чистый, прагматичный и долговечный архитектурный контракт.

---

## 2. Первоисточники Earendil: Видение создателей

### 2.1 Манифест релиза (1 октября 2026 г., Earendil Engineering)
В официальном анонсе релиза Pi 1.0 и Pi Durable создатели четко сформулировали назначение двух параллельных веток:

> *«Pi the coding agent is built to run on your (remote) machine, inside a terminal, driven by one person. If the process dies, you look at what happened and tell it to continue. That is what Pi 1.0 focuses on and excels at, and that is not changing.*
>
> *At Earendil, we want to bring this technology to everyone, in whatever form fits their needs best. For that, we need a harness that runs anywhere, can be reached from different surfaces, supports infinitely long conversations, survives catastrophic internal and external failures, and lets multiple humans steer the same agents.*
>
> ***Pi Durable is that harness. It does not replace the Pi coding agent. It is a framework for building any agentic application, coding agents included.***»

### 2.2 Спецификация Pico5 / Pi Durable (`docs/spec.md`)
Ключевой инвариант ядра Pi Durable:
> *«A Session atomically commits immutable entries, full task records, and Chord-tracked documents. Only committed state is observable.»*

В разделе **13. Non-goals** нормативной спецификации авторы прямо исключили:
- **Session-kernel semantic event journal or independently maintained event state** (в ядре нет концепции семантических терминальных событий).
- **Whole-Session DOM** (нет DOM-дерева и TUI-рендеринга).
- **Visible-undurable publication** (никакое состояние не отдается наружу до тех пор, пока оно не зафиксировано в SQLite).
- **Forced termination of non-cooperative extension code inside one process** (изоляция процессов — зона ответственности хоста).

### 2.3 Модель расширений в Pi Durable vs Pi Coding Agent

| Характеристика | `@earendil-works/pi-coding-agent` (CLI/TUI) | `@earendil-works/pi-durable` (Durable Harness) |
|---|---|---|
| **Назначение** | Интерактивный CLI-агент в терминале для одного разработчика | Отказоустойчивый headless движок для любых хостов и бэкендов |
| **Оркестратор** | `AgentSession` | `Harness` + `Session` |
| **Событийная модель** | `pi.on("session_start")`, `pi.on("turn_start")`, `pi.on("agent_settled")` | Транзакционные FSM-хуки задач: `GenerationHooks`, `ToolHooks`, `CompactionHooks` |
| **Слэш-команды** | `pi.registerCommand(name, handler)` (парсинг командной строки терминала) | Отсутствуют. Ввод управляется хостом через `submit({ type: "input" })` |
| **Хранилище** | JSONL транскрипты, директория сессий | ACID SQLite (или JSONL/Memory) с версионированием через Chord |
| **Наблюдение** | Терминальный TUI вывод, ANSI-эскейпы | Реактивное состояние Chord (`viewState`, `watch`) или дельта-поток `watchEvents()` |

---

## 3. Матрица ответственности (Zones of Responsibility)

Чтобы следовать инварианту **The Thin Adapter Invariant (AP-010)** и исключить дублирование логики, система разделена на 4 строгих слоя:

```
┌─────────────────────────────────────────────────────────────────┐
│                           BB IDE (Host)                         │
│  - Графический UI: Composer, чат, таймлайн, карточки диффов     │
│  - Управление командами пользователя (/compact, /fork, /mode)   │
│  - Отображение дерева тредов и переключение моделей/настроек   │
└────────────────────────────────┬────────────────────────────────┘
                                 │ JSON-RPC / stdio streaming
┌────────────────────────────────▼────────────────────────────────┐
│               bb-plugin-provider-pi-durable (Bridge Adapter)    │
│  - Реализация интерфейса BB Provider Protocol                   │
│  - Трансляция событий watchEvents() в threadDeltaSchema         │
│  - Управление жизненным циклом воркера RunnerProcess (PID/Lock) │
│  - Обнаружение моделей, ключей, MCP и скиллов из ~/.pi/agent/   │
│  - Диагностика совместимости (Doctor UI & RPC diagnostics_get)  │
└────────────────────────────────┬────────────────────────────────┘
                                 │ In-Process Harness API
┌────────────────────────────────▼────────────────────────────────┐
│                   @earendil-works/pi-durable (Engine)           │
│  - ACID транзакции в SQLite, версионирование Chord              │
│  - Планировщик FSM-задач (GenerationTask, ToolTask, Compaction) │
│  - Очередь inbox (steer, followUp, write)                       │
│  - Автоматическая и фоновая компактификация                     │
│  - Изоляция окружения инструментов (NodeExecutionEnv)           │
│  - Монотонный учет расходов токенов (pi.usage)                  │
└────────────────────────────────┬────────────────────────────────┘
                                 │ File System
┌────────────────────────────────▼────────────────────────────────┐
│            ~/.pi/agent/ & Resources (Ecosystem Assets)          │
│  - models.json, auth.json, settings.json                        │
│  - Каталог скиллов (SKILL.md)                                   │
│  - Описания MCP-серверов (mcp.json)                             │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. Разбор спорных тезисов: Андрей vs Ваня

### 4.1 В чем был прав Ваня?
1. В `pi-durable` **нет и никогда не было** терминальных хуков `agent_settled`, `agent_before_settle`, `turn_start` и `session_start`.
2. В `pi-durable` **нет встроенного парсера слэш-команд** вида `/review` или `/reset` в тексте сообщений.
3. Попытка внедрить эмуляцию этих механизмов прямо в адаптер превращает адаптер в монолитного франкенштейна, грубо нарушающего принципы разделения ответственности (AP-010).

### 4.2 В чем был прав Андрей?
1. Пользователь ожидает единого окружения: настроенные в `~/.pi/agent/` модели (`models.json`), ключи доступа (`auth.json`), скиллы (`skills/`) и MCP-серверы должны подхватываться автоматически без дублирования конфигураций.
2. Эта поддержка **полностью реализована** в текущей версии плагина (Cycles 60–78):
   - Модели резолвятся через `ModelCatalog`.
   - MCP-серверы транслируются через `ExtensionBridge`.
   - Скиллы парсятся и передаются в системный промпт через секции `PromptAdapter`.
   - Динамические секции формируются нативно через `PromptSection`.

### 4.3 Вердикт Doctor (Cycle 78)
Созданный в Cycle 78 модуль диагностики (`inspectPiEnvironment` и Pi Durable Doctor UI) фиксирует статус-кво объективно:
- **Fully Supported:** Settings, Auth, Custom Models, Direct MCP, Dynamic Prompts, Skill System, Tool Guards (`beforeTool`).
- **Not Applicable by Engine Design:** CLI TUI Hooks (`agent_settled`, `turn_start`) и Terminal Slash Commands.

---

## 5. Риски оверинжиниринга: почему мы отвергли эмуляцию `AgentSession`

Попытка реализовать запланированные ранее циклы 79–82 (эмуляция `AgentSession`, ручной парсинг слэш-команд в строке ввода, искусственная генерация `agent_settled` через интервалы) содержала следующие критические пороки:

1. **Нарушение инварианта тонкого адаптера (AP-010):**
   Адаптер должен быть только транслятором протоколов (Bridge). Добавление тяжелой бизнес-логики управления сессиями приводит к дублированию кода `pi-coding-agent`.
2. **Конфликт с хостом (BB IDE):**
   BB IDE уже обладает собственными механизмами для слэш-команд в графическом интерфейсе и командной строке. Парсить слэш-команды на бэкенде плагина текстовыми регулярками — антипаттерн, приводящий к рассинхронизации UI и состояния сессии.
3. **Разрушение транзакционных гарантий SQLite:**
   В Pi Durable любой переход состояния фиксируется в транзакции через атомарный коммит. Искусственные внешние триггеры вызывают гонки состояний при одновременных `steer` и `followUp` запросах.
4. **Нестабильность к upstream-обновлениям:**
   Любое изменение внутреннего устройства `pi-durable` немедленно ломало бы искусственный эмулятор.

---

## 6. Прагматичный роадмап и дальнейшие шаги

Вместо эмуляции терминального TUI вектор развития направлен на использование нативных сильных сторон Pi Durable:

1. **Использование нативных хуков задач Pi Durable:**
   - Если требуется модификация запросов: использовать родной `GenerationHooks.beforeRequest`.
   - Если требуется продолжение диалога по условию: использовать родной `GenerationHooks.onYield`.
   - Если требуются проверки безопасности перед запуском тулов: использовать `ToolHooks.beforeTool`.
   - Если требуется кастомное сжатие контекста: использовать `CompactionHooks.beforeCompact`.
2. **Нативная компактификация по требованию:**
   - Предоставление чистого RPC-метода `thread/compact`, вызывающего `root.compact()`, доступного для хоста BB.
3. **Совершенствование визуализации в Doctor:**
   - Развитие Doctor UI для мониторинга активных SQLite сессий, размеров баз данных и статистики compaction.
4. **Стабильность и изоляция воркеров:**
   - Сохранение 100% покрытия тестами и детерминированного жизненного цикла процессов (SIGTERM -> SIGKILL).

---

## 7. Заключение

`@earendil-works/pi-durable` — это современный, транзакционный, устойчивый к сбоям движок нового поколения, спроектированный для долгоживущих автономных агентов. Он не предназначен для замены терминального TUI `pi-coding-agent`, а дополняет его в роли универсального движка для платформ и IDE.

Интеграция `bb-plugin-provider-pi-durable` должна оставаться чистым адаптером, доверяющим FSM-архитектуре Pi Durable и передающим все графические и командные функции хосту BB IDE.
