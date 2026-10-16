import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createConnection, migrate, createThread, createProject, createEnvironment, upsertHost, getThread, getThreadPluginMetadata, listEvents, findForeignNativeThreadRegistration } from "@bb/db";
import { expect, it } from "vitest";
import { NotificationHub } from "../../src/ws/hub.js";
import { createMachineAuthService } from "../../src/services/machine-auth.js";
import { registerInternalHostRoutes } from "../../src/internal/hosts.js";
import { verifyAuthenticatedDaemon, setAuthenticatedDaemon } from "../../src/internal/auth.js";
import { ApiError } from "../../src/errors.js";
import type { AppDeps } from "../../src/types.js";

it("registers durably through real daemon authentication without submitting a turn", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "bb-core-sol-fixture-"));
  const db = createConnection(join(dataDir, "private.sqlite"));
  migrate(db);
  const hub = new NotificationHub();
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const machineAuth = await createMachineAuthService({ db, dataDir, logger });
  await machineAuth.ensureReady();
  const deps = { db, hub, machineAuth } as AppDeps;
  const app = new Hono();
  app.onError((error, context) => context.json({ error: error.message }, error instanceof ApiError ? error.status : 500));
  app.use("/internal/*", async (context, next) => {
    try {
      const daemon = await verifyAuthenticatedDaemon(deps, context.req.header("authorization"));
      setAuthenticatedDaemon(context, daemon);
    } catch {
      return context.json({ error: "Unauthorized" }, 401);
    }
    return next();
  });
  const internal = new Hono();
  registerInternalHostRoutes(internal, deps);
  app.route("/internal", internal);
  function parent(hostId: string) {
    upsertHost(db, hub, { id: hostId, name: hostId });
    const { project } = createProject(db, hub, { name: hostId, source: { type: "local_path", hostId, path: dataDir } });
    const environment = createEnvironment(db, hub, { hostId, projectId: project.id, path: dataDir, providerOwnsPath: false, status: "ready" });
    return createThread(db, hub, { projectId: project.id, environmentId: environment.id, providerId: "pi-durable", title: hostId, status: "pending" });
  }
  const ownerParent = parent("synthetic-owner");
  const foreignParent = parent("synthetic-foreign");
  const ownerKey = await machineAuth.issueDaemonHostKey({ hostId: "synthetic-owner" });
  const foreignKey = await machineAuth.issueDaemonHostKey({ hostId: "synthetic-foreign" });
  const body = { requestId: "registration-1", providerId: "pi-durable", sessionId: "session-1", conversationId: "conversation-1", parentThreadId: ownerParent.id, title: "Existing child" };
  const register = (key: string, input = body) => app.request("/internal/hosts/threads/register-existing", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(input) });
  try {
    expect((await register("invalid")).status).toBe(401);
    const created = await register(ownerKey);
    expect(created.status).toBe(201);
    const result = await created.json() as { threadId: string };
    expect(getThread(db, result.threadId)).toMatchObject({ parentThreadId: ownerParent.id, providerId: "pi-durable", status: "pending" });
    expect(listEvents(db, { threadId: result.threadId })).toEqual([]);
    expect(getThreadPluginMetadata(db, result.threadId, "bb.core.native-registration").metadata).toMatchObject({ hostId: "synthetic-owner", sessionId: "session-1", conversationId: "conversation-1" });
    expect(findForeignNativeThreadRegistration(db, { hostId: "synthetic-owner", providerId: body.providerId, sessionId: body.sessionId, conversationId: body.conversationId })).toBeUndefined();
    expect(findForeignNativeThreadRegistration(db, { hostId: "synthetic-foreign", providerId: body.providerId, sessionId: body.sessionId, conversationId: body.conversationId })).toEqual({ threadId: result.threadId });
    expect(findForeignNativeThreadRegistration(db, { hostId: "synthetic-foreign", providerId: "another-provider", sessionId: body.sessionId, conversationId: body.conversationId })).toBeUndefined();
    expect(findForeignNativeThreadRegistration(db, { hostId: "synthetic-foreign", providerId: body.providerId, sessionId: "another-session", conversationId: body.conversationId })).toBeUndefined();
    const retry = await register(ownerKey);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(result);
    expect((await register(ownerKey, { ...body, conversationId: "mismatch" })).status).toBe(409);
    expect((await register(foreignKey)).status).toBe(404);
    expect((await register(foreignKey, { ...body, parentThreadId: foreignParent.id })).status).toBe(409);
    expect((await register(ownerKey, { ...body, initialPrompt: "forbidden" } as typeof body)).status).toBe(400);
    const reopened = createConnection(join(dataDir, "private.sqlite"));
    try {
      expect(getThread(reopened, result.threadId)?.parentThreadId).toBe(ownerParent.id);
      expect(listEvents(reopened, { threadId: result.threadId })).toEqual([]);
    } finally { reopened.$client.close(); }
  } finally { db.$client.close(); }
});
