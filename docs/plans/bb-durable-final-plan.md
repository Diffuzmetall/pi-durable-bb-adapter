# BB + Pi Durable upgrade plan

Улучшаем BB поверх уже самостоятельного Durable host. Подключённый терминал сохраняем. Pocket и sandbox служат донорами готового кода, не новым backend и не подключаемыми интерфейсами.
Результат включает настоящие native BB children без второго исполнения, работающий background, правдивый graph, Pi extensions и понятный быстрый BB UI.
Порядок единиц BB0, затем независимые BB1/BB2/BB4/BB5, далее BB3/BB6, BB7/BB8 и финальный BB9.
Это план, не разрешение на выполнение, commit, push, включение plugins, restart, deployment или изменение рабочих данных.

## How to read this

One box is one unit of work. Every box names the evidence. Check a box only when its evidence exists. Непроверенный пункт остаётся открытым. Длительность задачи и число файлов не являются доказательством готовности.

Базовый execution playbook `playbooks/autopilot-stack.md` применяется только после явного допуска выполнения и с Pi adapter. В этой задаче единицы BB0-BB9 обозначают локальные проверяемые изменения, а не уже открытые PR. Основная ветка и правила публикации определяются целевым репозиторием. Здесь не выдаётся разрешение на автоматический stack, rebase или merge.

Облачные VM, `/loop 1h`, автоматический PR/push и массовый fan-out не запускаются этим планом. При отсутствии отдельного разрешения используются локальные изолированные candidates и сохранённые evidence. Не менять runtime/model после ошибки без согласования.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Фактическая готовность — 2026-10-16

Отметки ниже относятся к выполненным **отдельным пунктам**, а не к готовности всего BB0–BB9. Созданный файл не означает работающую интеграцию. Составной пункт остаётся `[ ]`, если хотя бы одна его обязательная часть не проверена; уже выполненные части перечислены здесь. Пороги, зависимости и требования live/perf не менялись.

**Учёт:** **25/222 core-пунктов (11,3%)**, всего **36/272** с организационными пунктами и optional BB7. Это доля выполненных пунктов, не процент готовности продукта: часть отметок относится к созданным и проверенным исходникам. Полностью принятых core-срезов: **0/9**; BB7 optional/default-off. В полном документе 272 пункта: 222 core BB0–BB6/BB8–BB9, 25 организационных/закрывающих и 25 optional BB7.

| Срез | Уже реализовано и проверено | Что ещё не принято |
|---|---|---|
| BB0 | Controlled candidate/manifest; provider 223 PASS, 1 optional skip, отдельно SQLite integration 2/2 и archived regressions 4/4; build/doctor exit 0; 9/9 outputs сохранены. SDK 1.2 fix: независимые 5/5. Изолированный host flow 11/11; Benchmark из 62 samples/63 requests. | Все 10 PNG; actual visible paint. Benchmark — INCONCLUSIVE, не speedup/budget PASS. Native terminal route 0.6.37 запускает login shell до wrapper: confinement NO-GO, нового GO нет. |
| BB1 | Fail-closed binding/identity; lifecycle возвращает `projection-unavailable`; SOURCE PASS и независимая Node 24 QA 1/1, zero CLI/register/submit; author Bun 16/16 включает архив baseline. | Нет доказанного registration/attach port и UI caller. Нет native BB record/row, UI/perf. Минимальный isolated core/SDK patch уже разрешён в scope.md, но не реализован; installed dist не меняется. |
| BB2 | SDK 1.2 Anchor/Reporter checkpoint, foreground/background/reopen; Courier persisted batch + hold/release. Author 10/10; отдельные SOURCE PASS и Node 24 QA 3/3, два результата/одна доставка, stable ID, reopen без child replay. Дополнительно forced SIGKILL recovery 2/2: admission на архиве Anchor v1 и batch-before-ack на текущем Courier. | Live transport/UI/PNG/perf не приняты; typecheck UNAVAILABLE. Составной unit-пункт открыт: нет evidence/BB2/tests.xml, а перенос admission-crash evidence с Anchor v1 на current candidate требует явного unchanged-code обоснования. Raw Courier QA 3/3 находится в native child thread, не в выдуманном receipt-файле. |
| BB3 | Не реализован как отдельный срез. BB1 helper не засчитывается за durable binding/reconnect. | Зависит от BB1/BB2; controls, права, crash record→binding. |
| BB4 | Graph bridge/translator и тесты созданы. v3 независимая SDK QA 2/2; найден реальный production-caller stale parent-turn bug. v4 candidate-006: author RED→GREEN, 15/15, build/typecheck exit 0. | Source review v4 ещё не согласован: reviewer заявил compaction HOLD, но Lead показал, что штатный child adapter такие события отбрасывает; production-достижимость замечания оспаривается, исправление без доказанного пути не засчитано. Независимая v4 QA 2/2 прошла обычный child lifecycle и active control; compaction не проверен. Старый v3 PASS не переносится на новый candidate; UI/PNG/perf не приняты. |
| BB5 | SDK 1.2 loader/catalog, admission, aliases/realpath conflict. v2 SOURCE PASS + независимая actual SDK QA 4/4, author 10/10. | Нет runtime caller/inventory integration: Pi loader context и Durable invocation ещё не связаны. Leaf-only PASS не означает загрузку extensions при запуске host. |
| BB6 | Не реализован. | Hook/context → commands/UI → reload; guards direct/nested, isolation, failed reload. |
| BB7 | Не включён, optional/default-off. | Ни один adapter не принят пакетным historical PASS. |
| BB8 | Не реализован как UI-срез. | Native child navigation/controls, accessibility, browser/paint/perf. |
| BB9 | Не начат. | Cross-feature acceptance и проверенная restore parity. |

**Evidence:** [BB0 tests.xml](../../evidence/BB0/tests.xml), [unit checkpoint](../../evidence/BB0/lead-baseline-unit-checkpoint.json), [host 11/11](../../evidence/BB0/coordinator-sdk12-live-result.json), [Benchmark](../../evidence/BB0/benchmark-sdk12/report.md), [source/output correction](../../evidence/BB0/luna-source-output-visual-boundary.json); [BB1 v2 QA](../../evidence/BB1/qa-luna-v2/receipt.md); [BB4 v3 QA](../../evidence/BB4/qa-luna-v3/receipt.md), [v4 manifest](../../candidates/parallel-bb4/provider/checks/v2/candidate-006.sha256); [BB5 v2 QA](../../evidence/BB5/qa-luna-v2/receipt.md); [BB2 forced-recovery 2/2](../../evidence/BB2/qa-crash-luna/forced-recovery-receipt.json), SHA-256 `d52a1816a28bdebb8bd928206ca276f51d41c1e5e6bdd52c4ed235e8117ec55a`. BB2 independent Courier command/exit/raw stdout и все пять before/after pins находятся в видимом native child `qa-courier-luna`; постоянный file receipt ещё не создан из-за сбоя Agent Mail.

**Оговорки координации:** BB1 v2 и BB4 v3 QA сообщили запись artifacts после expiry lease; последующий reacquire не покрывает запись задним числом. Поэтому общий пункт про leases не отмечен. Действует поздний допуск Pocket children вместо обязательного BB-child execution surface; это не доказательство native projection. Isolated BB1/BB2/BB4/BB5 coding до приёмки BB0 отдельно разрешён; integration dependencies сохранены. Текущий выбор для всех новых детей — только `openai-codex/gpt-6-luna`, `thinking=high`, без free/fallback; effective model UNKNOWN не является work gate. Исторические free-model/timer записи в scope.md не переопределяют поздние команды; текущий owned timer — `5150f4`.

## Program checklist

### Arm the program

