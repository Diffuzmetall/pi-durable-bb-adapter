# Native Durable Subagent & Composite Thread Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заменить устаревший автономный запуск субагентов через `npm:pi-agents` на каноничный нативный `@earendil-works/pi-durable` Subagent (`tx.createConversation`), выполняющийся в единой транзакционной базе `session.sqlite`, и поддержать адресацию дочерних бесед в Provider Bridge через композитный `providerThreadId` (`${sessionKey}:${conversationId}`) без самодельных сокет-серверов.

**PRD Reference:** `docs/superpowers/specs/2026-10-12-prd-pi-durable-native-subagents-and-composite-threads.md`

**Tech Stack:** TypeScript, `@earendil-works/pi-durable@1.1.0`, `@earendil-works/pi-coding-agent@1.1.0`, `@get-bb/plugin-sdk@0.6.15`, Node.js `node:test`, Zod.

---

### Architecture & Arch Rules Gates (Invariants)
- **AP-010 (Thin Adapter):** Никаких внешних сокет-демонов; Host общается с Runner строго через JSON-RPC по stdio.
- **AP-013 (Contract Completeness):** Полная поддержка жизненного цикла композитного `providerThreadId` (`turn/start`, `turn/steer`, `thread/stop`).
- **AP-015 (YAGNI & Dead Code):** 0 лишних сокетов, 0 удержаний воркер-лизов, 0 несуществующих нотификаций вроде `thread/child_spawn`.
- **AP-019 (File Size Compliance):** Модули в `src/runner/` строго < 200 строк; модули в `src/host/` < 250 строк.
- **AP-026 (No Silent Fallbacks):** Явные ошибки при обращении к несуществующей дочерней беседе или некорректном формате ключа сессии.
- **AP-028 (TDD Test Parity):** Каждое изменение поведения покрывается тестами red-to-green. 100% тестов проходят.
- **AP-029 (TypeScript Strictness):** 0 `as unknown as`, 0 `as never`, 0 невалидированных `any`.

---

### File Map
- **Create:** `src/host/composite-id.ts` (< 60 строк): Чистый парсер и форматтер композитных `providerThreadId` (`${sessionKey}:${conversationId}`).
- **Modify:** `src/runner/harness-setup.ts` (< 170 строк): Регистрация каноничного `Subagent` в реестре инструментов кодинга.
- **Modify:** `src/host/session-registry.ts` (< 200 строк): Разрешение композитных ID к общему запущенному `PiThreadSession`.
- **Modify:** `src/host/bridge-router.ts` (< 230 строк): Маршрутизация `turn/start`, `turn/steer` и `thread/stop` для дочерних бесед.
- **Modify:** `src/host/session.ts` (< 200 строк): Поддержка параметра `conversationId` в RPC запросах `prompt`, `steer`, `abort`.
- **Modify:** `src/runner/durable-runner.ts` (< 200 строк): Выполнение хода в целевой беседе `harness.conversation(conversationId)`.
- **Test:** `tests/durable-subagent.test.ts`: Модульный TDD-тест каноничного `Subagent` и создания дочерней беседы в SQLite.
- **Test:** `tests/composite-thread-routing.test.ts`: Интеграционный TDD-тест парсинга композитных ID, SessionRegistry и маршрутизации ходов.
- **Test:** `tests/subagent-delegation.test.ts`: Сквозной тест делегации сабагента и трансляции дельт таймлайна.

---

### Task 1: Canonical Native Durable Subagent Integration

**Files:**
- Modify: `src/runner/harness-setup.ts:70-95`
- Test: `tests/durable-subagent.test.ts`

- [ ] **Step 1: Написать падающий тест для нативного Subagent в реестре**

