# pi-durable-bb-adapter — инструкции для агента

## Назначение и источник требований

Рабочая папка проекта: `/home/ubuntu/Projects/pi-durable-bb-adapter`.
Развиваем интеграцию Beyond Boundaries (BB) с существующим самостоятельным Pi Durable host. Это развитие рабочего адаптера, не переписывание с нуля.

Сначала прочитай [итоговый план](docs/plans/bb-durable-final-plan.md), затем раздел своего среза и его зависимости. План описывает целевой результат, а не уже реализованные возможности. Этот файл — краткая карта ограничений; подробные сценарии и пороги остаются в плане.

Наличие плана не разрешает реализацию, публикацию или активацию. Выполняй только порученный срез. При противоречии между поручением, планом и текущими API обозначь расхождение до спорного действия.

## Границы архитектуры

- Durable владеет Harness, SQLite, выполнением, восстановлением, conversations и task graph. На общую сессию — один владелец storage.
- BB — клиент и представление этого runtime. В shared-пути не создавать запасной локальный Harness, SQLite или отдельный transcript store при ошибке подключения.
- Уже подключённый терминал сохранить: не переподключать, не переделывать интерфейс и не перезапускать рабочий host без отдельного разрешения.
- Pocket и sandbox — только read-only доноры. Их backend, UI, account model, данные и runtime не входят в этот проект.
- Адаптер переводит контракты BB ↔ Durable. Не добавлять собственный scheduler, execution FSM или второй цикл модели.

## Откуда брать код

Пути ниже проверены при подготовке инструкций. Перед использованием перепроверь версии, инструкции каталога и реальное разрешение модулей; наличие пути не означает разрешение редактировать его.

- `/home/ubuntu/.local/share/pi-durable/bb-provider-shared-0.2.29` — исправленная база provider 0.2.29 с shared-host подключением и managed compatibility fixes.
- `/home/ubuntu/.local/share/pi-durable/host` — исходники существующего host. Нужная область: `packages/coding-agent/src/experimental/durable/`; CodeMode adapter: `packages/durable/src/mcp-codemode.ts`.
- `/home/ubuntu/Projects/bb-plugin-provider-pi-durable-v028` — более старый checkout. Не заменять им базу 0.2.29 целиком; там могут быть чужие незакоммиченные изменения.
- `/home/ubuntu/Projects/pi-pocket/src/server/reload.ts` и `extensions/subagents.ts` — источники идей загрузки/reload и Anchor/Reporter/Courier. Переносить нужные части с origin/license, не импортировать PocketApp.
- `/home/ubuntu/Projects/pi-pocket-sandbox/packages` — дополнительные adapters, принимаемые по одному после проверки совместимости.

Переиспользовать BB provider lifecycle, перевод событий/результатов, socket transport и snapshot/replay. Доработать graph, bindings и extension bridge по контрактам плана. Не копировать старые UI/session stubs как будто это работающие API.

Целевая база плана — согласованные Pi/Durable SDK 1.2.0. Pocket исследовался на 1.1.0; его factories принимают PocketHost, а не обычный Pi ExtensionAPI. Не смешивать эти версии и интерфейсы без явного адаптера и тестов.

## Критичные контракты

- **Native child не запускается второй раз.** Представление существующей Durable conversation в BB создаётся без initial prompt и повторного submit. Старый `spawn-with-prompt` в этом пути запрещён.
- **BB1 может быть заблокирован SDK.** Исследованный BB SDK 0.6.15 не предоставил доказанного registration/attach port. Перепроверь текущий API. Если порта нет, покажи `projection unavailable`, останови этот путь и опиши минимальный core/SDK change request. Не выдумывай API и не пиши напрямую в BB DB.
- **Identity не равна правам.** Устойчивая привязка включает backend/session/conversation/BB-thread. Название задачи или process-local Map не заменяют binding. Trusted requester проверяется до history attach и Stop/Steer/Follow-up; переданный клиентом tuple не даёт полномочий.
- **Detach не равен abort.** Отключение BB не отменяет работу host. Reconnect получает authoritative snapshot/history без повторной отправки задания; controls адресуются выбранной conversation.
- **Background определяется ownership.** Одного `background: true` недостаточно. Сначала Anchor и один Reporter, затем Courier, batching и budget holds. Использовать стабильные request IDs и проверять дубли admission/delivery после reopen.
- **Результаты — canonical SDK output.** Не возвращать legacy `content` вместо `output`/`structuredOutput`. Interrupted unsafe side effects не повторять автоматически; exactly-once admission не гарантирует exactly-once внешнее действие.
- **Graph не является backlog.** Waiting/completing не показывать как terminal success. Передавать authoritative empty snapshot, сохранять ownership/background metadata и отличать disconnect/unknown от отсутствия работы.
- **Один владелец tools и guards.** Не дублировать MCP connector, CodeMode или subagent owner. Сохранить MCP/Agent Mail authorization, Hindsight admission и unsafe replay policy, включая nested CodeMode calls.
- **Extensions — исполняемый доверенный код.** Не auto-trust новые factories. Hooks должны реально блокировать/менять вызов; contexts детей не смешиваются. Unsupported API явно отказывает, failed reload сохраняет предыдущий рабочий registry.