- [x] Показать этот план владельцу и остановиться. Начать реализацию только по явной команде.
- [x] Подтвердить scope BB + текущий host. Pocket только read-only донор, терминал только сохраняемый контракт. Сохранить `scope.md`.
- [x] Закрепить версии и живые source paths. `git show origin/main:` применять только к реально версионируемым правилам целевого проекта. Для глобальных Pi skills читать закреплённые локальные файлы, не выдумывать их наличие в trunk.
- [x] Не включать `/loop 1h` без отдельного unattended grant. Использовать completion events. Краткий status message отправлять только при изменении проверяемого результата или блокера.
- [ ] При hold остановить новые записи во всех lanes, сохранить частичные изменения и release leases. Ничего не удалять и не сбрасывать.

### Spawn owners

- [ ] После BB0 можно параллельно исследовать/реализовывать BB1, BB2, BB4 и BB5 на непересекающихся файлах. Зависимости остальных единиц указаны ниже.
- [ ] Каждый writer получает отдельную bridge identity, назначение и узкие exclusive Agent Mail leases. Совместные runtime.ts, shared-server.ts и общий git index не редактируются одновременно без сериализации.
- [ ] Все исполнители и независимые проверяющие являются видимыми BB children на provider `pi-durable`. Перед стартом проверить каталог модели. В текущем исследовании доступны `openai-codex/gpt-6-luna` и `openai-codex/gpt-6.1-sol`; доступность перепроверяется при исполнении.
- [x] Не считать эти исследовательские BB children доказательством native conversation projection. Не запускать дубликат writer из-за позднего уведомления.

### PR mechanics

- [ ] Сначала согласовать узкий host/client/identity contract. Каждый work unit держать в пределах одного результата и примерно пяти файлов. Больший diff разделить до исполнения.
- [x] Source-controlled candidate должен сохранять managed 0.2.29 fixes и чужие изменения. Не менять рабочий dist вручную, не заменять его старым checkout целиком.
- [ ] До разрешённого commit выполнить deslop/manual quality pass и no-comments review. Lint, typecheck и focused checks должны относиться к окончательным файлам.
- [x] PR/commit/push/merge выполнять только в разрешённых правилами проекта пределах. Этот план не создаёт GitHub PR и не переписывает историю.

### Verdict and merge

- [ ] Независимый reviewer проверяет точный candidate fingerprint и evidence, не только описание владельца.
- [ ] Для меняющихся взаимодействий показать владельцу screenshot и video. Не объявлять native child готовым по provider label, nested card или одному agent_end.
- [x] Failed или unavailable обязательный gate блокирует соответствующую единицу. Другие независимые lanes продолжаются. Любой новый candidate отменяет неподтверждённые старые verdicts.

### Boot recipe

- [x] Запускать отдельный local candidate с временным приватным data root, synthetic историями, faux models и отдельным Unix socket. Ни live Pocket, ни рабочая Durable SQLite не открываются.
- [ ] Проверять BB через реальный UI/control-ui или native agent_browser, host/CLI через control-cli и явные ready conditions. Screenshots сохранять в `evidence/BBx/lane-N.png`.
- [x] Каждый срез проверяет только собственный результат и существующие регрессии. Его десять сценариев ниже специализированы под этот срез и могут идти последовательно локально. BB0 не требует будущей native identity, BB2 проверяется через реальный host, BB4/BB5 не ждут BB3. Полный cross-feature набор обязателен только для BB9. Десять платных моделей или VM не требуются.
- [x] Для perf сначала прочитать benchmark-checklist, затем снять baseline на том же workload. Числа ниже являются будущими acceptance budgets, а не измеренными ускорениями.

## Зафиксировать воспроизводимый кандидат и baseline (BB0)

**Depends on.** None.

**Files.**

- [x] Артефакты candidate-manifest.json и baseline.json.
- [x] Существующие runtime launcher и package manifests только для чтения.

**Build.**

- [x] Зафиксировать активный provider 0.2.29, host, SDK 1.2.0, реальные module-resolution paths и fingerprints. Сохранить managed 0.2.29 compatibility fixes и чужой dirty diff. Не брать 0.2.28 wholesale.
- [x] Подготовить отдельный кандидат без live SQLite и без записи в Pocket. Сначала установить controlled source-of-truth для host и provider, а не править установленный dist. Manifest содержит source roots/revisions, module-resolution paths, managed fixes, build command и связь fingerprints output с candidate.

**You see.**

- [ ] Рабочий BB и подключённый терминал не меняются. Изолированный кандидат воспроизводит текущую общую сессию на synthetic data. Сохранить evidence/BB0/outcome.json.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Повторить существующие upgrade-background-contract.test.mjs и upgrade-sdk-resources.test.mjs. Зафиксировать обычный provider npm test и build на идентифицированном кандидате. Сохранить evidence/BB0/tests.xml и окончательные fingerprints.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `openai-codex/gpt-6-luna` at the PR head. Следовать local boot recipe и admission модели.

- [ ] Lane 1. Регрессия общего transport. проверить baseline и candidate на одной synthetic conversation. Save `evidence/BB0/lane-1.png`. Pass when одни IDs, прежние рабочие команды и запись известного baseline gap.
- [ ] Lane 2. Источник сборки. сопоставить source revision, managed fixes и output fingerprints. Save `evidence/BB0/lane-2.png`. Pass when каждый исполняемый output прослеживается к candidate.
- [ ] Lane 3. Владелец storage. подключить два наблюдателя текущего протокола. Save `evidence/BB0/lane-3.png`. Pass when SQLite открывает только один native owner.
- [ ] Lane 4. Терминальный контракт. продолжить fixture через существующий терминальный renderer. Save `evidence/BB0/lane-4.png`. Pass when интерфейс и выбранная conversation не заменены.
- [ ] Lane 5. Detach. отключить один текущий клиент во время faux generation. Save `evidence/BB0/lane-5.png`. Pass when работа и второй клиент продолжаются.
- [ ] Lane 6. Late attach существующего протокола. подключить второй клиент после начала ответа. Save `evidence/BB0/lane-6.png`. Pass when показан актуальный snapshot без повторного submit.
- [ ] Lane 7. Граница сессий. предъявить известному host другую scoped session. Save `evidence/BB0/lane-7.png`. Pass when доступ отклонён и нет чужой истории.
- [ ] Lane 8. Конфигурация. задать отсутствующий socket в candidate client. Save `evidence/BB0/lane-8.png`. Pass when явная ошибка без запасного Harness.
- [ ] Lane 9. Предсуществующие guards. вызвать запрещённый synthetic MCP fixture. Save `evidence/BB0/lane-9.png`. Pass when защита отказала до side effect.
- [ ] Lane 10. Состояние baseline. зафиксировать отсутствие пока не реализованных native BB capabilities. Save `evidence/BB0/lane-10.png`. Pass when нет ложного native-child PASS и доступны исходные regression evidence.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. cold/warm attach и submit-to-first-visible-text на loopback faux workload.
- [ ] Probe. На одинаковом faux trace чередовать baseline/candidate, отдельно cold и warm, 30 warm повторов. Сохранить raw samples и Benchmark report. Для модели не смешивать сетевую задержку с provider/UI overhead.
- [ ] Baseline. Снять trunk/reference value первым. Если feature отсутствует, записать N/A для этого пути и измерить общий сохраняемый путь плюс добавленную работу без фиктивного ratio.
- [ ] Rule. Измерить baseline первым. В следующих срезах p95 существующего пути не ухудшается более чем на 15 процентов при одинаковом workload.

**Review gate.** None. BB0 is not review-gated.

**Merge.**

- [ ] Root принимает BB0 только по точному candidate и независимому verdict. Интегрировать в принятом для проекта порядке. Публикация и активация остаются отдельными разрешениями.

## Доказать поддержанный путь native BB child без prompt (BB1)

**Depends on.** BB0.

**Files.**

- [x] provider src/host/subthread-spawner.ts.
- [x] provider src/host/native-child-binding.ts как новый узкий модуль.
- [x] provider tests/native-child-binding.test.ts.
- [x] Подтверждённый BB SDK contract только для чтения на этом срезе.

**Build.**

