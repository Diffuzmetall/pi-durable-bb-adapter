import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createConnection, migrate, createThread, createProject, createEnvironment, upsertHost, getThread, getThreadPluginMetadata, listEvents, listThreadsWithPendingInteractionState } from "@bb/db";
import { expect, it } from "vitest";
import { NotificationHub } from "../../src/ws/hub.js";
import { createMachineAuthService } from "../../src/services/machine-auth.js";
import { registerInternalHostRoutes } from "../../src/internal/hosts.js";
import { verifyAuthenticatedDaemon, setAuthenticatedDaemon } from "../../src/internal/auth.js";
import { ApiError } from "../../src/errors.js";
import type { AppDeps } from "../../src/types.js";
import { createNativeThreadRegistrar } from "../../../host-daemon/src/native-thread-registration.js";
import { createAgentRuntime } from "../../../../packages/agent-runtime/src/runtime.js";
import { fullRuntimeOptions } from "../../../../packages/agent-runtime/src/test/runtime-test-harness.js";

it("routes provider reverse RPC through daemon-owned auth into real Core SQLite without submission", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bb-core-daemon-"));
  const db = createConnection(join(dir, "fixture.sqlite"));
  migrate(db);
  const hub = new NotificationHub();
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const machineAuth = await createMachineAuthService({ db, dataDir: dir, logger });
  await machineAuth.ensureReady();
  const deps = { db, hub, machineAuth } as AppDeps;
  const app = new Hono();
  app.onError((error, context) => context.json({ error: error.message }, error instanceof ApiError ? error.status : 500));
  app.use("/internal/*", async (context, next) => {
    try { setAuthenticatedDaemon(context, await verifyAuthenticatedDaemon(deps, context.req.header("authorization"))); }
    catch { return context.json({ error: "Unauthorized" }, 401); }
    return next();
  });
  const internal = new Hono();
  registerInternalHostRoutes(internal, deps);
  app.route("/internal", internal);
  upsertHost(db, hub, { id: "fixture-host", name: "Fixture" });
  const { project } = createProject(db, hub, { name: "Fixture", source: { type: "local_path", hostId: "fixture-host", path: dir } });
  const environment = createEnvironment(db, hub, { hostId: "fixture-host", projectId: project.id, path: dir, providerOwnsPath: false, status: "ready" });
  const parent = createThread(db, hub, { projectId: project.id, environmentId: environment.id, providerId: "pi-durable", title: "Parent", status: "pending" });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.listening ? resolve() : server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback address");
  const hostKey = await machineAuth.issueDaemonHostKey({ hostId: "fixture-host" });
  const register = createNativeThreadRegistrar({ serverUrl: `http://127.0.0.1:${address.port}`, hostKey });
  const output = join(dir, "responses.json");
  const artifact = join(dir, "provider.mjs");
  const base = { requestId: "native-once", providerId: "pi-durable", sessionId: "durable-session", conversationId: "native-child", parentThreadId: parent.id, parentProviderThreadId: "fixture-parent-provider", title: "Native child" };
  const requests = [base, base, { ...base, parentProviderThreadId: "foreign-provider-session" }, { ...base, providerId: "foreign-provider" }, { ...base, initialPrompt: "forbidden" }];
  writeFileSync(artifact, `import {writeFileSync,renameSync} from 'node:fs';
const requests=${JSON.stringify(requests)}, responses=[];let next=0;
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');
function register(){send({id:'registration-'+next,method:'thread/registerExisting',params:requests[next]});}
export const experimental_providerBridge={experimental_apiVersion:1,handleLine(line){const x=JSON.parse(line);
if(x.method==='initialize')send({id:x.id,result:{protocolVersion:x.params.protocolVersion,capabilities:{grammarVersions:x.params.grammarVersions}}});
else if(x.method==='thread/start'){send({id:x.id,result:{providerThreadId:'fixture-parent-provider'}});setTimeout(register,100);}
else if(x.method)send({id:x.id,error:{code:-32601,message:'No execution allowed'}});
else {responses.push(x);next++;writeFileSync(${JSON.stringify(output + ".next")},JSON.stringify(responses));renameSync(${JSON.stringify(output + ".next")},${JSON.stringify(output)});if(next<requests.length)register();}
}};
`);
  let forwarded = 0;
  const events: unknown[] = [];
  const runtime = createAgentRuntime({ workspacePath: dir, bridgeBundleDir: join(process.cwd(), "test-native-worker"), onEvent: event => events.push(event), onToolCall: async () => { throw new Error("No tool submission allowed"); }, onNativeThreadRegistration: request => { forwarded++; return register(request); } });
  try {
    await runtime.startThread({ threadId: parent.id, environmentId: environment.id, projectId: project.id, providerId: "pi-durable", options: fullRuntimeOptions, bridgeLaunch: { pluginId: "fixture-provider", dataDir: dir, source: { kind: "artifact", digest: "fixture-native-registration", artifactPath: artifact }, capabilities: { providerInstallation: false, supportsServiceTier: false, permissionModes: ["full"], supportsThreadArchive: false, supportsThreadRename: false, fork: "none" }, providerOptions: {}, envPassthrough: [] } });
    let responses: Array<{ id: string; result?: { threadId: string }; error?: unknown }> = [];
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (existsSync(output)) responses = JSON.parse(readFileSync(output, "utf8"));
      if (responses.length === requests.length) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(responses).toHaveLength(5);
    expect(responses.map(response => response.id)).toEqual(requests.map((_, index) => `registration-${index}`));
    expect(responses[0].result?.threadId).toBeTruthy();
    expect(responses[1].result).toEqual(responses[0].result);
    for (const response of responses.slice(2)) expect(response.error).toBeTruthy();
    expect(forwarded).toBe(2);
    const id = responses[0].result!.threadId;
    expect(getThread(db, id)).toMatchObject({ parentThreadId: parent.id, providerId: "pi-durable", status: "pending" });
    expect(getThreadPluginMetadata(db, id, "bb.core.native-registration").metadata).toMatchObject({ hostId: "fixture-host", sessionId: base.sessionId, conversationId: base.conversationId });
    expect(listEvents(db, { threadId: id })).toEqual([]);
    expect(listThreadsWithPendingInteractionState(db, { includeHidden: true })).toHaveLength(2);
    expect(events.some(event => typeof event === "object" && event !== null && "type" in event && event.type === "turn/started")).toBe(false);
    expect(readFileSync(output, "utf8")).not.toContain(hostKey);
  } finally {
    await runtime.shutdown();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.$client.close();
  }
}, 20000);
