# Arch Improvement Plan: Cycle 63 — Brain-Icon Collapsible Thinking & Plugin Settings

**Target:** `bb-plugin-provider-pi-durable`  
**Governing Standards:** `arch-rules.md` (AP-010 – AP-071), `arch-improvement-review`, `arch-rules-implementation-review`  
**Prior Cycle:** Cycle 62 (`v0.2.7`, commit `85feaba`)  
**Target Version:** `v0.2.8`

---

## 1. Goal & Requirements
1. **Collapsible Thinking with Brain Icon (Parity with Native Pi Provider):**
   - Emit `item.open` for reasoning blocks with canonical BB presentation:
     `{ label: { pending: "Thinking", completed: "Thought" }, icon: { glyph: "Brain" } }`
   - Real-time streaming of tokens to `item.textDelta` with `channel: "reasoningText"`.
   - Close on `thinking_end` with `item.textClose`.
   - Collapsible in the timeline: user can collapse or expand thoughts.
2. **Plugin Settings (`bb.settings.define`):**
   - Declarative settings in `server.ts`:
     - `openThinkingByDefault` (boolean, default: true): "Open thoughts by default" (toggle off to collapse thoughts by default).
     - `hideThinking` (boolean, default: false): "Hide thoughts" (completely suppress thoughts from timeline).
   - Wire `deriveProviderOptions(ctx)` to forward settings into `options.providerOptions`.
3. **Strict Architecture & Verification:**
   - AP-019: all `.ts` files strictly < 250 lines.
   - AP-029: strict TypeScript, zero unchecked `as any`.
   - AP-013, AP-028: genuine unit tests in `tests/thinking-presentation.test.ts`.

---

## 2. Implementation Slices

### Slice 1: Plugin Settings in `server.ts` & Provider Options
- In `server.ts`:
  - Define settings schema with `bb.settings.define`:
    - `openThinkingByDefault`: boolean, default `true`, label "Open thoughts by default".
    - `hideThinking`: boolean, default `false`, label "Hide thoughts".
  - Add `deriveProviderOptions(ctx)` to `bb.providers.register`:
    ```typescript
    deriveProviderOptions(ctx: any) {
      return {
        openThinkingByDefault: Boolean(ctx.settings?.openThinkingByDefault ?? true),
        hideThinking: Boolean(ctx.settings?.hideThinking ?? false),
      };
    }
    ```

### Slice 2: Host Context & Plumbing
- In `src/host/types.ts`:
  - Add `providerOptions?: Record<string, unknown>` to `SessionOptions` and `DeltaTranslatorContext`.
- In `src/host/bridge-router.ts`:
  - Pass `options.providerOptions` when constructing or steering session.
- In `src/host/session.ts`:
  - Pass `this.options.providerOptions` into `this.translator.translate(event, ctx)`.

### Slice 3: Brain-Icon Reasoning Presentation in `message-delta-translator.ts`
- In `src/host/message-delta-translator.ts`:
  - Define `REASONING_PRESENTATION`:
    ```typescript
    export const REASONING_PRESENTATION = {
      label: { pending: "Thinking", completed: "Thought" },
      icon: { glyph: "Brain" },
    };
    ```
  - In `MessageTranslationState`, track `openThinkingChannels: Set<string>`.
  - On `thinking_start` or first `thinking_delta` for `thinking-${idx}`:
    If channel not yet open, emit `item.open`:
    ```typescript
    deltas.push({
      kind: "item.open",
      key: { channel: `thinking-${idx}` },
      item: { type: "reasoning", summary: [], content: [] },
      presentation: {
        ...REASONING_PRESENTATION,
        ...(hideThinking ? { suppress: true } : {}),
      },
    });
    ```
  - On `thinking_delta`: emit `item.textDelta` (`channel: "reasoningText"`).
  - On `thinking_end`: emit `item.textClose` (`channel: "reasoningText"`).
- In `src/host/delta-translator.ts`:
  - Forward `ctx.providerOptions` into `translateMessageUpdate`.

### Slice 4: Non-Trivial Test Suite (AP-013, AP-028)
- Create `tests/thinking-presentation.test.ts`:
  - Test 1: `thinking_delta` emits `item.open` with `REASONING_PRESENTATION` (`glyph: "Brain"`) and `item.textDelta`.
  - Test 2: subsequent `thinking_delta` chunks for the same index do not re-emit `item.open`.
  - Test 3: `thinking_end` emits `item.textClose` with `channel: "reasoningText"`.
  - Test 4: `hideThinking: true` injects `suppress: true` into presentation.
  - Test 5: `server.ts` registers settings and `deriveProviderOptions` maps settings correctly.

### Slice 5: Verification & Release
1. Run `npm test` (all 59+ assertions pass).
2. Build bundles: `node scripts/build-runner.mjs && bb plugin build`.
3. Check line counts: all `.ts` files < 250 lines (AP-019).
4. Update `docs/arch-improvement/ledger.md` with Cycle 63.
5. Bump version to `0.2.8` in `package.json`.
6. Commit & tag: `feat(arch): brain icon collapsible thinking and settings (cycle 63, v0.2.8)` and tag `v0.2.8`.
7. Reload plugin: `bb plugin reload provider-pi-durable`.