- [x] Проверить текущий SDK и BB thread service на создание представления существующей provider conversation без initial input. Не выдумывать attach API и не писать напрямую в BB DB.
- [ ] До доказательства поддержанного порта native-to-BB projection в candidate fail-closed. Старый spawn-with-prompt не вызывается, native child исполняется только в Durable, а BB показывает projection unavailable. Если нужен BB core/SDK patch, выдать конкретный минимальный контракт и оставить BB1 blocked до отдельного допуска и проверки. Независимые host-only проверки BB2 не вызывают BB prompt-spawner.

**You see.**

- [ ] Нативная conversation получает один настоящий BB child record и корректного родителя, но создание представления не запускает модель. Сохранить evidence/BB1/outcome.json.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Создать node --test tests/native-child-binding.test.ts. Проверить повторное событие, отказ регистрации, принадлежность сессии и нулевое число submit из projection path. Сохранить evidence/BB1/tests.xml и окончательные fingerprints.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `openai-codex/gpt-6-luna` at the PR head. Следовать local boot recipe и admission модели.

- [ ] Lane 1. Регрессия. сравнить безопасный исходный child descriptor и новый registration path. Save `evidence/BB1/lane-1.png`. Pass when native execution не переотправлен.
- [ ] Lane 2. Основной результат. зарегистрировать существующего synthetic ребёнка через доказанный BB port. Save `evidence/BB1/lane-2.png`. Pass when один native BB child record без initial prompt.
- [ ] Lane 3. Недоступный порт. отключить поддержанную capability в candidate. Save `evidence/BB1/lane-3.png`. Pass when projection unavailable и старый prompt-spawn не вызван.
- [ ] Lane 4. Повторное событие. повторить registration event с тем же backend/conversation. Save `evidence/BB1/lane-4.png`. Pass when не создан второй BB record.
- [ ] Lane 5. Ошибка BB create. вернуть проверяемый отказ до создания записи. Save `evidence/BB1/lane-5.png`. Pass when Durable child не перезапущен.
- [ ] Lane 6. Права регистрации. предъявить forged requester и чужую conversation. Save `evidence/BB1/lane-6.png`. Pass when отказ до регистрации и выдачи данных.
- [ ] Lane 7. Разделение идентификаторов. создать одинаковые conversation IDs в разных synthetic stores. Save `evidence/BB1/lane-7.png`. Pass when mapping не путает backend/session.
- [ ] Lane 8. Отсутствие fallback. предъявить несовместимую версию port contract. Save `evidence/BB1/lane-8.png`. Pass when нет direct SQL, local runner или подставного prompt.
- [ ] Lane 9. Связь с родителем. создать root и два child descriptors. Save `evidence/BB1/lane-9.png`. Pass when BB parentThreadId соответствует запрошенному родителю.
- [ ] Lane 10. Счётчики исполнения. сравнить model invocation counter до и после registration. Save `evidence/BB1/lane-10.png`. Pass when счётчик не увеличился от projection.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. native child creation-to-visible-BB-row.
- [ ] Probe. На одинаковом faux trace чередовать baseline/candidate, отдельно cold и warm, 30 warm повторов. Сохранить raw samples и Benchmark report. Для модели не смешивать сетевую задержку с provider/UI overhead.
- [ ] Baseline. Снять trunk/reference value первым. Если feature отсутствует, записать N/A для этого пути и измерить общий сохраняемый путь плюс добавленную работу без фиктивного ratio.
- [ ] Rule. При отсутствии этой возможности на trunk не считать ускорение. Целевой local p95 появления готовой строки не более 2000 ms.

**Review gate.** The operator reviews before merge.

- [ ] Показать operator screenshot каждого изменившегося состояния и video длительностью 30-60 секунд из local candidate. Сохранить evidence/BB1/review.png и evidence/BB1/review.mp4. Не считать approval deployment-разрешением.

**Merge.**

- [ ] Root принимает BB1 только по точному candidate и независимому verdict. Интегрировать в принятом для проекта порядке. Публикация и активация остаются отдельными разрешениями.

## Перенести настоящий background и возврат результатов (BB2)

**Depends on.** BB0. Публичный child descriptor согласовать с BB1.

**Files.**

- [x] host durable/subagent.ts.
- [x] host durable/subagents/tasks.ts.
- [x] host durable/subagents/documents.ts.
- [x] host durable/subagents/delivery.ts.
- [x] host durable/subagents/background.test.mjs.

**Build.**

- [x] Взять Pocket Anchor/Reporter/Courier и нужные документы как reviewed source. Портировать с SDK 1.1 на 1.2, включая content/output, lifecycle, admission и stable request IDs. Не переносить PocketApp или второй scheduler.
- [ ] Сначала BB2.1 даёт anchored spawn и один reporter, затем BB2.2 добавляет courier batch/hold; каждый подсрез имеет свой зелёный checkpoint. Сохранить foreground как явную опцию. Добавить имена, разрешённые роли и configurable admission limit. Ограничение прав задаётся tools/env/profile, а не одним role prompt. Не разрешать бесконечный recursive spawn.
- [ ] Различать Stop текущего родителя, Stop выбранного ребёнка и Stop всей background работы. Пакетная доставка результатов не должна терять их при idle, abort или лимите расходов.

**You see.**

- [ ] Родитель отвечает и продолжает полезную работу, пока ребёнок заблокирован. После завершения приходит один report или один сохранённый batch. Сохранить evidence/BB2/outcome.json.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Расширить реальные SDK tests gate-child/parent-free. Добавить temporary SQLite reopen, stable requestId admission, foreground, cancel и budget hold. Принудительно завершить отдельный test process между admission и receipt, затем между сохранением result batch и delivery acknowledgement. После reopen проверить один execution и одну доставку. Interrupted unsafe operation не replay автоматически, uncertain outcome показывать явно. Сохранить evidence/BB2/tests.xml и окончательные fingerprints.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `openai-codex/gpt-6-luna` at the PR head. Следовать local boot recipe и admission модели.

- [ ] Lane 1. Регрессия foreground. запустить явный foreground через текущий host transport. Save `evidence/BB2/lane-1.png`. Pass when родитель ждёт один результат как раньше.
- [ ] Lane 2. Настоящий background. удержать child на gate и завершить ответ родителя. Save `evidence/BB2/lane-2.png`. Pass when родитель свободен при живом ребёнке.
- [ ] Lane 3. Несколько детей. запустить три named child conversations через host без BB projection. Save `evidence/BB2/lane-3.png`. Pass when conversation IDs различны и активный limit соблюдён.
- [ ] Lane 4. Report. завершить одного ребёнка. Save `evidence/BB2/lane-4.png`. Pass when родителю доставлен один report.
- [ ] Lane 5. Batch courier. завершить два близких synthetic результата. Save `evidence/BB2/lane-5.png`. Pass when batch не теряет ответы и не создаёт лишних очередных turns.
- [ ] Lane 6. Parent stop. остановить только текущий ответ родителя. Save `evidence/BB2/lane-6.png`. Pass when политика независимой background работы сохранена.
- [ ] Lane 7. Child stop. отменить одного ребёнка при работающем соседе. Save `evidence/BB2/lane-7.png`. Pass when сосед продолжает работу.
- [ ] Lane 8. Admission crash. завершить isolated process после admission до receipt и reopen. Save `evidence/BB2/lane-8.png`. Pass when одна заявка и один execution либо явно uncertain unsafe state.
- [ ] Lane 9. Delivery crash. завершить isolated process после persisted batch до acknowledgement. Save `evidence/BB2/lane-9.png`. Pass when после reopen одна доставка без потери результата.
- [ ] Lane 10. Отказ лимита. достичь заданного synthetic budget и затем разрешённо снять hold. Save `evidence/BB2/lane-10.png`. Pass when report сохранён, причина видна и нет busy loop.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. spawn receipt latency и число дополнительных parent model turns на одинаковом batch.
- [ ] Probe. На одинаковом faux trace чередовать baseline/candidate, отдельно cold и warm, 30 warm повторов. Сохранить raw samples и Benchmark report. Для модели не смешивать сетевую задержку с provider/UI overhead.
- [ ] Baseline. Снять trunk/reference value первым. Если feature отсутствует, записать N/A для этого пути и измерить общий сохраняемый путь плюс добавленную работу без фиктивного ratio.
- [ ] Rule. Local faux p95 receipt не более 1000 ms. Число parent turns не больше необъединённого baseline. Сохранность результатов обязательна независимо от latency.