```typescript
// tests/durable-subagent.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createCodingRegistry } from "../src/runner/harness-setup.ts";

test("createCodingRegistry installs native Subagent tool", () => {
	const settings = SettingsManager.create(process.cwd());
	const registry = createCodingRegistry(settings, process.cwd());
	const snapshot = registry.snapshot();
	const subagentTool = snapshot.tools().find((t) => t.tool.name === "subagent");

	assert.ok(subagentTool, "subagent tool must be registered in CodingRegistry");
	assert.equal(subagentTool?.extension.name, "subagent");
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Запуск: `node --test tests/durable-subagent.test.ts`
Ожидаемый результат: FAIL (`subagent tool must be registered in CodingRegistry`)

- [ ] **Step 3: Установить каноничный `Subagent` в `createCodingRegistry`**

В `src/runner/harness-setup.ts`:
Импортировать `Subagent` из `@earendil-works/pi-durable` (или каноничный модуль из `@earendil-works/pi-coding-agent`) и вызвать `registry.install(Subagent)`. Проверить соблюдение лимита AP-019 (< 200 строк).

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Запуск: `node --test tests/durable-subagent.test.ts`
Ожидаемый результат: PASS

---

### Task 2: Composite `providerThreadId` Parser & Shared Owner SessionRegistry

**Files:**
- Create: `src/host/composite-id.ts`
- Modify: `src/host/session-registry.ts:25-90`
- Test: `tests/composite-thread-routing.test.ts`

- [ ] **Step 1: Написать падающий тест для парсинга и маршрутизации композитных ID**

```typescript
// tests/composite-thread-routing.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { parseProviderThreadId, formatProviderThreadId } from "../src/host/composite-id.ts";

