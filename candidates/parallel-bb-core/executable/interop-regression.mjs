import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const root = resolve(import.meta.dirname, "../../..");
const fixture = join(root, ".pi/fixtures/core-sol/executable");
assert.equal(process.env.HOME, join(fixture, "interop-home"));
const daemonDir = join(fixture, "node_modules/bb-app/host-daemon/dist");
const bundlePath = join(daemonDir, "daemon-bundle.mjs");
const source = readFileSync(bundlePath, "utf8");
assert.equal(createHash("sha256").update(source).digest("hex"), "a8898d4cb5e56f34c5edb9425ef63170aec7bfc6f8b4c0f3056ac016a1038c04");
assert.equal(source.split("function M0(e){").length, 2);
assert.equal(source.split('var SS=g(()=>{"use strict";VY();C0()})').length, 2);
const workspacePath = mkdtempSync(join(fixture, "interop-regression-"));
const testBundle = join(daemonDir, `native-runtime-regression-${process.pid}.mjs`);
writeFileSync(testBundle, source + "\nexport function nativeRuntimeFactoryForRegression(options){SS();return M0(options);}\n");
const support = await import(pathToFileURL(join(daemonDir, "native-registration-support.mjs")).href);
assert.equal(typeof support.nativeDispatchRegistration, "function");
assert.equal(typeof support.createNativeThreadRegistrar, "function");
const actual = await import(pathToFileURL(testBundle).href);
const runtime = actual.nativeRuntimeFactoryForRegression({
  workspacePath,
  onEvent() { throw new Error("Unexpected runtime event"); },
  async onToolCall() { throw new Error("Unexpected tool execution"); },
});
assert.deepEqual(runtime.listRunningProviders(), []);
await runtime.shutdown();
console.log(JSON.stringify({ node: process.version, realSupportImport: "PASS", actualBundledRuntimeFactory: "PASS", shutdown: "PASS", providersStarted: 0, mainBoots: 0, portsTouched: 0, workspacePath }));