**Review gate.** The operator reviews before merge.

- [ ] Показать operator screenshot каждого изменившегося состояния и video длительностью 30-60 секунд из local candidate. Сохранить evidence/BB2/review.png и evidence/BB2/review.mp4. Не считать approval deployment-разрешением.

**Merge.**

- [ ] Root принимает BB2 только по точному candidate и независимому verdict. Интегрировать в принятом для проекта порядке. Публикация и активация остаются отдельными разрешениями.

## Сохранить привязку и управление тем же ребёнком (BB3)

**Depends on.** BB1 и BB2.

**Files.**

- [ ] provider src/host/native-child-binding.ts.
- [ ] provider src/runner/shared-host.ts.
- [ ] host durable/shared-server.ts.
- [ ] host durable/shared-commands.ts.
- [ ] provider tests/native-child-reconnect.test.ts.

**Build.**

- [ ] Сохранять binding backend/session/conversation/BB-thread в устойчивом состоянии через поддержанные APIs. Process-local Map и task name не являются identity. Использовать существующую доверенную BB/provider authorization boundary. Перед registration, history attach и Stop/Steer/Follow-up проверять полномочия requester на целевую conversation. Переданный клиентом tuple не является разрешением, Pocket account model не переносится.
- [ ] Attach существующего child должен получать snapshot/history без prompt. Открывать завершённого child после исчезновения его task из live graph. Stop/Steer/Follow-up направлять строго в выбранную conversation.

**You see.**

- [ ] Child открывается как обычный BB thread с правильной историей. После reconnect остаётся тот же агент, сосед не останавливается. Сохранить evidence/BB3/outcome.json.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Создать node --test tests/native-child-reconnect.test.ts. Проверить late attach, fast completion, repeated event, process reopen, child-scoped abort и отсутствие второго Harness. Принудительно завершить isolated candidate после BB record creation до binding persistence. После reopen проверить один BB record и восстановленную binding. Forged tuple, чужая сессия, revoked requester и stale binding отклоняются до выдачи истории или side effect. Сохранить evidence/BB3/tests.xml и окончательные fingerprints.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `openai-codex/gpt-6-luna` at the PR head. Следовать local boot recipe и admission модели.

- [ ] Lane 1. Регрессия binding. сравнить ранее зарегистрированного ребёнка до и после reopen. Save `evidence/BB3/lane-1.png`. Pass when IDs не сменились.
- [ ] Lane 2. Открытие. открыть существующий child в native BB. Save `evidence/BB3/lane-2.png`. Pass when показана его история без prompt.
- [ ] Lane 3. Позднее открытие. открыть завершённого child после удаления task из live graph. Save `evidence/BB3/lane-3.png`. Pass when conversation остаётся доступной.
- [ ] Lane 4. Scoped controls. направить Stop/Steer/Follow-up выбранному child. Save `evidence/BB3/lane-4.png`. Pass when обработана нужная conversation и сосед не затронут.
- [ ] Lane 5. Record-to-binding crash. прервать test process после BB create до записи binding. Save `evidence/BB3/lane-5.png`. Pass when reconcile находит один BB record без второго execution.
- [ ] Lane 6. Forged tuple. предъявить корректно сформированный, но чужой identity tuple. Save `evidence/BB3/lane-6.png`. Pass when нет истории и side effect.
- [ ] Lane 7. Revocation. отозвать доступ requester перед новым control call. Save `evidence/BB3/lane-7.png`. Pass when отказ до команды, routing mapping не даёт прав.
- [ ] Lane 8. Stale binding. предъявить binding прошлого backend/session. Save `evidence/BB3/lane-8.png`. Pass when нет привязки к другой conversation.
- [ ] Lane 9. Fast child. дать ребёнку закончить до начала BB подписки. Save `evidence/BB3/lane-9.png`. Pass when один final result и полная доступная история.
- [ ] Lane 10. Disconnect. отсоединить BB при работающем host. Save `evidence/BB3/lane-10.png`. Pass when reconnect восстанавливает snapshot, detach не отменяет работу.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. reconnect-to-authoritative-snapshot и stop-to-settlement.
- [ ] Probe. На одинаковом faux trace чередовать baseline/candidate, отдельно cold и warm, 30 warm повторов. Сохранить raw samples и Benchmark report. Для модели не смешивать сетевую задержку с provider/UI overhead.
- [ ] Baseline. Снять trunk/reference value первым. Если feature отсутствует, записать N/A для этого пути и измерить общий сохраняемый путь плюс добавленную работу без фиктивного ratio.
- [ ] Rule. Local faux p95 snapshot не более 2000 ms. Для контролируемого cancellable fixture stop-to-settlement не более 2000 ms. Нельзя объявлять arbitrary process kill гарантией.

**Review gate.** The operator reviews before merge.

- [ ] Показать operator screenshot каждого изменившегося состояния и video длительностью 30-60 секунд из local candidate. Сохранить evidence/BB3/review.png и evidence/BB3/review.mp4. Не считать approval deployment-разрешением.

**Merge.**

- [ ] Root принимает BB3 только по точному candidate и независимому verdict. Интегрировать в принятом для проекта порядке. Публикация и активация остаются отдельными разрешениями.

## Показать правдивый runtime task graph (BB4)

**Depends on.** BB0. Для группировки детей использовать descriptor BB2.

**Files.**

- [x] provider src/runner/task-graph-bridge.ts.
- [x] provider src/host/delta-translator.ts.
- [x] provider tests/task-graph-bridge.test.ts.
- [x] provider tests/delta-translator.test.ts.

**Build.**

- [ ] Не отображать waiting и completing как terminal success. При узком BB enum оставить nonterminal status и показать точное состояние и причину текстом.
- [ ] Передавать пустой snapshot и очищать старые строки. Различать disconnected/unknown и отсутствие активной работы. Сохранять owner edges, background и cancellation-requested metadata.

**You see.**

- [ ] В BB понятно, кто выполняется, кого ждёт, кто завершает owned work и что действительно остановлено. Граф не выдаётся за backlog проекта. Сохранить evidence/BB4/outcome.json.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Запустить node --test tests/task-graph-bridge.test.ts tests/delta-translator.test.ts. Добавить все состояния, пустой graph, reconnect, reordered snapshot и исчезновение terminal tasks. Сохранить evidence/BB4/tests.xml и окончательные fingerprints.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `openai-codex/gpt-6-luna` at the PR head. Следовать local boot recipe и admission модели.

- [ ] Lane 1. Регрессия plan renderer. передать прежние допустимые active/pending события. Save `evidence/BB4/lane-1.png`. Pass when существующее отображение сохранено.
- [ ] Lane 2. Pending. показать ещё не взятую SDK task. Save `evidence/BB4/lane-2.png`. Pass when UI сообщает ожидание запуска.
- [ ] Lane 3. Running. перевести task в running. Save `evidence/BB4/lane-3.png`. Pass when UI сообщает выполнение.
- [ ] Lane 4. Waiting. создать wait на конкретную другую task. Save `evidence/BB4/lane-4.png`. Pass when видна причина и нет terminal success.
- [ ] Lane 5. Completing. удержать ordinary owned child после завершения execute. Save `evidence/BB4/lane-5.png`. Pass when owner показан nonterminal.
- [ ] Lane 6. Abort requested. запросить отмену до settlement. Save `evidence/BB4/lane-6.png`. Pass when UI не утверждает, что остановка уже завершилась.
- [ ] Lane 7. Empty snapshot. после непустого graph передать authoritative empty. Save `evidence/BB4/lane-7.png`. Pass when старые runtime строки очищены.
- [ ] Lane 8. Disconnect. прекратить поступление авторитетных snapshots. Save `evidence/BB4/lane-8.png`. Pass when unknown не подменён completed или failed.
- [ ] Lane 9. Reordering. передать старое событие после более свежего snapshot. Save `evidence/BB4/lane-9.png`. Pass when новое состояние не перезаписано.
- [ ] Lane 10. Названия и ownership. показать несколько разных SDK task kinds и edges. Save `evidence/BB4/lane-10.png`. Pass when graph не объявлен backlog или процентом готовности проекта.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. committed graph change-to-visible-state.
- [ ] Probe. На одинаковом faux trace чередовать baseline/candidate, отдельно cold и warm, 30 warm повторов. Сохранить raw samples и Benchmark report. Для модели не смешивать сетевую задержку с provider/UI overhead.
- [ ] Baseline. Снять trunk/reference value первым. Если feature отсутствует, записать N/A для этого пути и измерить общий сохраняемый путь плюс добавленную работу без фиктивного ratio.
- [ ] Rule. Local p95 обновления состояния не более 300 ms. Ни одного потерянного terminal или clear event.

