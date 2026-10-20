import { prepareRootRecovery, applyRootRecovery } from './root-recovery.ts';

const usage = 'restore-native-root.mjs prepare|apply --bb-data-dir PATH --server-url http://127.0.0.1:PORT --bridge-data-dir PATH --thread THREAD_ID --recovery-dir PRIVATE_PATH';
if (import.meta.main) {
  try {
    const [operation, ...argv] = process.argv.slice(2);
    if (operation === '--help') console.log(usage);
    else {
      if (operation !== 'prepare' && operation !== 'apply') throw Error('BB_ROOT_RECOVERY_OPERATION_REQUIRED');
      const flags = new Map([['--bb-data-dir', 'dataDir'], ['--server-url', 'serverUrl'], ['--bridge-data-dir', 'bridgeDataDir'], ['--thread', 'threadId'], ['--recovery-dir', 'recoveryDir']]);
      const args: Record<string, string> = {};
      for (let i = 0; i < argv.length; i += 2) {
        const key = flags.get(argv[i]);
        if (!key || !argv[i + 1] || argv[i + 1].startsWith('--') || args[key]) throw Error('BB_ROOT_RECOVERY_ARGUMENTS_INVALID');
        args[key] = argv[i + 1];
      }
      if (Object.keys(args).length !== flags.size) throw Error('BB_ROOT_RECOVERY_ARGUMENTS_REQUIRED');
      const selected = args as unknown as Parameters<typeof prepareRootRecovery>[0];
      console.log(JSON.stringify(await (operation === 'prepare' ? prepareRootRecovery(selected) : applyRootRecovery(selected))));
    }
  } catch (error) {
    console.error(JSON.stringify({ status: 'blocked', error: error instanceof Error && /^BB_ROOT_RECOVERY_[A-Z0-9_]+$/.test(error.message)
      ? error.message : 'BB_ROOT_RECOVERY_REFUSED', retainedFiles: true, action: 'Keep the original backup and plan. No automatic retry, rebase, host restart or input submit.' }));
    process.exitCode = 1;
  }
}
