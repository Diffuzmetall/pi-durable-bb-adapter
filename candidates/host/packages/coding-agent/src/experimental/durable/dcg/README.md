# Trusted native DCG startup bridge

Canonical policy is the separate addon at `.pi/extensions/durable-dcg/`, not this package. See its README for ABI 1, public portable APIs, evaluator/diagnostic behavior and installation/update limits.

This directory's `index.ts` exports only `createHostDcgEnvironmentFactory`, `HostDcgEnvironmentFactoryOptions`, and `HostDcgEnvironmentFactory`. S2 must use its `env(target: {cwd?: string}, context: Context): Promise<ExecutionEnv>` and `cleanup(context): Promise<void>` as the host environment provider before Harness scheduling. No host wiring is changed in S1.

Host options: `addonPath`, `defaultCwd`, `binaryPath`, `timeoutMs`, `envSource`. Addon selection is captured before any await: explicit absolute addonPath, then startup PI_DURABLE_DCG_EXTENSION, then `getAgentDir()/durable-extensions/durable-dcg/index.ts`. There is no checkout scan or embedded policy fallback. Binary selection is captured at the same time: explicit absolute binaryPath, startup DCG_BIN, then `~/.local/bin/dcg`. Missing/throwing/incompatible addon or construction failures yield fixed per-invocation DCG_UNAVAILABLE and a filesystem-only Node environment with no executor delegation. Cleanup joins loading and every owned environment even after errors.

Installed Jiti uses the host's exact public Chord/Durable peer instances. This native environment contract is not ordinary Pi ExtensionAPI, which lacks the required final ExecutionEnv hook; it is not a registry reload adapter and cannot be installed solely via beforeTool/tool_call.

A source-checkout host example after S2 wiring selects `/home/ubuntu/Projects/pi-upstream/.pi/extensions/durable-dcg/index.ts` explicitly via PI_DURABLE_DCG_EXTENSION. Update-resistant installation requires an operator-authorized full addon copy outside the checkout/host package, normally under the default native durable-extensions directory, not normal extensions. No global copy or activation has occurred. Actual Durable 1.0.2 and a compatible host bridge are required; arbitrary future API compatibility or survival of user deletion is not promised.

The undeployed prototype `evaluator.ts`, `environment.ts`, and `diagnostics.ts` are **inactive relocation notes with export {}**, retained solely under the no-file-deletion constraint. They contain no implementation or compatibility aliases. Exact pre-relocation contents of all four modules and this README are preserved in `/tmp/pi-dcg-upstream-6ODRzI41/s1-addon/prototype-before/`.

Focused source verification from packages/coding-agent:

```sh
node --import ./src/experimental/source-resolver.ts --import ./test/fixtures/dcg/spawn-seam.ts --test test/durable-dcg.test.ts test/durable-dcg-addon.test.ts
```

External-copy hash/reload evidence models replacement of only owned fake host package files, not a real upstream/npm update or permanent API guarantee. Retained evidence: `/tmp/pi-dcg-upstream-6ODRzI41/s1-addon/`. No deployment, commits, staging, global activation, file deletion, build, full suite or root write-check is part of this bounded work.