**Review gate.** The operator reviews before merge.

- [ ] Показать operator screenshot каждого изменившегося состояния и video длительностью 30-60 секунд из local candidate. Сохранить evidence/BB4/review.png и evidence/BB4/review.mp4. Не считать approval deployment-разрешением.

**Merge.**

- [ ] Root принимает BB4 только по точному candidate и независимому verdict. Интегрировать в принятом для проекта порядке. Публикация и активация остаются отдельными разрешениями.

## Автоматически загрузить одобренные Pi ресурсы (BB5)

**Depends on.** BB0.

**Files.**

- [x] host durable/pi-extensions/loader.ts.
- [x] host durable/pi-extensions/catalog.ts.
- [ ] host durable/runtime.ts.
- [x] host durable/pi-extensions/loader.test.mjs.
- [x] host durable/pi-extensions/catalog.test.mjs.

**Build.**

- [x] Использовать опубликованный согласованный Pi SDK 1.2.0 для DefaultResourceLoader и package/settings discovery. Не импортировать старый coding-agent 1.0.2 ради удобства. Проверить реальные loader aliases.
- [ ] Переиспользовать Pocket enabled state, error reporting и name-conflict правила. Загружать только ранее допущенные ресурсы, не auto-trust новые drop-ins. Не устанавливать второй MCP connector, CodeMode или конкурирующий subagent owner.

**You see.**

- [ ] При открытии BB доступны разрешённые tools, skills и prompt resources. Ошибка или unsupported capability видна, а не скрыта фиктивным успехом. Сохранить evidence/BB5/outcome.json.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Запустить loader.test.mjs и catalog.test.mjs на synthetic agentDir/projectDir. Проверить команды, package resources, conflict, trust отказ и отсутствие обращения к live config. Сохранить evidence/BB5/tests.xml и окончательные fingerprints.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `openai-codex/gpt-6-luna` at the PR head. Следовать local boot recipe и admission модели.

- [ ] Lane 1. Регрессия базовых tools. запустить существующий host с loader adapter. Save `evidence/BB5/lane-1.png`. Pass when native CodingTools и guards доступны.
- [ ] Lane 2. User factory. загрузить разрешённый fixture из synthetic agentDir. Save `evidence/BB5/lane-2.png`. Pass when tool и metadata зарегистрированы.
- [ ] Lane 3. Project factory. загрузить разрешённый project fixture. Save `evidence/BB5/lane-3.png`. Pass when применён правильный cwd.
- [ ] Lane 4. Trust. предложить недоверенную project factory. Save `evidence/BB5/lane-4.png`. Pass when её initializer не исполнялся.
- [ ] Lane 5. Package resources. разрешить закреплённый локальный package fixture без сети. Save `evidence/BB5/lane-5.png`. Pass when обнаружены заявленные ресурсы.
- [ ] Lane 6. Конфликт имени. попытаться занять native subagent/codemode name. Save `evidence/BB5/lane-6.png`. Pass when конфликт виден и owner не заменён.
- [ ] Lane 7. MCP ownership. загрузить каталог без вторых default factories. Save `evidence/BB5/lane-7.png`. Pass when connector count не увеличился.
- [ ] Lane 8. Ошибка импорта. подать fixture с несуществующим export. Save `evidence/BB5/lane-8.png`. Pass when явный failed resource без ложного loaded.
- [ ] Lane 9. Повторный запуск. открыть candidate вновь с тем же enabled manifest. Save `evidence/BB5/lane-9.png`. Pass when прежний допущенный набор восстановлен.
- [ ] Lane 10. SDK resolution. загрузить опубликованный 1.2 fixture и проверить import provenance. Save `evidence/BB5/lane-10.png`. Pass when старый 1.0.2 loader не подмешан.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. cold startup и warm resource discovery на фиксированном наборе десяти fixtures.
- [ ] Probe. На одинаковом faux trace чередовать baseline/candidate, отдельно cold и warm, 30 warm повторов. Сохранить raw samples и Benchmark report. Для модели не смешивать сетевую задержку с provider/UI overhead.
- [ ] Baseline. Снять trunk/reference value первым. Если feature отсутствует, записать N/A для этого пути и измерить общий сохраняемый путь плюс добавленную работу без фиктивного ratio.
- [ ] Rule. Warm p95 существующего загрузчика не хуже baseline более чем на 15 процентов. Для нового fixture пути добавленное время не более 2000 ms без сети.

**Review gate.** The operator reviews before merge.

- [ ] Показать operator screenshot каждого изменившегося состояния и video длительностью 30-60 секунд из local candidate. Сохранить evidence/BB5/review.png и evidence/BB5/review.mp4. Не считать approval deployment-разрешением.

**Merge.**

- [ ] Root принимает BB5 только по точному candidate и независимому verdict. Интегрировать в принятом для проекта порядке. Публикация и активация остаются отдельными разрешениями.

## Связать hooks и reload с правильной conversation (BB6)

**Depends on.** BB5. Контракт conversation context согласовать с BB2 и BB3.

**Files.**

- [ ] host durable/pi-extensions/tool-bridge.ts.
- [ ] host durable/pi-extensions/events.ts.
- [ ] host durable/pi-extensions/context.ts.
- [ ] host durable/pi-extensions/extension-contract.test.mjs.
- [ ] host durable/pi-extensions/reload.test.mjs.

**Build.**

- [ ] Разделить BB6.1 на hook/context contract, BB6.2 на commands/UI и BB6.3 на reload; каждый проверяется до следующего. Привязать tool_call, result transforms, prompt/lifecycle events, commands и supported UI requests к нужной conversation. Не создавать второй AgentSession или отдельный transcript.
- [ ] Проверить одинаковую enforcement границу для direct и nested CodeMode calls. Сохранить текущие MCP/Agent Mail guards и unsafe replay policy. UI approval обязан реально ждать и отвечать тому же запросу.
- [ ] Переиспользовать Pocket reload идеи, но учитывать живые background tasks, disposal и сохранённые task/document definitions. Failed candidate сохраняет прежний registry. Неподдержанный Pi UI/session API явно отказывать.

**You see.**

- [ ] Расширение действительно блокирует или меняет вызов и не смешивает состояние детей. Failed reload не ломает текущую работу. Сохранить evidence/BB6/outcome.json.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Запустить extension-contract.test.mjs и reload.test.mjs. Hook return effects, cancellation, direct/nested denied call, sibling isolation и failed reload проверяются поведением, не только регистрацией handler. Сохранить evidence/BB6/tests.xml и окончательные fingerprints.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `openai-codex/gpt-6-luna` at the PR head. Следовать local boot recipe и admission модели.

