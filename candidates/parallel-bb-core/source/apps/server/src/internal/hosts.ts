import { createHash } from "node:crypto";
import { z } from "zod";
import {
  createThread,
  getEnvironment,
  getThread,
  getThreadPluginMetadata,
  findForeignNativeThreadRegistration,
  upsertHost,
} from "@bb/db";
import { isLoopbackAddress } from "@bb/config/loopback";
import {
  hostDaemonEnrollKeyRequestSchema,
  hostDaemonEnrollRequestSchema,
  typedRoutes,
  type HostDaemonInternalSchema,
} from "@bb/host-daemon-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import {
  getGateAuthKind,
  getGateMachineId,
  getTrustedRemoteAddress,
  type GateAuthHeaderReader,
} from "../request-context.js";
import { issueHostEnrollKey } from "../services/hosts/host-enrollment.js";
import { requireBearerToken, getAuthenticatedDaemon } from "./auth.js";

const NATIVE_REGISTRATION_PLUGIN_ID = "bb.core.native-registration";
const nativeThreadRegistrationSchema = z.object({
  requestId: z.string().min(1).max(200),
  providerId: z.string().min(1).max(200),
  sessionId: z.string().min(1).max(512),
  conversationId: z.string().min(1).max(512),
  parentThreadId: z.string().min(1).max(200),
  title: z.string().max(500).optional(),
}).strict();

function nativeRegistrationThreadId(hostId: string, requestId: string): string {
  const digest = createHash("sha256").update(hostId).update("\\0").update(requestId).digest("hex");
  return `thr_${digest.slice(0, 32)}`;
}

function registrationMatches(metadata: Record<string, unknown>, input: z.infer<typeof nativeThreadRegistrationSchema>, hostId: string): boolean {
  return metadata.kind === "native-existing" &&
    metadata.hostId === hostId &&
    metadata.requestId === input.requestId &&
    metadata.providerId === input.providerId &&
    metadata.sessionId === input.sessionId &&
    metadata.conversationId === input.conversationId &&
    metadata.parentThreadId === input.parentThreadId &&
    metadata.title === (input.title ?? null);
}

function assertLoopbackRequest(remoteAddress: string | undefined): void {
  if (remoteAddress && isLoopbackAddress(remoteAddress)) {
    return;
  }
  throw new ApiError(
    400,
    "unsupported_host",
    "This enrollment route is available only from the server machine",
  );
}

export function resolveReportedConnectMachineId(
  context: GateAuthHeaderReader,
): string | undefined {
  if (getGateAuthKind(context) !== "machine") return undefined;
  const gateMachineId = getGateMachineId(context);
  if (gateMachineId === null) {
    throw new ApiError(
      403,
      "connect_machine_id_mismatch",
      "Connect machine identity does not match the authenticated credential",
    );
  }
  return gateMachineId;
}

export function registerInternalHostRoutes(app: Hono, deps: AppDeps): void {
  const { post } = typedRoutes<HostDaemonInternalSchema>(app, {
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });

  app.post("/hosts/threads/register-existing", async (context) => {
    const daemon = getAuthenticatedDaemon(context);
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      throw new ApiError(400, "invalid_request", "Invalid JSON body");
    }
    const parsed = nativeThreadRegistrationSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(400, "invalid_request", "Invalid registration request");
    }
    const input = parsed.data;
    const parent = getThread(deps.db, input.parentThreadId);
    const parentEnvironment = parent?.environmentId
      ? getEnvironment(deps.db, parent.environmentId)
      : null;
    if (
      !parent || parent.archivedAt !== null || parent.deletedAt !== null ||
      !parentEnvironment || parentEnvironment.hostId !== daemon.hostId
    ) {
      throw new ApiError(404, "thread_not_found", "Parent thread not found");
    }

    const foreignRegistration = findForeignNativeThreadRegistration(deps.db, {
      hostId: daemon.hostId,
      providerId: input.providerId,
      sessionId: input.sessionId,
      conversationId: input.conversationId,
    });
    if (foreignRegistration) {
      throw new ApiError(409, "registration_conflict", "Session is already registered to another host");
    }

    const id = nativeRegistrationThreadId(daemon.hostId, input.requestId);
    const existing = getThread(deps.db, id);
    if (existing) {
      const binding = getThreadPluginMetadata(
        deps.db,
        id,
        NATIVE_REGISTRATION_PLUGIN_ID,
      );
      if (binding.corrupt || !registrationMatches(binding.metadata, input, daemon.hostId)) {
        throw new ApiError(409, "registration_conflict", "Registration key is already bound");
      }
      return context.json({ threadId: id });
    }

    try {
      const thread = createThread(deps.db, deps.hub, {
        id,
        projectId: parent.projectId,
        environmentId: parent.environmentId,
        providerId: input.providerId,
        title: input.title ?? null,
        sectionId: parent.sectionId,
        parentThreadId: parent.id,
        status: "pending",
        pluginMetadata: {
          pluginId: NATIVE_REGISTRATION_PLUGIN_ID,
          metadata: {
            kind: "native-existing",
            hostId: daemon.hostId,
            requestId: input.requestId,
            providerId: input.providerId,
            sessionId: input.sessionId,
            conversationId: input.conversationId,
            parentThreadId: parent.id,
            title: input.title ?? null,
          },
        },
      });
      return context.json({ threadId: thread.id }, 201);
    } catch (error) {
      const raced = getThread(deps.db, id);
      if (raced) {
        const binding = getThreadPluginMetadata(
          deps.db,
          id,
          NATIVE_REGISTRATION_PLUGIN_ID,
        );
        if (!binding.corrupt && registrationMatches(binding.metadata, input, daemon.hostId)) {
          return context.json({ threadId: id });
        }
        throw new ApiError(409, "registration_conflict", "Registration key is already bound");
      }
      throw error;
    }
  });

  post(
    "/hosts/enroll-key",
    hostDaemonEnrollKeyRequestSchema,
    async (context, payload) => {
      if (getGateAuthKind(context) === "machine") {
        throw new ApiError(
          403,
          "machine_host_management_forbidden",
          "Machine credentials cannot mint host enrollment keys",
        );
      }
      assertLoopbackRequest(getTrustedRemoteAddress(context));
      const issued = await issueHostEnrollKey(deps, {
        enrollSource: "loopback",
        ...(payload.hostId ? { hostId: payload.hostId } : {}),
      });

      return context.json(
        {
          enrollKey: issued.enrollKey.key,
          expiresAt: issued.enrollKey.expiresAt,
          hostId: issued.hostId,
        },
        201,
      );
    },
  );

  post(
    "/hosts/enroll",
    hostDaemonEnrollRequestSchema,
    async (context, payload) => {
      const connectMachineId = resolveReportedConnectMachineId(context);
      const token = requireBearerToken(context.req.header("authorization"));
      const enrollment = await deps.machineAuth.enrollHost({
        hostId: payload.hostId,
        token,
      });

      if (!enrollment) {
        throw new ApiError(401, "unauthorized", "Unauthorized");
      }
      upsertHost(deps.db, deps.hub, {
        ...(connectMachineId !== undefined ? { connectMachineId } : {}),
        id: enrollment.metadata.hostId,
        name: payload.hostName,
      });

      return context.json(
        {
          hostId: enrollment.metadata.hostId,
          hostKey: enrollment.hostKey,
        },
        201,
      );
    },
  );
}
