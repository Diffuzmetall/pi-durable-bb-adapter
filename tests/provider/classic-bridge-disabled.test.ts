import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

for (const mode of ["runtime", "catalog"] as const) {
	test(`${mode} startup does not initialize classic Pi extensions`, () => {
		const home = mkdtempSync(join(tmpdir(), "bb-classic-bridge-off-"));
		const cwd = join(home, "project"), agent = join(home, "agent"), directory = join(home, "session");
		const marker = join(home, "unexpected-extension-initialization");
		for (const path of [cwd, directory, join(agent, "extensions")]) mkdirSync(path, { recursive: true, mode: 0o700 });
		writeFileSync(join(agent, "extensions", "canary.ts"),
			`import{writeFileSync}from'node:fs';export default()=>{writeFileSync(${JSON.stringify(marker)},'executed');}`);
		const moduleUrl = (name: string) => new URL(`../../src/provider/runner/${name}.ts`, import.meta.url).href;
		const script = mode === "catalog"
			? `import{setupRunnerModels}from${JSON.stringify(moduleUrl("model-setup"))};await setupRunnerModels(${JSON.stringify(cwd)},{});`
			: `import{loadHarnessEnvironment}from${JSON.stringify(moduleUrl("runtime-loader"))};
import{ExecutionEnvs}from${JSON.stringify(moduleUrl("harness-setup"))};
import{runtimeContext}from${JSON.stringify(moduleUrl("runtime-types"))};
const envs=new ExecutionEnvs(${JSON.stringify(cwd)});
const loaded=await loadHarnessEnvironment({id:'bridge-off',cwd:${JSON.stringify(cwd)},directory:${JSON.stringify(directory)},database:${JSON.stringify(join(directory, "session.sqlite"))},created:false,release:async()=>{}},{},envs);
try{assert.equal(loaded.extensionRunner,undefined);const state=await(await loaded.harness.root(runtimeContext)).agent(runtimeContext);
assert.ok(!state.extensions.some(e=>e.name==='extension-tools'));assert.ok([...state.tools,...state.callable,...state.deferred].some(t=>t.name==='subagent'));}
finally{await loaded.cleanup?.();await loaded.harness.close(runtimeContext);await envs.cleanup(runtimeContext);}`;
		const result = spawnSync(process.execPath, ["--input-type=module", "-e",
			`import assert from'node:assert/strict';import{existsSync}from'node:fs';${script}
assert.equal(existsSync(${JSON.stringify(marker)}),false,'Classic Pi extensions must remain disabled');`], {
			encoding: "utf8", timeout: 45000,
			env: { ...process.env, HOME: home, PI_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent },
		});
		assert.equal(result.status, 0, result.stdout + "\n" + result.stderr);
	});
}