- [ ] Lane 1. Регрессия guards. повторить прежний защищённый вызов. Save `evidence/BB6/lane-1.png`. Pass when действующие MCP/Agent Mail отказы сохранены.
- [ ] Lane 2. Tool-call hook. разрешённо изменить arguments и отдельно block synthetic call. Save `evidence/BB6/lane-2.png`. Pass when исполнитель увидел изменение либо не вызван.
- [ ] Lane 3. Result hook. применить synthetic result transform. Save `evidence/BB6/lane-3.png`. Pass when клиент и модель увидели итоговое преобразование.
- [ ] Lane 4. Nested CodeMode. повторить forbidden tool внутри sandbox call. Save `evidence/BB6/lane-4.png`. Pass when защита сработала до side effect.
- [ ] Lane 5. Lifecycle. запустить root и отдельного ребёнка. Save `evidence/BB6/lane-5.png`. Pass when events относятся к правильной conversation.
- [ ] Lane 6. Sibling isolation. одновременно вызвать один extension в двух contexts. Save `evidence/BB6/lane-6.png`. Pass when состояния и ответы не смешались.
- [ ] Lane 7. Command and UI. выполнить поддержанную команду и настоящий approval roundtrip. Save `evidence/BB6/lane-7.png`. Pass when ответ связан с тем же ожидающим запросом.
- [ ] Lane 8. Unsupported UI. запросить неподдержанный terminal-only API. Save `evidence/BB6/lane-8.png`. Pass when явный отказ, не фиктивный success.
- [ ] Lane 9. Failed reload. предложить ошибочную новую factory при живом старом registry. Save `evidence/BB6/lane-9.png`. Pass when старые tools работают и resources disposed корректно.
- [ ] Lane 10. Background reload policy. предложить reload при активных native tasks. Save `evidence/BB6/lane-10.png`. Pass when политика не теряет task definitions и не отменяет работу неожиданно.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. guard overhead без сети и event/command acknowledgement.
- [ ] Probe. На одинаковом faux trace чередовать baseline/candidate, отдельно cold и warm, 30 warm повторов. Сохранить raw samples и Benchmark report. Для модели не смешивать сетевую задержку с provider/UI overhead.
- [ ] Baseline. Снять trunk/reference value первым. Если feature отсутствует, записать N/A для этого пути и измерить общий сохраняемый путь плюс добавленную работу без фиктивного ratio.
- [ ] Rule. Однотипный direct/nested fixture p95 не хуже baseline более чем на 15 процентов. Security refusal не пропускается ради скорости.

**Review gate.** The operator reviews before merge.

- [ ] Показать operator screenshot каждого изменившегося состояния и video длительностью 30-60 секунд из local candidate. Сохранить evidence/BB6/review.png и evidence/BB6/review.mp4. Не считать approval deployment-разрешением.

**Merge.**

- [ ] Root принимает BB6 только по точному candidate и независимому verdict. Интегрировать в принятом для проекта порядке. Публикация и активация остаются отдельными разрешениями.

## Подключить полезные переносимые Pocket adapters (BB7)

**Depends on.** BB2 и BB6. Не блокирует BB1 и BB4.

**Files.**

- [ ] host durable/adapters/manifest.ts.
- [ ] host durable/adapters/agent-mail.ts.
- [ ] host durable/adapters/search-history.ts.
- [ ] host durable/adapters/contracts.test.mjs.
- [ ] host durable/adapters/README.md.

**Build.**

- [ ] Первым кандидатом взять conversation-scoped search_history. Затем адаптировать Agent Mail identity к существующим guarded Mail tools, не открывая вторую transport цепь. Pocket adapter требует всех объявленных host capabilities, без silent fallback.
- [ ] Каждый adapter принимать отдельно по импорту, версии, scope и side effects. DCG, Context Mode execute/fetch, agent profiles, budgets, schedules и Jobs не включать одним флагом. Их точные статусы и очередность перечислены в Appendix E.

**You see.**

- [ ] В BB появляются нужные готовые возможности без потери scoped identity и без включения непроверенных режимов. Сохранить evidence/BB7/outcome.json.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Запустить contracts.test.mjs с чужой conversation, revoked identity, hidden tool, replay и unsafe interruption. Пакетные исторические PASS не выдавать за наши SDK 1.2 checks. Сохранить evidence/BB7/tests.xml и окончательные fingerprints.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `openai-codex/gpt-6-luna` at the PR head. Следовать local boot recipe и admission модели.

- [ ] Lane 1. Регрессия без adapters. выключить весь дополнительный набор. Save `evidence/BB7/lane-1.png`. Pass when core BB milestone остаётся рабочим.
- [ ] Lane 2. Явный manifest. выбрать только принимаемый adapter. Save `evidence/BB7/lane-2.png`. Pass when остальные режимы не активированы.
- [ ] Lane 3. History own scope. искать собственный synthetic marker. Save `evidence/BB7/lane-3.png`. Pass when найден правильный результат.
- [ ] Lane 4. History foreign scope. искать marker другой conversation. Save `evidence/BB7/lane-4.png`. Pass when результат отсутствует.
- [ ] Lane 5. Identity guard. вызвать существующий guarded Mail fixture. Save `evidence/BB7/lane-5.png`. Pass when использована разрешённая binding.
- [ ] Lane 6. Revoked binding. отозвать Mail binding перед вызовом. Save `evidence/BB7/lane-6.png`. Pass when side effect запрещён.
- [ ] Lane 7. Missing capability. убрать обязательную host capability. Save `evidence/BB7/lane-7.png`. Pass when adapter отказал до запуска watcher.
- [ ] Lane 8. Версия SDK. попытаться загрузить неподтверждённый 1.1 candidate. Save `evidence/BB7/lane-8.png`. Pass when нет молчаливой совместимости с 1.2.
- [ ] Lane 9. Unsafe replay. прервать unsafe synthetic adapter action. Save `evidence/BB7/lane-9.png`. Pass when повтор не произведён автоматически.
- [ ] Lane 10. Default-off. проверить недопущенные Context Mode execute/fetch и прочие candidates. Save `evidence/BB7/lane-10.png`. Pass when они не опубликованы как готовые tools.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. adapter registration и bounded history lookup на фиксированном числе entries.
- [ ] Probe. На одинаковом faux trace чередовать baseline/candidate, отдельно cold и warm, 30 warm повторов. Сохранить raw samples и Benchmark report. Для модели не смешивать сетевую задержку с provider/UI overhead.
- [ ] Baseline. Снять trunk/reference value первым. Если feature отсутствует, записать N/A для этого пути и измерить общий сохраняемый путь плюс добавленную работу без фиктивного ratio.
- [ ] Rule. Bounded local fixture p95 history lookup не более 500 ms. Ни один результат чужого scope не допускается.

**Review gate.** The operator reviews before merge.

- [ ] Показать operator screenshot каждого изменившегося состояния и video длительностью 30-60 секунд из local candidate. Сохранить evidence/BB7/review.png и evidence/BB7/review.mp4. Не считать approval deployment-разрешением.

**Merge.**

- [ ] Root принимает BB7 только по точному candidate и независимому verdict. Интегрировать в принятом для проекта порядке. Публикация и активация остаются отдельными разрешениями.

## Отполировать native BB интерфейс и измерить отзывчивость (BB8)

**Depends on.** BB3, BB4 и BB6. BB7 можно завершать независимо.

**Files.**

- [ ] Существующие provider UI entrypoints и native BB components после проверки SDK.
- [ ] provider src/runner/bridge/bb-child-event-adapter.ts.
- [ ] provider src/host/delta-translator.ts.
- [ ] provider tests/native-ui-events.test.ts.
- [ ] Изолированный UI harness и evidence под thread storage.

**Build.**

- [ ] Использовать обычные BB sidebar children и transcript, не iframe Pocket и не новый dashboard. Показать роль, background, requester/connection state, ожидание approvals и реальные token/usage значения либо unavailable.
- [ ] Добавить scoped Open/Stop/Steer/Follow-up. Не путать Continue с новым исполнением. Сохранять scroll, focus и читабельность длинных tools/results. Ограничивать presentation buffers без потери committed history.
- [ ] Переиспользовать Pocket идеи batching и пояснения состояний. Не копировать Preact frontend. Терминальные и control acknowledgements не откладывать ради batching.

