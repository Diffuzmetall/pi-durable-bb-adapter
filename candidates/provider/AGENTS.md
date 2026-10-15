# AGENTS.md — bb-plugin-provider-pi-durable

Operational guidelines and invariants for `bb-plugin-provider-pi-durable`.

## Hard rules for this repository

⛔ **ALWAYS COMMIT AND PUSH TO MAIN.**
Для этого репозитория (`VanDalkvist/bb-plugin-provider-pi-durable`) ВСЕГДА коммитить и пушить осмысленную работу в ветку `main` без переспроса у Вани. Не оставлять выполненные циклы и изменения висящими локально.

⛔ **The Thin Adapter Invariant (The Four Territories, AP-010 – AP-071).**
Этот репозиторий — тонкий двунаправленный адаптер (GoF Adapter) между Beyond Boundaries IDE и `@earendil-works/pi-durable`.
- Не владеть текстами промптов (извлекать динамически из `@earendil-works/pi-coding-agent`).
- Не изобретать свои UI-компоненты или кастомные FSM-движки.
- Не импортировать утекшие абстракции вне установленных портов.

⛔ **Modularity and File Line Budgets (AP-019).**
Все `.ts` файлы строго < 200 строк (soft limit 150, hard limit 250).

⛔ **Deterministic Testing (AP-028, AP-013).**
Каждый цикл сопровождается честными unit/integration тестами (`npm test`). Запрещены фейковые тесты и замаскированные ошибки.

⛔ **Dogfooding Invariant: ALL SUBTHREADS ON PI-DURABLE.**
Все вспомогательные субтреды (воркеры реализации, автономные архитектурные ревьюеры) в этом репозитории ОБЯЗАНЫ запускаться СТРОГО через `--provider pi-durable`. Запрещено съезжать на базовый провайдер `pi`. Догфудинг собственного рантайма является непреложным правилом разработки.

## Roadmap & Slices
- Roadmap & Divergences: `docs/superpowers/plans/2026-10-07-arch-improvement-master-plan-pi-durable-parity.md`
- PRD & Territories: `docs/superpowers/specs/2026-10-07-prd-pi-durable-territory-ownership-and-decoupling.md`
- Ledger: `docs/arch-improvement/ledger.md`
