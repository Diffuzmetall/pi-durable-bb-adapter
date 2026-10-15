# BB Durable upgrade: admitted execution scope

The source requirements are `docs/plans/bb-durable-final-plan.md`. This file records later operator grants; it does not claim that any implementation gate has passed.

## Goal and boundaries

Upgrade the managed BB provider and existing standalone Durable host. Preserve the connected terminal, one storage owner, native conversation identity, guards and recovery. Pocket and sandbox remain read-only donors. Do not add a second execution owner, model loop, transcript database or scheduler to the adapter.

The managed provider source donor is `/home/ubuntu/.local/share/pi-durable/bb-provider-shared-0.2.29`; the host donor is `/home/ubuntu/.local/share/pi-durable/host`. Both are read-only non-Git source trees. Isolated implementation lives in `candidates/provider` and `candidates/host`; BB0 owns provenance and exact source/output manifests. Donor dependencies may be resolved read-only, with fingerprints; this is not a self-contained dependency backup.

## Operator grants, 2026-10-15

- Local implementation of the supplied plan and a separate test BB, including plugin installation and tests there.
- Pocket subagents as implementing Leads and independent checkers, replacing the plan's mandatory BB-child execution surface. The adapter's native BB-child acceptance criteria are unchanged.
- The isolated candidate layout and the smallest necessary BB core/SDK patch in a separate candidate if a supported native-conversation projection port is absent. Never simulate it with prompt-spawn or provider-written SQL.
- Overnight local acceptance after separate independent technical review and behavioral QA, without waiting for the operator to watch every screenshot/video. Retain those artifacts. This replaces only the human wait, not any unit/live/performance/security gate.
- A private GitHub repository and atomic commits of our own cohesive changes for recovery. The coordinator owns inspected backup publication to the verified private remote. Leads do not push.

No production activation, production restart, deployment, production data migration, Pocket changes, destructive cleanup, reset, stash, force push or history rewriting is authorized.

## Coordination and models

The Pocket parent is the sole continuation and tracker owner. Implementing Leads load `pi-beads-lead` and `pi-durable-lead`; the parent coordinates through `pi-beads-orchestator` and `pi-durable-orchestrator`. Apply `poteto-mode`, the relevant `AgentEngineering` workflow and `ponytail`; these do not waive acceptance.

Use Sol 6.1 medium or Luna high for Leads, Gemini 3.8 Flash for QA where the actual runtime admits it, and admitted free models for simple bounded tasks. Pocket rejected Gemini on its own registry despite BB catalog availability; current inventory QA therefore uses the operator-approved Luna pool, disclosed in the conversation. Do not infer registry availability or actual model telemetry from a requested model name.

Each writer has its own Agent Mail identity and narrow exclusive reservations. Serialize only overlapping files and the short Git-index operation. Stage explicit owned paths and inspect all staged content. Never commit runtime stores, credentials, Dolt internals or dependency trees.

## Canonical task and evidence state

`bd` is the only task backend. Always use `/home/ubuntu/.local/bin/bd -C /home/ubuntu/Projects/pi-durable-bb-adapter --db /home/ubuntu/Projects/pi-durable-bb-adapter/.beads/beads.db --sandbox`. Children add `--readonly`; only the coordinator claims and closes issues.

The issue-record export `.beads/issues.jsonl` is an interchange/checkpoint artifact, not a full Dolt backup and not a second live task backend. `tools/seed-beads.py` seeds missing records; it does not overwrite current issue state or supersede later approvals in issue notes.

`evidence/decisions.tsv` records consequential choices. Each acceptance binds the exact candidate, commands, exit codes, source/output hashes and distinct reviewer/QA reports. A successful self-check, idle child or closed administrative decision does not mean an adapter feature passed.

## Test BB

The admitted test instance uses installed `bb-app` 0.46.0 with Node 24.19.0, server `http://127.0.0.1:40886`, daemon port `40887`, and private data root `.test-bb/`. Auto-updates and telemetry are disabled. Every test CLI invocation explicitly selects these targets; ambient working-BB defaults are forbidden. No live database or authentication files were copied.

The owned 15-minute reassessment schedule is `78215f` (replaces cancelled `d51994` and `4db303`). Completion events remain primary. Cancel the owned timer at finite success or cancellation; a registered timer alone does not prove uninterrupted unattended service.
