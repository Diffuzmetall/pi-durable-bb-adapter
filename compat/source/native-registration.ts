import {createHash} from 'node:crypto';
import {z} from 'zod';
import {registerNativeHistoryRoutes} from './native-history-route.ts';
export function installHistoryAndRegistration(app,deps,core){
const {getThread,getEnvironment,getThreadPluginMetadata,threadPluginMetadata,appendStoredThreadEventsInTransaction,events,threadSearchSegments,eq,and,inArray,bumpThreadEventRewriteGeneration,createThread,getAuthenticatedDaemon,ApiError,sql}=core;
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


function findForeignNativeThreadRegistration(
  db: DbQueryConnection,
  input: { hostId: string; providerId: string; sessionId: string; conversationId: string },
): { threadId: string } | undefined {
  const metadata = sql`case when json_valid(${threadPluginMetadata.metadataJson}) then ${threadPluginMetadata.metadataJson} else '{}' end`;
  return db
    .select({ threadId: threadPluginMetadata.threadId })
    .from(threadPluginMetadata)
    .where(and(
      eq(threadPluginMetadata.pluginId, "bb.core.native-registration"),
      sql`json_extract(${metadata}, '$.kind') = 'native-existing'`,
      sql`json_extract(${metadata}, '$.providerId') = ${input.providerId}`,
      sql`json_extract(${metadata}, '$.sessionId') = ${input.sessionId}`,
      sql`json_extract(${metadata}, '$.conversationId') = ${input.conversationId}`,
      sql`json_extract(${metadata}, '$.hostId') <> ${input.hostId}`,
    ))
    .limit(1)
    .get();
}


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
      if (existing.originKind !== null || (existing.originPluginId !== null && existing.originPluginId !== NATIVE_REGISTRATION_PLUGIN_ID) ||
        binding.corrupt || !registrationMatches(binding.metadata, input, daemon.hostId)) {
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
        originPluginId: NATIVE_REGISTRATION_PLUGIN_ID,
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
        if (raced.originKind === null && (raced.originPluginId === null || raced.originPluginId === NATIVE_REGISTRATION_PLUGIN_ID) &&
          !binding.corrupt && registrationMatches(binding.metadata, input, daemon.hostId)) {
          return context.json({ threadId: id });
        }
        throw new ApiError(409, "registration_conflict", "Registration key is already bound");
      }
      throw error;
    }
  });


registerNativeHistoryRoutes(app,deps,core,getAuthenticatedDaemon);
}
