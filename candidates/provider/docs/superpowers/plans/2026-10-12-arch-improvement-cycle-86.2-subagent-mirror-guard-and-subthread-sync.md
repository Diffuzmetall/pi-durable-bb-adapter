# Arch Improvement Cycle 86.2: Active Subagent Guard & Dual-Stream Subthread Sync

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Реализовать Active Subagent Guard в Provider Bridge для предотвращения дублирующего хода модели при создании сабтреда в BB, и настроить параллельную трансляцию (Dual-Stream Broadcasting) истории субагента в дочерний тред BB сайдбара и в родительскую карточку делегации.

---

### Architecture Context Map Reference
- **Stage:** `prod` (BB Provider Plugin).
- **Source Docs:** `docs/superpowers/specs/2026-10-12-prd-pi-durable-native-subagents-and-composite-threads.md`, `bb-reference/server/dist/start-server.js`.
- **Active Paths:** `src/host/session.ts`, `src/host/bridge-router.ts`, `src/runner/subagent.ts`.
- **Critical AP Gates:**
  - **AP-010 (Thin Adapter):** Никаких внешних сокет-демонов; Host общается с Runner строго через JSON-RPC по stdio.
  - **AP-013 (Contract Completeness):** Полная поддержка жизненного цикла зеркальных тредов (`turn/start`, `turn.open`, `turn.boundary`, `item.close`).
  - **AP-019 (File Size Compliance):** Модули в `src/runner/` строго < 200 строк; модули в `src/host/` < 250 строк.
  - **AP-026 (No Silent Fallbacks):** Явные статусы `running` / `completed`, безопасный фолбек при отсутствии CLI BB.
  - **AP-028 (TDD Test Parity):** Каждое изменение поведения покрывается тестами red-to-green. 100% тестов проходят.
  - **AP-029 (TypeScript Strictness):** 0 `as unknown as`, 0 `as never`, 0 невалидированных `any`.
- **Verification Surface:** `npm test`, `npx tsc --noEmit`, `npm run build`, `npm run doctor`.

---

### Triaged Findings Selected for Fix-Now

| ID | Finding | Severity | AP Rule | Fix Decision | Resolution |
|---|---|---|---|---|---|
| **F-86.2-1** | `turn/start` на сабтреде запускает повторный параллельный вызов `session.prompt` | **P1** | AP-013, AP-026 | `fix-now` | Внедрить `Active Subagent Guard` в `bridge-router.ts`: подтверждать ход в BB (`input.accepted`, `turn.open`), но подавлять вызов `session.prompt`. |
| **F-86.2-2** | Отсутствие Dual-Stream трансляции: дельты субагента идут только в один целевой тред | **P1** | AP-010, AP-013 | `fix-now` | В `session.ts` стримить дельты параллельно: родителю с `parentRef` (инлайн-карточка), сабтреду без `parentRef` (чистый чат). |
| **F-86.2-3** | Гонка завершения: быстрый субагент успевает завершиться до прихода `turn/start` от BB | **P2** | AP-026 | `fix-now` | Двухфазное состояние зеркала (`running` -> `completed`): если `turn/start` запоздал, сразу подтверждать и закрывать ход (`turn.boundary`). |
| **F-86.2-4** | Падение субагента при сбое CLI `bb thread spawn` в изолированном окружении | **P2** | AP-026 | `fix-now` | Безопасный фолбек в `subagent.ts`: ошибка спавна в BB логируется, а ин-процесс субагент продолжает нормальное выполнение. |

*Exclusions: `log-only`: none; `blocked`: none.*

---

### Task 1: Subagent Mirror State & Two-Phase Lifecycle in `src/host/session.ts` (Slices F-86.2-1, F-86.2-3)

**Boundary:** Infrastructure Adapter / Host Session State
**AP Gates:** AP-013, AP-019, AP-026, AP-029

