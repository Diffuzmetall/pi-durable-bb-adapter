# BB2 runtime startup follow-up: `openDurable`

## Scope

This fresh candidate-bound check adds the production `openDurable` startup caller to the prior private shared-socket proof. It uses the candidate `runtime.ts`, `installSubagentOwner`, the real shared-socket host, a private temporary data root/socket, and faux model responses. The fixture verifies one production owner in the startup registry, foreground waiting, background parent release, one final Courier report, exactly-once gate execution, and Hindsight `bind`/`admit` callbacks.

The Hindsight controller and gate tool are synthetic test adapters implementing the actual startup/owner boundary. This proves callback wiring and admission counts, not Hindsight backend persistence or live UI behavior. No installed/live host, production stores, Pocket, shared terminal, performance path, or SDK 1.3 was used. Existing 2/2 shared-socket evidence remains the earlier scope; this evidence does not claim full BB2 acceptance.

## Reproduction

Candidate root: `/home/ubuntu/Projects/pi-durable-bb-adapter/candidates/parallel-bb2/host`

The test has a resolver embedded in the test file because this candidate is a sparse source overlay. It loads absent coding-agent source files from the read-only reference host, and missing runtime dependencies from the already-present 0.2.29 dependency tree; it does not install or change dependencies. The test asserts the resolved Pi Durable package is exactly `1.2.0`.

```sh
cd /home/ubuntu/Projects/pi-durable-bb-adapter/candidates/parallel-bb2/host
/home/ubuntu/.nvm/versions/node/v24.19.0/bin/node --test --test-reporter=spec packages/coding-agent/src/experimental/durable/subagents/runtime-socket.test.mjs
```

Runtime: Node `v24.19.0`; resolved `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, and `@earendil-works/chord`: `1.2.0` each.

Exact output:

```text
✔ production owner traverses the actual shared socket: foreground waits at child gate (164.813887ms)
✔ production owner traverses the actual shared socket: background frees parent and Courier delivers once (155.742248ms)
✔ openDurable startup installs one owner and keeps Hindsight admission on the foreground path (179.775607ms)
✔ openDurable startup frees the parent and admits one exactly-once Courier report (186.924746ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 4218.24501
```

## Fingerprints

SHA-256 for the final tested candidate and runtime source inputs:

```text
770fde5b89b1b18e8a73a5877c268f198465acdd77ab323b18770b0f551d7864  candidates/parallel-bb2/host/packages/coding-agent/src/experimental/durable/runtime.ts
cb6f2d7fd38c4bafcd887afc71f2d3e5b14e629d0101918323e8d6ad21a5fad2  candidates/parallel-bb2/host/packages/coding-agent/src/experimental/durable/subagent-runtime.ts
f8fd2ae5cc753f5e11391882fae2484c5ce2062f3a5ce3197b385999b34a0136  candidates/parallel-bb2/host/packages/coding-agent/src/experimental/durable/subagent.ts
55294742f60f72bdb4f78bfb34042005385ef48fe926c250ae8ff5def9d69379  candidates/parallel-bb2/host/packages/coding-agent/src/experimental/durable/subagents/tasks.ts
c3c62c61f44117c2a323e8a043d93ec693f8646fe9af3ab4ad29856e3f8327fe  candidates/parallel-bb2/host/packages/coding-agent/src/experimental/durable/subagents/delivery.ts
aeadfca58915eae5b74761df2ffb372c91c913e04d1b72a44a17840da6c07e9b  candidates/parallel-bb2/host/packages/coding-agent/src/experimental/durable/subagents/documents.ts
0dff3f4342ea22289016762f756d7662a0fcabb5d4f3636688274b03ba4c56e7  candidates/parallel-bb2/host/packages/coding-agent/src/experimental/durable/subagents/runtime-socket.test.mjs
1af7783e2df33c2369ad5efef3a5862f9e9b6bbb0fb2c49db8afa1076d3be60f  candidates/parallel-bb2/host/packages/coding-agent/src/experimental/durable/shared-server.ts
de28a51492788e7f5f4d6f20a57fa8b08e32fd9e766a365211b54a3f3959a177  /home/ubuntu/.local/share/pi-durable/host/packages/coding-agent/src/core/model-runtime.ts
e9f7b3969ec2df8978793ec24d2938c560b19733df637ff5abca2ffad30043db  /home/ubuntu/.local/share/pi-durable/host/packages/coding-agent/src/experimental/durable/harness-setup.ts
464d331ff4d67dc9f98490e2dc48e781ab9e029935366ddcddaf42ce9a4a8bbf  /home/ubuntu/.local/share/pi-durable/host/packages/coding-agent/src/experimental/durable/sessions.ts
17dfa3503c9c89cc6656ff4d04b28e174b2dc1aeaf2ee5a053c7532b787f8fcb  /home/ubuntu/.local/share/pi-durable/host/packages/coding-agent/src/experimental/durable/extensions.ts
cc49977f453dba8a0e9d613fbafc561c0f6c30461204f94227cf85d2a97bccc0  /home/ubuntu/.local/share/pi-durable/host/.pi/extensions/durable-reload/index.ts
750bb03ea8002e4f67c73d928fb4ffb79e7a01699141411e16127741d4f4fbe9  /home/ubuntu/.local/share/pi-durable/host/packages/durable/src/mcp-codemode.ts
```

The candidate changes in this follow-up are limited to the existing `runtime-socket.test.mjs` file and this evidence/recipe. The production owner/runtime code was exercised but not edited.