## Порядок работы

- Начать с BB0: зафиксировать source roots/revisions, версии, module resolution, managed fixes, build command и fingerprints исполняемых outputs. Исходники кандидата вести здесь; не редактировать установленный `dist` как источник правды.
- После BB0 независимы BB1, BB2, BB4 и BB5 при согласованных интерфейсах и непересекающихся файлах. BB3 зависит от BB1/BB2, BB6 — от BB5 с согласованием conversation context. Точные зависимости остальных срезов смотреть в плане.
- Проверять собственный результат среза и существующие регрессии, не требовать от раннего среза ещё не созданные функции. Полная cross-feature приёмка — BB9. BB7 необязателен, пока его adapters выключены.
- Имена будущих файлов и команд в плане не доказывают, что они уже существуют. Сначала изучить фактическую структуру кандидата и его package scripts. Не запускать выдуманный `npm test` из папки только с документацией.
- Не инициализировать Git, remote, tracker или новую структуру пакетов попутно. Если это нужно для порученного BB0, сначала согласовать отсутствующее решение. Не переносить разрешение на автоматический commit/push из донорского репозитория.

## Координация и сохранность

- Перед записью прочитать файл и проверить чужие изменения. Не сбрасывать, не stash, не перезаписывать и не включать чужую работу в свой commit.
- Для совместных записей брать узкие exclusive Agent Mail leases в проекте `/home/ubuntu/Projects/pi-durable-bb-adapter`; писать под своей bridge identity, объявлять ownership, читать inbox и освобождать leases после handoff. При конфликте не писать.
- Для разрешённых изменений в другом source root использовать его инструкции и отдельные leases. Общие файлы и git index сериализовать; независимые writers могут работать параллельно.
- Делегировать в рамках поручения и общих правил BB. Для этого плана исполнители и проверяющие — видимые BB children на provider `pi-durable`. Не считать обычный CLI-spawned research child доказательством native projection.
- Reviewer проверяет точный candidate и не реализует его исправления. Передавать ему fingerprints, команды и артефакты, а не только отчёт автора. На hold сохранить частичный diff, остановить новые записи и освободить leases.

## Проверки и evidence

- Сначала изолированный local candidate: временные приватные data root/SQLite/socket, synthetic истории и faux models. Не открывать рабочие stores для crash/recovery тестов.
- Сохранить regression checks базы 0.2.29, затем focused tests текущего среза, diagnostics и предусмотренные планом full suite/build. Команды брать из реального candidate package. Сохранять выходы команд, exit codes и fingerprints финальных файлов.
- Для BB UI использовать реальный браузер/native `agent_browser`; для host/CLI — воспроизводимый harness и ready conditions. Provider label, nested card, idle или один `agent_end` не доказывают правильную identity и единственное исполнение.
- Проверять late attach, fast completion, duplicate events, scoped cancellation, sibling isolation и reopen. Crash boundaries: admission до receipt, сохранённый result batch до delivery acknowledgement, BB record до binding persistence.
- Результаты хранить в `evidence/BBx/` либо в thread storage со ссылкой из отчёта. Тесты должны относиться к тому же candidate, что и UI/perf проверки. Исторические PASS не считать свежей приёмкой.
- Сначала измерить baseline на одинаковом workload; затем сравнить candidate. Числа в плане — acceptance thresholds, не измеренные ускорения. Не менять пороги, чтобы скрыть fail.
- Failed/unavailable обязательный gate блокирует приёмку своего среза. Независимую работу можно продолжить. Для BB9 нужны независимые review/QA и проверенная restore parity.

## Активация и границы разрешений

Commit, push, публикация, установка/перезагрузка provider, restart рабочего host, переключение threads и миграции требуют отдельного допуска в рамках действующих правил. Не выводить его из approval плана или создания этого файла.

Секреты, tokens, cookies и рабочие connection strings не сохранять в документацию, fixtures, evidence или сообщения. Live data и backups не удалять. Rollback сначала проверяется на разрешённом тестовом store.

## Исторические материалы

Research evidence и исходный план находятся в `/home/ubuntu/.bb-server/thread-storage/thr_m5gua3gqyg/`. Относительные ссылки `../upgrade-*.xml` в Appendix A копии плана относятся к тому архиву, а не к локальным готовым тестам.

Сначала использовать локальный план. К историческим отчётам обращаться для конкретного вопроса, перепроверяя выводы по текущим API и исходникам. Не переносить старые варианты с Pocket backend или новым терминальным подключением в текущий scope.