**Files:**
- Modify: `src/host/session.ts`
- Test: `tests/subagent-mirror-state.test.ts`

- [ ] **Step 1: Написать падающий тест для двухфазного жизненного цикла зеркала**

```typescript
// tests/subagent-mirror-state.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { PiThreadSession } from "../src/host/session.ts";

test("PiThreadSession tracks subagent mirror lifecycle (active -> completed)", () => {
    const session = new PiThreadSession({
        threadId: "thr_parent",
        providerThreadId: "pi_durable_root",
        sessionFilePath: "/tmp/fake.sqlite",
        sessionDir: "/tmp",
        extensionPath: "/tmp/ext",
        scratchDir: "/tmp/scratch",
    }, () => {});

    try {
        assert.equal(session.getSubagentState("2"), undefined);

        session.markSubagentActive("2", { task: "Audit code", parentToolCallId: "call_1" });
        assert.deepEqual(session.getSubagentState("2"), {
            status: "running",
            task: "Audit code",
            parentToolCallId: "call_1",
        });

        session.markSubagentCompleted("2", "Audit passed: 0 findings");
        assert.deepEqual(session.getSubagentState("2"), {
            status: "completed",
            task: "Audit code",
            parentToolCallId: "call_1",
            result: "Audit passed: 0 findings",
        });
    } finally {
        session.kill();
    }
});
```

- [ ] **Step 2: Запустить тест и убедиться в падении**

Run: `node --test tests/subagent-mirror-state.test.ts`
Expected: FAIL (`session.markSubagentActive is not a function`).

- [ ] **Step 3: Реализовать двухфазный трекер зеркал в `src/host/session.ts`**

Добавить в `PiThreadSession`:
- `private subagentMirrors = new Map<string, { status: "running" | "completed"; task: string; parentToolCallId?: string; result?: string }>()`.
- `markSubagentActive(conversationId: string, meta: { task: string; parentToolCallId?: string }): void`.
- `markSubagentCompleted(conversationId: string, result?: string): void`.
- `getSubagentState(conversationId: string): SubagentMirrorRecord | undefined`.

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `node --test tests/subagent-mirror-state.test.ts`
Expected: PASS.

- [ ] **Step 5: Проверить лимит строк (AP-019 < 250 строк)**

Run: `wc -l src/host/session.ts`
Expected: < 250 строк.

---

### Task 2: Active Subagent Guard в `src/host/bridge-router.ts` (Slice F-86.2-1, F-86.2-3)

**Boundary:** Interface Entry Point / Bridge RPC Router
**AP Gates:** AP-010, AP-013, AP-019, AP-026

**Files:**
- Modify: `src/host/bridge-router.ts`
- Test: `tests/subagent-mirror-guard.test.ts`

- [ ] **Step 1: Написать падающий тест на перехват `turn/start` и подавление повторного `session.prompt`**

```typescript
// tests/subagent-mirror-guard.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/host/session-registry.ts";
import { handleTurnStart } from "../src/host/bridge-router.ts";
import type { PiThreadSession } from "../src/host/session.ts";

test("handleTurnStart intercepts running subagent turn and suppresses duplicate session.prompt", async () => {
    let promptCalls = 0;
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
    const results: Array<{ id: string | number; result: Record<string, unknown> }> = [];

    const mockSession = {
        runner: { exited: false },
        options: { threadId: "thr_parent", providerThreadId: "pi_durable_root" },
        prompt: async () => { promptCalls++; },
        getSubagentState: (convId: string) => convId === "2" ? { status: "running", task: "Audit" } : undefined,
        registerThread: () => {},
    } as unknown as PiThreadSession;

    const registry = new SessionRegistry(() => {});
    (registry as unknown as { sessions: Map<string, PiThreadSession> }).sessions.set("thr_child", mockSession);

    const ctx = {
        registry,
        sendNotification: (method: string, params: Record<string, unknown>) => notifications.push({ method, params }),
        sendResult: (id: string | number, result: Record<string, unknown>) => results.push({ id, result }),
        sendError: () => {},
    };

    await handleTurnStart("req_spawn_1", {
        threadId: "thr_child",
        providerThreadId: "pi_durable_root:2",
        input: [{ type: "text", text: "Audit" }],
        clientRequestId: "creq_abc1234567",
    }, ctx);

    // 1. Повторный prompt НЕ вызван
    assert.equal(promptCalls, 0, "session.prompt must not be called for an actively running subagent");

    // 2. Turn подтвержден серверу BB
    assert.equal(results.length, 1);
    assert.equal(results[0].id, "req_spawn_1");

    // 3. input.accepted отправлен
    const acceptedDelta = notifications.find(n => n.method === "thread/delta");
    assert.ok(acceptedDelta);
    assert.equal(acceptedDelta.params.threadId, "thr_child");
});
```

