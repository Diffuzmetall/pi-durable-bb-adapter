# Master Architecture Plan: Cycles 79–82 (Full Extension Lifecycle, Slash Commands & Community Doctor)

**Target Repository:** `/Users/vanya/Projects/bb-plugin-provider-pi-durable`  
**Governing Standards:** `arch-rules.md` (AP-010 – AP-071)  
**PRD Reference:** `docs/superpowers/specs/2026-10-09-prd-pi-durable-full-lifecycle-and-community-parity.md`  

---

## Roadmap по циклам арх-лупа

### 🎯 Cycle 79: Lifecycle Event Bridge & Compaction Hooks
**Цель:** Замкнуть события жизненного цикла Durable Harness FSM в `ExtensionRunner.emit()`.
- **Задачи:**
  1. В `src/runner/bridge/bb-event-adapter.ts` добавить интерфейс/коллбэк `ExtensionEventSink` для передачи событий в `extensionRunner`.
  2. Трансляция событий:
     - `run_start` -> `extensionRunner.emit({ type: "agent_start" })`
     - `turn_start` -> `extensionRunner.emit({ type: "turn_start" })`
     - `turn_end` -> `extensionRunner.emit({ type: "turn_end" })`
     - `run_end` -> `extensionRunner.emit({ type: "agent_end" })` + `extensionRunner.emit({ type: "agent_settled" })`
     - `compaction_start` -> `extensionRunner.emit({ type: "session_before_compact" })`
  3. Fail-Open защита: изоляция ошибок хуков расширений от FSM раннера (try/catch с логом в notice).
  4. Unit-тест `tests/extension-lifecycle-events.test.ts`.

### 🎯 Cycle 80: Slash Commands Dispatcher (`registerCommand`)
**Цель:** Поддержать прямое исполнение слэш-команд расширений (`/antigravity.doctor`, `/exa-status`, `/mcp`) в BB чате.
- **Задачи:**
  1. В `src/runner/session-commands.ts` добавить модуль `dispatchExtensionCommand`:
     - Проверка префикса `/`.
     - Извлечение имени команды и аргументов.
     - Проверка `extensionRunner.getCommand(name)`.
     - Исполнение `await command.handler(args, ctx)`.
  2. Интеграция в `runtime-controller.ts` на входе `submit()`. Если команда выполнена — генерация системного сообщения в таймлайн без вызова LLM.
  3. Unit-тест `tests/extension-commands.test.ts`.

### 🎯 Cycle 81: Community Doctor CLI & 1-Click Clipboard Export
**Цель:** Предоставить пользователям комьюнити глобальную CLI-команду и мгновенный экспорт отчета.
- **Задачи:**
  1. В `server.ts` зарегистрировать команду `doctor` через `bb.cli.register`:
     - Запуск `bb provider-pi-durable doctor` в терминале выводит форматированную диагностику.
  2. В `app.tsx` добавить кнопку `Copy Report for Support`:
     - Копирование чистого Markdown-снимка для GitHub Issue / Telegram чата.
  3. Добавить подсказки по исправлению (Actionable Hints) для частых проблем (нет авторизации, не установлены пакеты).
  4. Unit-тест `tests/community-doctor.test.ts`.

### 🎯 Cycle 82: E2E Verification & Community Release
**Цель:** Сквозное тестирование расширений gbrain и skill-guardian в реальной сессии и релиз.
- **Задачи:**
  1. Проверка `gbrain.ts`: логирование вызовов `agent_end` и `agent_settled`.
  2. Проверка `skill-guardian.ts`: срабатывание HAC при симуляции ответа без сохранения.
  3. Проверка выполнения команд расширений.
  4. Полный прогон `npm test`, `npx tsc --noEmit`, `npm run build`.
  5. Бамп версии до `0.2.23`, коммит и пуш в `main`.