**You see.**

- [ ] Агенты находятся и открываются как обычные BB threads. Интерфейс остаётся отзывчивым при параллельных tools и длинной истории. Сохранить evidence/BB8/outcome.json.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Запустить npm test, npm run build и native-ui-events.test.ts на финальном provider candidate. Затем реальные control-ui/browser сценарии, accessibility basics, console/network и длинный transcript. Сохранить evidence/BB8/tests.xml и окончательные fingerprints.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `openai-codex/gpt-6-luna` at the PR head. Следовать local boot recipe и admission модели.

- [ ] Lane 1. Регрессия trunk. повторить сохраняемую root/thread навигацию на baseline и head. Save `evidence/BB8/lane-1.png`. Pass when старый рабочий flow не ухудшен.
- [ ] Lane 2. Native child row. найти и открыть проверенного child из sidebar. Save `evidence/BB8/lane-2.png`. Pass when видны обычный thread и его история.
- [ ] Lane 3. Одновременный stream. дать трём детям stream текста и tool events. Save `evidence/BB8/lane-3.png`. Pass when истории не перемешаны.
- [ ] Lane 4. Scroll. прокрутить длинную историю при новых deltas. Save `evidence/BB8/lane-4.png`. Pass when ручная позиция не сброшена.
- [ ] Lane 5. Focus. набрать draft и переключить вспомогательный status panel. Save `evidence/BB8/lane-5.png`. Pass when focus и draft сохранены.
- [ ] Lane 6. Control ack. запросить Stop/Steer и следить за ack. Save `evidence/BB8/lane-6.png`. Pass when ack не спрятан за batching и идёт выбранному child.
- [ ] Lane 7. Graph details. развернуть waiting/completing/reporter состояние. Save `evidence/BB8/lane-7.png`. Pass when причина читается и не заменена зелёным success.
- [ ] Lane 8. Unavailable measurements. отключить измерение tokens в fixture. Save `evidence/BB8/lane-8.png`. Pass when показано unavailable, не ноль.
- [ ] Lane 9. Extension diagnostics. показать loaded/disabled/error/unsupported ресурс. Save `evidence/BB8/lane-9.png`. Pass when статусы различимы без второго dashboard.
- [ ] Lane 10. Cold reopen. открыть candidate UI с нуля и дождаться реального ready. Save `evidence/BB8/lane-10.png`. Pass when нет shell-only screenshot или ложного cold-open PASS.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. first visible event, child navigation, graph latency и renderer CPU/RSS на одинаковом trace.
- [ ] Probe. На одинаковом faux trace чередовать baseline/candidate, отдельно cold и warm, 30 warm повторов. Сохранить raw samples и Benchmark report. Для модели не смешивать сетевую задержку с provider/UI overhead.
- [ ] Baseline. Снять trunk/reference value первым. Если feature отсутствует, записать N/A для этого пути и измерить общий сохраняемый путь плюс добавленную работу без фиктивного ratio.
- [ ] Rule. Local p95 committed-event-to-render не более 300 ms, child ready не более 2000 ms. Existing-route median/p95 не хуже baseline более чем на 15 процентов. Ускорение не заявлять без измерения.

**Review gate.** The operator reviews before merge.

- [ ] Показать operator screenshot каждого изменившегося состояния и video длительностью 30-60 секунд из local candidate. Сохранить evidence/BB8/review.png и evidence/BB8/review.mp4. Не считать approval deployment-разрешением.

**Merge.**

- [ ] Root принимает BB8 только по точному candidate и независимому verdict. Интегрировать в принятом для проекта порядке. Публикация и активация остаются отдельными разрешениями.

## Принять интеграцию и подготовить обратимое включение (BB9)

**Depends on.** BB1-BB6 и BB8. BB7 проверяется только для явно включённых adapters. Любой незакрытый native-child gate блокирует принятие.

**Files.**

- [ ] Candidate release manifest и acceptance report.
- [ ] Изолированные integration/e2e fixtures.
- [ ] Runbook проверки и восстановления.
- [ ] Существующие build scripts только в проверенном candidate source.

**Build.**

- [ ] Провести независимый review и QA точного кандидата, полный provider suite, целевые host tests и UI checks. Проверить сохранность schemas/task/document kinds, models, skills, settings и MCP guards.
- [ ] В тестовом контуре повторить BB attach/detach, native child controls, restart/reopen и одновременно подключённый терминал. Терминал не переустанавливать и не менять его интерфейс.
- [ ] Сохранить rollback artifact и проверить restore parity. Запросить отдельное разрешение на активацию рабочего host/provider только после готовых доказательств. Не мигрировать базы, не переключать все треды и не трогать Pocket.

**You see.**

- [ ] Пользователь получает BB с native Durable agents, работающими extensions и честным graph, при сохранённом терминальном подключении. Сохранить evidence/BB9/outcome.json.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Повторить все unit/integration commands, полный npm test и build. Зафиксировать live acceptance screenshots/video и Benchmark report; затем протестировать возврат к baseline на разрешённом тестовом store. Сохранить evidence/BB9/tests.xml и окончательные fingerprints.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `openai-codex/gpt-6-luna` at the PR head. Следовать local boot recipe и admission модели.

- [ ] Lane 1. Регрессия baseline. повторить общий исходный BB/terminal сценарий на финальном candidate. Save `evidence/BB9/lane-1.png`. Pass when сохраняемый пользовательский результат не ухудшен.
- [ ] Lane 2. Native identity. создать и открыть ребёнка через обычный BB. Save `evidence/BB9/lane-2.png`. Pass when тот же backend/session/conversation и один execution.
- [ ] Lane 3. Real background. удержать ребёнка и завершить родительский ответ. Save `evidence/BB9/lane-3.png`. Pass when родитель свободен и затем получает один результат.
- [ ] Lane 4. Scoped rights. проверить чужой requester и выбранный control call. Save `evidence/BB9/lane-4.png`. Pass when запрет действует до истории или side effect.
- [ ] Lane 5. Reconnect. отключить клиент во время tool call и подключить снова. Save `evidence/BB9/lane-5.png`. Pass when snapshot и история восстановлены без prompt.
- [ ] Lane 6. Abrupt recovery. выполнить принятые crash boundaries на temporary SQLite. Save `evidence/BB9/lane-6.png`. Pass when binding и report восстановлены либо unsafe state явно блокирует повтор.
- [ ] Lane 7. Graph lifecycle. показать waiting/completing/empty/disconnected. Save `evidence/BB9/lane-7.png`. Pass when UI не лжёт о выполнении.
- [ ] Lane 8. Extensions. вызвать допущенный extension direct и nested. Save `evidence/BB9/lane-8.png`. Pass when поведение, guards и контексты совпадают с контрактом.
- [ ] Lane 9. Terminal preservation. одновременно продолжить synthetic session из существующего терминала. Save `evidence/BB9/lane-9.png`. Pass when одна история и один storage owner без переустановки TUI.
- [ ] Lane 10. Rollback rehearsal. вернуть разрешённый тестовый candidate к сохранённому baseline. Save `evidence/BB9/lane-10.png`. Pass when restore parity подтверждена и Pocket не затронут.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. совокупный cold/warm attach, visible update, model-turn count, CPU/RSS и stop latency.
- [ ] Probe. На одинаковом faux trace чередовать baseline/candidate, отдельно cold и warm, 30 warm повторов. Сохранить raw samples и Benchmark report. Для модели не смешивать сетевую задержку с provider/UI overhead.
- [ ] Baseline. Снять trunk/reference value первым. Если feature отсутствует, записать N/A для этого пути и измерить общий сохраняемый путь плюс добавленную работу без фиктивного ratio.
- [ ] Rule. Все ранние budgets выполнены на финальном артефакте. Нельзя компенсировать нарушение корректности более быстрым renderer.

**Review gate.** The operator reviews before merge.

- [ ] Показать operator screenshot каждого изменившегося состояния и video длительностью 30-60 секунд из local candidate. Сохранить evidence/BB9/review.png и evidence/BB9/review.mp4. Не считать approval deployment-разрешением.