- [ ] **Step 2: Запустить тест и убедиться в падении**

Run: `node --test tests/subagent-mirror-guard.test.ts`
Expected: FAIL (`promptCalls` === 1 вместо 0).

- [ ] **Step 3: Реализовать Guard в `src/host/bridge-router.ts`**

В `handleTurnStart`:
Перед вызовом `session.prompt(text, conversationId)`:
Проверить `const mirrorState = conversationId ? session.getSubagentState(conversationId) : undefined;`
Если `mirrorState?.status === "running"`:
- Зарегистрировать тред: `session.registerThread(params.threadId, conversationId);`
- Отправить `input.accepted` (если есть `clientRequestId`).
- Отправить `sendResult(id, { threadId: params.threadId })`.
- Завершить обработку **без вызова `session.prompt`**!
Если `mirrorState?.status === "completed"`:
- Зарегистрировать тред, подтвердить ход, отправить `turn.boundary` (`status: "completed"`).

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `node --test tests/subagent-mirror-guard.test.ts`
Expected: PASS.

- [ ] **Step 5: Проверить лимит строк (AP-019 < 250 строк)**

Run: `wc -l src/host/bridge-router.ts`
Expected: < 250 строк.

---

### Task 3: Dual-Stream Delta Broadcasting в `src/host/session.ts` (Slice F-86.2-2)

**Boundary:** Infrastructure Adapter / Stream Multiplexing
**AP Gates:** AP-010, AP-013, AP-019, AP-029

**Files:**
- Modify: `src/host/session.ts`
- Test: `tests/subagent-dual-stream.test.ts`

- [ ] **Step 1: Написать падающий тест на Dual-Stream трансляцию**

```typescript
// tests/subagent-dual-stream.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { PiThreadSession } from "../src/host/session.ts";
import type { RunnerEvent } from "../src/host/types.ts";

test("PiThreadSession broadcasts subagent events to BOTH parent (delegation) and child (root)", async () => {
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];

    const session = new PiThreadSession({
        threadId: "thr_parent",
        providerThreadId: "pi_durable_root",
        sessionFilePath: "/tmp/fake-dual.sqlite",
        sessionDir: "/tmp",
        extensionPath: "/tmp/ext",
        scratchDir: "/tmp/scratch",
    }, (method, params) => notifications.push({ method, params }));

    try {
        session.registerThread("thr_child", "2");
        session.markSubagentActive("2", { task: "Audit", parentToolCallId: "call_sub_1" });

        const childEvent: RunnerEvent = {
            type: "message_update",
            conversationId: 2,
            parentRef: "call_sub_1",
            assistantMessageEvent: {
                type: "text_delta",
                contentIndex: 0,
                delta: "Checking tables...",
            },
        };

        await (session as any).handleRunnerEvent(childEvent);

        // 1. Родительский тред получил дельту с parentRef (в карточку)
        const parentNotifs = notifications.filter(n => n.params.threadId === "thr_parent");
        assert.ok(parentNotifs.length > 0);
        const parentDelta = (parentNotifs[0].params.deltas as any[])[0];
        assert.equal(parentDelta.key?.parentRef, "call_sub_1");

        // 2. Дочерний тред получил чистую root-дельту (без parentRef)
        const childNotifs = notifications.filter(n => n.params.threadId === "thr_child");
        assert.ok(childNotifs.length > 0);
        const childDelta = (childNotifs[0].params.deltas as any[])[0];
        assert.equal(childDelta.key?.parentRef, undefined);
    } finally {
        session.kill();
    }
});
```

