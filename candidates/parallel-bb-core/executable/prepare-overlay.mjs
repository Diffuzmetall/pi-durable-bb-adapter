import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../../..");
const fixture = join(root, ".pi/fixtures/core-sol");
const scratch = join(fixture, "native-port");
const source = join(root, "candidates/parallel-bb-core/source");
const app = join(fixture, "executable/node_modules/bb-app");
const evidence = join(root, "evidence/BB1/core-port-sol/executable");
const serverPath = join(app, "server/dist/start-server.js");
const daemonPath = join(app, "host-daemon/dist/daemon-bundle.mjs");
const sha = value => createHash("sha256").update(value).digest("hex");
const read = path => readFileSync(path, "utf8");
const requireHash = (path, expected) => { if (sha(readFileSync(path)) !== expected) throw new Error(`Input fingerprint drift: ${path}`); };
requireHash(serverPath, "d5c282329b50697f20ecba123dfe90ed4f9cda6161f9424847b1c0f82a601550");
requireHash(daemonPath, "acd96560885bf5410af4a53e8cba774f31cac1849ed9d94a3fccc5d56742c163");
const installedVersion = JSON.parse(read(join(app, "package.json"))).version;
if (installedVersion !== "0.46.0") throw new Error("Expected BB0.46.0");
const sourcePins = JSON.parse(read(join(root, "evidence/BB1/core-port-sol/daemon-forwarder/manifest.json")));
for (const row of sourcePins.files) requireHash(join(source, row.path), row.sourceSHA256);
const between = (text, start, end) => {
  const a = text.indexOf(start), b = text.indexOf(end, a + start.length);
  if (a < 0 || b < 0 || text.indexOf(start, a + 1) >= 0) throw new Error(`Nonunique source boundary: ${start}`);
  return text.slice(a, b);
};
const replaceOnce = (text, from, to) => {
  if (text.split(from).length !== 2) throw new Error(`Nonunique bundle anchor: ${from}`);
  return text.replace(from, to);
};
const hosts = read(join(source, "apps/server/src/internal/hosts.ts"));
const threads = read(join(source, "packages/db/src/data/threads.ts"));
const runtime = read(join(source, "packages/agent-runtime/src/runtime.ts"));
const registrar = read(join(source, "apps/host-daemon/src/native-thread-registration.ts"));
const helpers = between(hosts, "const NATIVE_REGISTRATION_PLUGIN_ID", "function assertLoopbackRequest");
const query = between(threads, "export function findForeignNativeThreadRegistration", "export const THREAD_SEARCH_LIMIT_PER_GROUP_DEFAULT").replace("export function", "function");
const route = between(hosts, '  app.post("/hosts/threads/register-existing"', "  post(\n");
const dispatch = between(runtime, '    if (parsedLine.kind === "request" && parsedLine.parsedMethod === "thread/registerExisting")', '    if (parsedLine.kind === "request") {');
const generated = join(scratch, "apps/server/src/native-executable-support");
mkdirSync(generated, { recursive: true });
mkdirSync(evidence, { recursive: true });
writeFileSync(join(generated, "server.ts"), `import {createHash} from "node:crypto";\nimport {z} from "zod";\nexport function nativeInstallRegisterExisting(app,deps,core){\nconst {createThread,getEnvironment,getThread,getThreadPluginMetadata,getAuthenticatedDaemon,ApiError,threadPluginMetadata,sql,and,eq}=core;\n${helpers}\n${query}\n${route}\n}\n`);
writeFileSync(join(generated, "daemon.ts"), `import {z} from "zod";\nimport {sendJsonRpcResult} from "../../../../packages/provider-bridge-protocol/src/bridge-kit/index.ts";\n${registrar.replace(/^import type .*;\n/m, "")}\nexport function nativeDispatchRegistration(parsedLine,proc,resolveBbThreadIdForProcess,options,sendJsonRpcError){\n${dispatch}\n}\n`);
const esbuild = join(scratch, "node_modules/.pnpm/@esbuild+linux-x64@0.25.12/node_modules/@esbuild/linux-x64/bin/esbuild");
const outputs = [join(app, "server/dist/native-registration-support.mjs"), join(app, "host-daemon/dist/native-registration-support.mjs")];
for (const [index, name] of ["server", "daemon"].entries()) {
  execFileSync(esbuild, [join(generated, `${name}.ts`), "--bundle", "--platform=node", "--format=esm", "--conditions=source", '--banner:js=import {createRequire as __nativeCreateRequire} from "node:module"; const require=__nativeCreateRequire(import.meta.url);', `--outfile=${outputs[index]}`], { cwd: scratch, stdio: "inherit" });
}
let server = read(serverPath);
const createStart = server.indexOf("function createThread(db, notifier, input2) {");
const createEnd = server.indexOf("function getThread(db, id3)", createStart);
if (createStart < 0 || createEnd < 0) throw new Error("Missing actual Core repository function");
let create = server.slice(createStart, createEnd);
if (!create.includes("insertThreadPluginMetadata(tx,")) throw new Error("Base repository lacks atomic plugin metadata insertion");
create = replaceOnce(create, "const id3 = createThreadId();", "const id3 = input2.id ?? createThreadId();");
server = server.slice(0, createStart) + create + server.slice(createEnd);
server = replaceOnce(server, "function registerInternalHostRoutes(app, deps) {", "function registerInternalHostRoutes(app, deps) {\n  nativeInstallRegisterExisting(app,deps,{createThread,getEnvironment,getThread,getThreadPluginMetadata,getAuthenticatedDaemon,ApiError,threadPluginMetadata,sql,and,eq});");
server = 'import {nativeInstallRegisterExisting} from "./native-registration-support.mjs";\n' + server;
let daemon = read(daemonPath);
daemon = replaceOnce(daemon, 'if(_.kind==="request"){xY(', 'if(_.kind==="request"&&_.parsedMethod==="thread/registerExisting"){nativeDispatchRegistration(_,R,lt,e,Pn);return}if(_.kind==="request"){xY(');
daemon = replaceOnce(daemon, "return{async openSession", "return{registerExistingThread:createNativeThreadRegistrar(e),async openSession");
daemon = replaceOnce(daemon, "onInteractiveRequest:this.options.onInteractiveRequest,onStderr:this.options.onStderr,onProviderRecovery:", "onInteractiveRequest:this.options.onInteractiveRequest,onNativeThreadRegistration:this.options.onNativeThreadRegistration,onStderr:this.options.onStderr,onProviderRecovery:");
daemon = replaceOnce(daemon, "onToolCall:async(f,T)=>", "onNativeThreadRegistration:f=>x.registerExistingThread(f),onToolCall:async(f,T)=>");
daemon = 'import {nativeDispatchRegistration,createNativeThreadRegistrar} from "./native-registration-support.mjs";\n' + daemon;
for (const path of [serverPath, daemonPath]) {
  if (existsSync(path + ".original")) throw new Error("Prepared artifact already exists; no silent overwrite/retry");
  copyFileSync(path, path + ".original");
}
writeFileSync(serverPath, server);
writeFileSync(daemonPath, daemon);
const node = "/home/ubuntu/.nvm/versions/node/v24.19.0/bin/node";
for (const path of [serverPath, daemonPath, ...outputs]) execFileSync(node, ["--check", path], { stdio: "inherit" });
const artifacts = [serverPath, daemonPath, ...outputs].map(path => ({ path, sha256: sha(readFileSync(path)) }));
writeFileSync(join(evidence, "output-manifest.json"), JSON.stringify({ version: installedVersion, overlaySourcePin: sourcePins.corePin, baseBundleProvenance: { installedPackage: "bb-app@0.46.0", commit: "UNKNOWN", serverSHA256: "d5c282329b50697f20ecba123dfe90ed4f9cda6161f9424847b1c0f82a601550", daemonSHA256: "acd96560885bf5410af4a53e8cba774f31cac1849ed9d94a3fccc5d56742c163" }, sdkVersion: sourcePins.sdkVersion, preparationOnly: true, serverBooted: false, daemonBooted: false, productionUntouched: true, installedNativeDriverVersion: JSON.parse(read(join(fixture, "executable/node_modules/better-sqlite3/package.json"))).version, artifacts, sourceFiles: sourcePins.files }, null, 2) + "\n");
console.log(JSON.stringify(artifacts, null, 2));
