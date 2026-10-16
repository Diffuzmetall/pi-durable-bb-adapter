import type { AgentRuntimeOptions } from "@bb/agent-runtime";

type Registrar = NonNullable<AgentRuntimeOptions["onNativeThreadRegistration"]>;

export function createNativeThreadRegistrar(options: {
  serverUrl: string;
  hostKey: string;
  serverHeaders?: Record<string, string>;
  fetchFn?: typeof fetch;
}): Registrar {
  return async request => {
    const response = await (options.fetchFn ?? fetch)(new URL("/internal/hosts/threads/register-existing", options.serverUrl), {
      method: "POST",
      headers: { ...options.serverHeaders, authorization: `Bearer ${options.hostKey}`, "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    if (response.status !== 200 && response.status !== 201) {
      throw new Error(`Native thread registration refused (${response.status})`);
    }
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("threadId" in body) || typeof body.threadId !== "string" || !body.threadId) {
      throw new Error("Invalid native registration response");
    }
    return { threadId: body.threadId };
  };
}