test("parseProviderThreadId correctly distinguishes root session and composite child conversations", () => {
	const root = parseProviderThreadId("pi_durable_1740000000");
	assert.equal(root.sessionKey, "pi_durable_1740000000");
	assert.equal(root.conversationId, undefined);

	const child = parseProviderThreadId("pi_durable_1740000000:conv_sub123");
	assert.equal(child.sessionKey, "pi_durable_1740000000");
	assert.equal(child.conversationId, "conv_sub123");

	assert.equal(formatProviderThreadId("sess1", "conv2"), "sess1:conv2");
	assert.equal(formatProviderThreadId("sess1"), "sess1");
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Запуск: `node --test tests/composite-thread-routing.test.ts`
Ожидаемый результат: FAIL (`Cannot find module '../src/host/composite-id.ts'`)

- [ ] **Step 3: Реализовать `src/host/composite-id.ts` (< 50 строк)**

```typescript
// src/host/composite-id.ts
export interface ParsedProviderThreadId {
	sessionKey: string;
	conversationId?: string;
}

export function parseProviderThreadId(providerThreadId: string): ParsedProviderThreadId {
	const separatorIndex = providerThreadId.lastIndexOf(":");
	if (separatorIndex === -1) {
		return { sessionKey: providerThreadId };
	}
	const sessionKey = providerThreadId.slice(0, separatorIndex);
	const conversationId = providerThreadId.slice(separatorIndex + 1);
	if (!conversationId) {
		return { sessionKey: providerThreadId };
	}
	return { sessionKey, conversationId };
}

export function formatProviderThreadId(sessionKey: string, conversationId?: string): string {
	if (!conversationId) return sessionKey;
	return `${sessionKey}:${conversationId}`;
}
```

- [ ] **Step 4: Обновить `SessionRegistry` для разрешения `sessionKey`**

В `src/host/session-registry.ts`:
При вызове `createOrGet(threadId, providerThreadId, ...)` использовать `parseProviderThreadId(providerThreadId).sessionKey`. Если для `sessionKey` уже запущен `PiThreadSession`, переиспользовать его инстанс и зарегистрировать сопоставление `threadId -> session`, избегая повторного запуска процессов. Проверить соблюдение AP-019 (< 250 строк).

- [ ] **Step 5: Запустить тесты и убедиться, что они проходят**

Запуск: `node --test tests/composite-thread-routing.test.ts`
Ожидаемый результат: PASS

---

### Task 3: Multi-Conversation RPC Dispatch & Turn Execution

**Files:**
- Modify: `src/host/bridge-router.ts:40-110`
- Modify: `src/host/session.ts:55-105`
- Modify: `src/runner/durable-runner.ts:40-95`
- Test: `tests/composite-thread-routing.test.ts`

- [ ] **Step 1: Написать тест на проброс `conversationId` в `PiThreadSession` и `durable-runner`**

Проверить, что вызов `prompt(text, conversationId)` формирует RPC-сообщение `{ type: "prompt", message: text, conversationId }`, а вызов `abort(conversationId)` передаёт `{ type: "abort", conversationId }`.

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Запуск: `node --test tests/composite-thread-routing.test.ts`
Ожидаемый результат: FAIL (`conversationId is not handled`)

- [ ] **Step 3: Реализовать поддержку `conversationId` в Session и Runner**

- В `src/host/bridge-router.ts`: извлекать `parseProviderThreadId(params.providerThreadId).conversationId` и передавать его в `session.prompt(text, conversationId)` и `session.steer(text, conversationId)`.
- В `src/host/session.ts`: добавить опциональный `conversationId?: string` в методы `prompt`, `steer`, `abort`.
- В `src/runner/durable-runner.ts`:
  Если `msg.conversationId` задан:
  `const conv = await this.harness.conversation(msg.conversationId, runtimeContext);`
  Иначе:
  `const conv = await this.harness.root(runtimeContext);`
  Выполнять сабмит именно в целевой беседе.

- [ ] **Step 4: Запустить тесты и убедиться, что они проходят**

Запуск: `node --test tests/composite-thread-routing.test.ts`
Ожидаемый результат: PASS

---

### Task 4: Subagent Delegation Event Stream & In-Place Timeline Verification

**Files:**
- Modify: `src/host/tool-delta-translator.ts:20-60`
- Test: `tests/subagent-delegation.test.ts`

- [ ] **Step 1: Обновить и запустить существующий тест делегации субагента**

Запуск: `node --test tests/subagent-delegation.test.ts`
Проверить валидность генерации дельт `type: "delegation"` с корректным `childRef` равным `conversationId`.

- [ ] **Step 2: Устранить расхождения в маппинге дельт (если есть)**

Убедиться, что `tool-delta-translator.ts` использует `args.conversationId || args.childRef` и корректно форматирует заголовок и статус делегации.

- [ ] **Step 3: Запустить тест и подтвердить прохождение**

Запуск: `node --test tests/subagent-delegation.test.ts`
Ожидаемый результат: PASS

---

### Task 5: Arch Rules Verification (AP-010 through AP-029) & Ledger

**Files:**
- Verify: `wc -l $(find src/runner -maxdepth 1 -type f)` (< 200 строк)
- Verify: `wc -l $(find src/host -maxdepth 1 -type f)` (< 250 строк)
- Verify: `npx tsc --noEmit` (0 ошибок)
- Verify: `npm test` (все тесты проходят)
- Update: `docs/arch-improvement/ledger.md` (Cycle 86 запись)

- [ ] **Step 1: Проверить лимиты строк по AP-019**

Команда: `wc -l $(find src/runner -maxdepth 1 -type f) $(find src/host -maxdepth 1 -type f)`
Ожидание: 100% файлов в `src/runner/` < 200 строк, в `src/host/` < 250 строк.

- [ ] **Step 2: Запустить проверку TypeScript**

Команда: `npx tsc --noEmit`
Ожидание: 0 ошибок.

- [ ] **Step 3: Запустить полный набор тестов**

Команда: `npm test`
Ожидание: 100% тестов проходят (>= 166 тестов).

- [ ] **Step 4: Сборка и запуск доктора**

Команда: `npm run build && npm run doctor`
Ожидание: Сборка успешна, doctor выдаёт здоровый отчёт.

- [ ] **Step 5: Фиксация отчёта Cycle 86 в `docs/arch-improvement/ledger.md`**
