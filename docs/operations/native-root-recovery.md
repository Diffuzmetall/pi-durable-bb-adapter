# Recover a saved native root answer without resubmitting

This is an explicit OS-operator repair for an existing `pi-durable` BB root. It is not normal thread resume, a migration of native storage, or permission to activate a provider/Core update.

## What changes

The existing authenticated BB Core owner makes one immediate transaction. It finalizes a uniquely matching unfinished assistant item, or appends the missing final answer, then completes the **same existing turn** and corrects its status. All original events, requests, errors, tool history and search entries remain intact. There is no new turn, input acceptance, queue drain, prompt, steer, abort, host launch, SQLite opener or native selection change.

A full transcript replacement was deliberately avoided. The backup still includes the original thread row, every original stored event, and the previous recovery receipt, so the original state and diagnostics remain available independently of the repaired view.

## Preconditions

- Matching adapter/operator and BB Core compatibility artifacts must be activated **only after separate approval**. Building them does not activate them. An absent recovery endpoint fails closed; do not use direct SQL or another authentication route as a fallback.
- The target is an unarchived, nondeleted root owned by this authenticated BB machine, with persisted canonical provider identity and BB status `idle` or `error`.
- The original native process/socket/descriptor still exists. Missing or mismatched native identity is a refusal, not a reason to launch or select another native session.
- Keep the owner quiescent: do not send inputs from BB or the native terminal during prepare/apply. Native recapture is not a distributed execution fence; the Core backup fingerprint rejects intervening BB changes, and native changes observed before apply also refuse.
- The complete ordered native user-entry lineage must match the accepted BB request ledger. Repeated identical input text, external/compacted/missing input history, unsupported content, multiple matching partial answers, live/unknown state or pending native inbox input are refused rather than guessed.
- Choose a new private, absolute recovery directory outside the repository. Backups contain private conversation content, possibly thinking/tool data. Do not publish or commit them.

## Build and inspect, without activation

```sh
npm run build
node scripts/build-bb-history.mjs
node operator/restore-native-root.mjs --help
```

The compatibility build updates the source-pinned archive/manifest and retains its previous pair in a temporary backup. It does not install, reload or restart anything. Use the project's separately approved staging/activation process; preserve the native owner and other active threads.

## Prepare

After activation is separately approved and the matching Core endpoint is available:

```sh
node operator/restore-native-root.mjs prepare \
  --bb-data-dir /ABSOLUTE/BB_DATA_DIR \
  --server-url http://127.0.0.1:PORT \
  --bridge-data-dir /ABSOLUTE/PROVIDER_BRIDGE_DATA_DIR \
  --thread thr_TARGET \
  --recovery-dir /ABSOLUTE/PRIVATE_RECOVERY_DIRECTORY
```

The operator reads the existing private machine credential **in place**, authenticates to the loopback Core endpoint and obtains an authorized backup. `backup.json` is created exclusively with mode `0600`; the file, its directory and the directory's parent are synced before proceeding. An identical existing backup is synced again; a different, partial, linked or nonprivate file is refused, never overwritten.

Only then does the operator send `attach` and `get_state` to the original native socket. It verifies the selected session and captures a settled root snapshot using the public nested `ConversationView.conversation.id` shape. It saves `native.json` and `plan.json` privately. This step does not mutate the BB history or native store.

## Apply

Using the **same arguments and original recovery directory**:

```sh
node operator/restore-native-root.mjs apply \
  --bb-data-dir /ABSOLUTE/BB_DATA_DIR \
  --server-url http://127.0.0.1:PORT \
  --bridge-data-dir /ABSOLUTE/PROVIDER_BRIDGE_DATA_DIR \
  --thread thr_TARGET \
  --recovery-dir /ABSOLUTE/PRIVATE_RECOVERY_DIRECTORY
```

Apply verifies and syncs the original backup, recaptures the native outcome without input commands, and requires an identical projection. Core reauthorizes the root inside the transaction, checks the exact backup fingerprint, and requires a unique accepted-input lineage. It records a small idempotence receipt in the same transaction as the history/status repair. Notification/cache invalidation occurs only after commit.

`receipt.json` records the recovered turn/item identities, not credentials. If the ACK was lost, an identical apply returns `changed:false` while the recorded state is unchanged. It never replays a native command. A stale backup or an unknown outcome does not trigger an automatic refresh/rebase/replacement.

## Verify and preserve

Use `bb thread show` and `bb thread log` plus the real UI to verify the existing turn's recovered text and completion. Check that original events/tools/errors remain, the native process/session is unchanged, and no extra model input was admitted. Preserve the backup, native capture, plan and receipt; never delete a working store to repair presentation.

Local tests exercise a private Unix socket and real in-memory SQLite transactions, including stale scope/input refusal, duplicate apply, fsync failure and transactional rollback. Their injected Core helpers do not replace a matched-bundle/live UI acceptance check.