**Merge.**

- [ ] Root принимает BB9 только по точному candidate и независимому verdict. Интегрировать в принятом для проекта порядке. Публикация и активация остаются отдельными разрешениями.

## Close the program

- [ ] BB0-BB6 и BB8-BB9 закрыты реальными unit/live/perf evidence. BB7 не блокирует core milestone, если дополнительные adapters не включались. Ни один native-child gate не заменён оговоркой.
- [ ] В BB настоящие дети той же Durable session/conversation, единственное исполнение и восстанавливаемая identity.
- [ ] Терминальное подключение сохранено. Pocket, его данные и runtime не менялись.
- [ ] Отдельно перечислены активированные adapters, их версии, ограничения и оставленные выключенными режимы.
- [ ] Показать финальный report, rollback artifact и список оставшихся рисков. Без разрешения не переключать рабочий host/provider.

## Appendix A. Prototype evidence

Исходный upstream прочитан на commit `d05a73fb31ea1c55c861115306df8f358a120de1`. Изучены README/spec и examples 22-24, 28-29, 31. Manifest Durable имеет 1.2.0, но равенство всех опубликованных и upstream исходников не предполагалось.

- `../upgrade-background-tests.xml` содержит 3 passed. Реальный SDK 1.2.0, MemoryStorage и faux model доказали ложный background старого tool owner, работающий anchor/reporter и один report в сценарии. Legacy content в example 23 даёт пустой receipt, output исправляет его.
- `../upgrade-sdk-resources-tests.xml` содержит 1 passed. Опубликованный coding-agent 1.2.0 загрузил synthetic user/project tools, commands и hook registration. Это не полнота реальных extensions.
- Source/dist audit обнаружил `bb thread spawn --prompt` для уже submitted native child и process-local identity maps. Это риск второго execution, не native projection acceptance.
- Live BB sidebar показал research children. Их создал CLI, поэтому native identity не доказана. Cold-open web check не дошёл до готовой истории и показал No thread list plugin is enabled. Причина не установлена; UI gate не засчитан.
- SQLite crash recovery новой интеграции, live same-conversation BB child и performance improvements пока не доказаны. Четыре SDK checks не подменяют эти gates.

## Appendix B. Alternatives rejected

- Не переносить старый adapter 1:1. В нём есть UI/session stubs, и claimed background неверен по ownership.
- Не подключать Pocket UI, не делать Pocket backend центром этой итерации, не переносить его HTTP server/account model. Прямое уточнение пользователя выбрало BB + существующий самостоятельный host.
- Не переписывать терминал и не подключать его заново. Он уже подключён.
- Не извлекать один Harness и затем заново писать Pocket services. Заимствовать нужные документы, задачи и политики с явными host ports.
- Не создавать второй scheduler, свой execution FSM, отдельный Harness для каждого BB child или новый transcript store.
- Не выдавать новый prompt-spawned BB thread, iframe Pocket или nested tool card за представление существующего native агента.
- Не смешивать Pocket SDK 1.1.0, host source coding-agent 1.0.2 и действующий SDK 1.2.0 без адаптации и проверок.

## Appendix C. Risks

- BB1. Установленный SDK 0.6.15 не показал публичный registration/attach port. Если текущий BB contract действительно не поддерживает требуемую операцию, необходим отдельно допущенный минимальный core/SDK patch. Не обходить его прямым SQL или повторным prompt.
- BB2/BB3. Ownership, request IDs и external side effects различаются. Exactly-once admission не гарантирует exactly-once внешнее действие после любого crash.
- BB4. Live graph не содержит всей истории и не является планом проекта. Нельзя считать исчезнувшую task принятой работой.
- BB5/BB6. Обычный Pi ExtensionAPI и PocketHost factories различны. Factories исполняют доверенный код, reload не откатывает их внешние side effects.
- BB7. Context Mode execute имел cancellation fail, Pocket Agent Mail wake не имеет всех capabilities, часть portable candidates не принята. Disabled по умолчанию, без ложного общего PASS.
- BB8. Web preview уже дал неполный cold-open. Перед UI acceptance восстановить воспроизводимый доступ к реальному candidate BB и отличить harness failure от provider defect. Не менять настройки рабочего BB вслепую.
- BB9. Существуют разные рабочие stores и чужие dirty изменения. Не мигрировать, не перезаписывать и не массово переключать threads.

## Appendix D. Links and reading list

- [Карта границ](/home/ubuntu/.bb-server/thread-storage/thr_m5gua3gqyg/upgrade-capability-map.md).
- [Upstream examples](https://github.com/earendil-works/pi/tree/d05a73fb31ea1c55c861115306df8f358a120de1/packages/durable#examples).
- [Initial synthesis](/home/ubuntu/.bb-server/thread-storage/thr_m5gua3gqyg/upgrade-synthesis-report.md). Его варианты с подключением Pocket заменены текущим scope.
- [Separate native BB verdict](/home/ubuntu/.bb-server/thread-storage/thr_m5gua3gqyg/upgrade-native-child-verdict.md).
- [Pocket portable adapters](/home/ubuntu/.bb-server/thread-storage/thr_m5gua3gqyg/upgrade-pocket-adapters-report.md).
- Основные источники Pocket находятся в `/home/ubuntu/Projects/pi-pocket/src/server` и sandbox packages. Полезный старый план `/home/ubuntu/Projects/pi-pocket-sandbox/docs/plans/2026-10-12-1425-feat-shared-durable-backend-plan.md` не переписывался. Его Pocket-backend/TUI work исключён.
- Перед каждым изменением читать AgentEngineering выбранный workflow, текущие AGENTS и нужные definitions. Для BB1/BB3/BB6 применять `how` и независимую критическую проверку `interrogate` при спорном решении. Для actual UI и CLI использовать control-ui/control-cli.
- Перед perf читать benchmark-checklist. Для длительного исполнения вести локальный decision trail по show-me-your-work. Эти ссылки не являются claim, что все leaf skills уже применены.

## Appendix E. Scope, reuse и полномочия

Подтверждённый scope является BB + существующий самостоятельный host на SDK 1.2.0. Pocket служит read-only донором. План хранится в thread storage/docs, а не поверх чужого incomplete tasks/plan.md. Отдельный tasks/todo.md или новый tracker не создавался. После допуска исполнения координатор записывает work items в выбранный проектом канонический tracker и не дублирует их в нескольких backend.

Берём сначала Pocket Anchor/Reporter/Courier, обязательные документы, held-back/result batching, native extension lifecycle идеи и пояснения graph states. Новый host не импортирует PocketApp. Полезное переносится с origin/license и собственными SDK 1.2 tests. Существующий MCP/CodeMode и Hindsight admission сохраняются.

Профили агентов, budget/approval UX и history search принимаются по одному. Agent Mail generic identity может быть переиспользована с guarded transport, но Pocket wake требует недостающих capabilities. DCG остаётся отдельным fail-closed guard, не sandbox. Context Mode read/index/search и execute/fetch не объявляются одинаково готовыми. Search-history scoped к текущей conversation. Durable Jobs смотреть в актуальном pi-durable-workflows, не поднимать его owner над нашим хранилищем. Voice, Pocket UI, браузерный frontend, PR watchers и новый планировщик не входят в обязательный BB milestone.

Принципы, реально повлиявшие на план, перечислены явно. Laziness Protocol оставляет текущий host/transport и берёт готовые Pocket services. Model the Domain требует durable identity tuple, а не названия. Build the Lever сохраняет исполняемые probes. Prove It Works не засчитывает provider label как UI acceptance. Sequence Work into Verifiable Units разделяет BB0-BB9 и не допускает интеграцию не прошедшего gate.

Все numeric budgets являются предлагаемыми acceptance thresholds на local controlled workload. Ускорение ещё не измерялось. Изменять пороги после baseline можно явно, с сохранением причины и старых результатов, но не чтобы спрятать fail.