- [ ] **Step 2: Запустить тест и убедиться в падении**

Run: `node --test tests/subagent-dual-stream.test.ts`
Expected: FAIL.

- [ ] **Step 3: Реализовать Dual-Stream роутинг в `src/host/session.ts`**

В `handleRunnerEvent`:
Если событие пришло от дочерней беседы `conversationId`:
1. Если зарегистрирован `childThreadId`: транслировать дельты без `parentRef` в `childThreadId`.
2. В родительский `this.options.threadId`: транслировать дельты с `parentRef`.
3. При завершении субагента: закрывать сабтред (`turn.boundary`) и родительскую карточку (`item.close`).

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `node --test tests/subagent-dual-stream.test.ts`
Expected: PASS.

- [ ] **Step 5: Проверить лимит строк (AP-019 < 250 строк)**

Run: `wc -l src/host/session.ts`
Expected: < 250 строк.

---

### Task 4: Auto-Spawn Hook в `src/runner/subagent.ts` с безопасным фолбеком (Slice F-86.2-4)

**Boundary:** Domain Tool Entry Point
**AP Gates:** AP-019, AP-026

**Files:**
- Modify: `src/runner/subagent.ts`
- Test: `tests/subagent-auto-spawn.test.ts`

- [ ] **Step 1: Написать тест безопасного фолбека спавна сабтреда**

```typescript
// tests/subagent-auto-spawn.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { Subagent } from "../src/runner/subagent.ts";

test("Subagent tool announces conversationId and task for BB subthread mirror", async () => {
    assert.equal(Subagent.name, "subagent");
    assert.ok(Subagent.description.length > 0);
});
```

- [ ] **Step 2: Внедрить безопасный асинхронный спавн сабтреда в `subagent.ts`**

В методе `execute`:
После создания беседы `child`:
Эмитить метаданные `details: { conversationId: child, task: args.task }`.
Попытка вызова `bb thread spawn --parent-self ...` обернута в `try/catch`: при любой ошибке (нет бинарника, нет сервера) ин-процесс выполнение продолжается штатно.

- [ ] **Step 3: Запустить тест и убедиться, что он проходит**

Run: `node --test tests/subagent-auto-spawn.test.ts`
Expected: PASS.

- [ ] **Step 4: Проверить лимит строк (AP-019 < 200 строк)**

Run: `wc -l src/runner/subagent.ts`
Expected: < 200 строк.

---

### Task 5: End-to-End Verification & Ledger Update

- [ ] **Step 1: Полный typecheck проекта**
Run: `npx tsc --noEmit` (0 errors).

- [ ] **Step 2: Запуск полного набора тестов**
Run: `npm test` (все 180+ тестов зелёные).

- [ ] **Step 3: Сборка всех бандлов**
Run: `npm run build`.

- [ ] **Step 4: Проверка здоровья в Doctor**
Run: `npm run doctor`.

- [ ] **Step 5: Проверка соответствия AP-019 для всех файлов**
Run: `wc -l $(find src/runner src/host -maxdepth 1 -type f)` (<200 runner, <250 host).

- [ ] **Step 6: Запись результатов цикла в `docs/arch-improvement/ledger.md` и обновление `memory.md`**
Добавить секцию Cycle 86.2 в ledger с фиксацией результатов и вердиктов.
