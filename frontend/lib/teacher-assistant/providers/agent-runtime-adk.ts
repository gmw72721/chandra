import { createHash } from "node:crypto";
import { GoogleAuth, type AuthClient, type JWTInput } from "google-auth-library";
import { adminDb } from "../../firebase-admin.ts";
import type {
  AssistantEvent,
  AssistantTurnInput,
  TeacherAssistantAction,
  TeacherAssistantProvider
} from "../types.ts";

type AgentRuntimeConfig = {
  location: string;
  resource: string;
};

type AgentRuntimeProviderOptions = {
  fetchFn?: typeof fetch;
  getAccessToken?: () => Promise<string>;
};

const cloudPlatformScope = "https://www.googleapis.com/auth/cloud-platform";
const remoteSessionTtlMs = 4 * 60 * 60 * 1000;
const remoteSessions = new Map<string, RemoteAgentSessionRecord>();
let googleAuthClientPromise: Promise<AuthClient> | null = null;

type RemoteAgentSessionRecord = {
  actorUid: string;
  createdAt: number;
  id: string;
  key: string;
  resource: string;
  sessionId: string;
  updatedAt: number;
};

export function createAgentRuntimeAdkProvider(options: AgentRuntimeProviderOptions = {}): TeacherAssistantProvider {
  return {
    async *send(input: AssistantTurnInput): AsyncIterable<AssistantEvent> {
      const config = getAgentRuntimeConfig();

      if (!input.assistantContextId || !input.sanitizedContext) {
        throw new Error("Agent Runtime provider requires a Chandra-minted assistantContextId for each turn.");
      }

      const fetchFn = options.fetchFn ?? fetch;
      const accessToken = await (options.getAccessToken ?? getGoogleAccessToken)();
      const remoteSession = await getOrCreateRemoteAgentSession({
        accessToken,
        config,
        fetchFn,
        sessionId: input.sessionId,
        userId: input.actorUid
      });
      let yielded = false;

      for await (const runtimeEvent of streamRemoteAgentQuery({
        accessToken,
        config,
        fetchFn,
        input,
        remoteSessionId: remoteSession.id
      })) {
        for (const event of toAssistantEvents(runtimeEvent)) {
          yielded = true;
          yield event;
        }
      }

      if (!yielded) {
        yield {
          content: "Agent Runtime completed the turn without returning a teacher-assistant response.",
          type: "message"
        };
      }
    }
  };
}

export function getAgentRuntimeConfig(): AgentRuntimeConfig {
  const resource = process.env.GEMINI_AGENT_RUNTIME_RESOURCE?.trim();
  const location = process.env.GEMINI_AGENT_LOCATION?.trim() || locationFromResource(resource ?? "");

  if (!resource) {
    throw new Error(
      "TEACHER_ASSISTANT_PROVIDER=agent-runtime-adk requires GEMINI_AGENT_RUNTIME_RESOURCE=projects/.../locations/.../reasoningEngines/...."
    );
  }

  if (!/^projects\/[^/]+\/locations\/[^/]+\/reasoningEngines\/[^/]+$/.test(resource)) {
    throw new Error(
      "GEMINI_AGENT_RUNTIME_RESOURCE must look like projects/PROJECT_ID/locations/LOCATION/reasoningEngines/RESOURCE_ID."
    );
  }

  if (!location) {
    throw new Error("GEMINI_AGENT_LOCATION is required when it cannot be inferred from GEMINI_AGENT_RUNTIME_RESOURCE.");
  }

  return { location, resource };
}

export function buildAgentRuntimeUrl(config: AgentRuntimeConfig, method: "query" | "streamQuery") {
  const host = config.location === "global" ? "aiplatform.googleapis.com" : `${config.location}-aiplatform.googleapis.com`;
  const suffix = method === "streamQuery" ? ":streamQuery?alt=sse" : ":query";
  return `https://${host}/v1/${config.resource}${suffix}`;
}

export function buildCreateSessionBody(userId: string) {
  return {
    class_method: "async_create_session",
    input: {
      user_id: userId
    }
  };
}

export function buildStreamQueryBody(input: AssistantTurnInput, remoteSessionId: string) {
  return {
    class_method: "async_stream_query",
    input: {
      message: buildAgentMessage(input),
      session_id: remoteSessionId,
      user_id: input.actorUid
    }
  };
}

function buildAgentMessage(input: AssistantTurnInput) {
  const allowedTools = input.sanitizedContext?.allowedToolNames.join(", ") ?? "";
  return [
    `assistant_context_id: ${input.assistantContextId}`,
    `class_id: ${input.classId}`,
    `chandra_session_id: ${input.sessionId}`,
    `allowed_tool_names: ${allowedTools}`,
    `tool_policy: ${input.sanitizedContext?.toolPolicy?.reason ?? "default"}`,
    `max_tool_calls: ${input.sanitizedContext?.toolPolicy?.maxToolCalls ?? 2}`,
    "Recent chat history:",
    formatRecentChatHistory(input),
    "Teacher message:",
    input.message
  ].join("\n");
}

function formatRecentChatHistory(input: AssistantTurnInput) {
  const history = input.chatHistory?.slice(-8) ?? [];
  if (history.length === 0) {
    return "(none)";
  }

  return history
    .map((message) => {
      const role = message.role === "assistant" ? "Assistant" : "Teacher";
      return `${role}: ${message.content.replace(/\s+/g, " ").slice(0, 1_000)}`;
    })
    .join("\n");
}

async function createRemoteAgentSession(input: {
  accessToken: string;
  config: AgentRuntimeConfig;
  fetchFn: typeof fetch;
  userId: string;
}) {
  const response = await input.fetchFn(buildAgentRuntimeUrl(input.config, "query"), {
    body: JSON.stringify(buildCreateSessionBody(input.userId)),
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "Content-Type": "application/json"
    },
    method: "POST"
  });

  if (!response.ok) {
    throw new Error(`Agent Runtime session create failed with HTTP ${response.status}: ${await readErrorBody(response)}`);
  }

  const payload = (await response.json()) as { output?: { id?: unknown }; id?: unknown };
  const id = stringValue(payload.output?.id ?? payload.id);

  if (!id) {
    throw new Error("Agent Runtime did not return a session id from async_create_session.");
  }

  return { id };
}

async function getOrCreateRemoteAgentSession(input: {
  accessToken: string;
  config: AgentRuntimeConfig;
  fetchFn: typeof fetch;
  sessionId: string;
  userId: string;
}) {
  const key = remoteSessionKey({
    resource: input.config.resource,
    sessionId: input.sessionId,
    userId: input.userId
  });
  const cached = await readRemoteAgentSession(key);

  if (cached) {
    return { id: cached.id };
  }

  const created = await createRemoteAgentSession(input);
  const now = Date.now();
  const record: RemoteAgentSessionRecord = {
    actorUid: input.userId,
    createdAt: now,
    id: created.id,
    key,
    resource: input.config.resource,
    sessionId: input.sessionId,
    updatedAt: now
  };
  await writeRemoteAgentSession(record);

  return created;
}

async function readRemoteAgentSession(key: string) {
  const now = Date.now();
  const cached = remoteSessions.get(key);
  if (cached && cached.updatedAt + remoteSessionTtlMs > now) {
    cached.updatedAt = now;
    return cached;
  }

  if (!adminDb) {
    return null;
  }

  const snapshot = await adminDb.collection("teacherAssistantAgentRuntimeSessions").doc(key).get();
  if (!snapshot.exists) {
    return null;
  }

  const record = normalizeRemoteAgentSessionRecord(snapshot.data(), key);
  if (!record || record.updatedAt + remoteSessionTtlMs <= now) {
    await snapshot.ref.delete().catch(() => undefined);
    return null;
  }

  record.updatedAt = now;
  remoteSessions.set(key, record);
  await snapshot.ref.set({ updatedAt: now }, { merge: true }).catch(() => undefined);
  return record;
}

async function writeRemoteAgentSession(record: RemoteAgentSessionRecord) {
  remoteSessions.set(record.key, record);
  if (adminDb) {
    await adminDb.collection("teacherAssistantAgentRuntimeSessions").doc(record.key).set(record);
  }
}

function normalizeRemoteAgentSessionRecord(value: unknown, key: string): RemoteAgentSessionRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const source = value as Record<string, unknown>;
  if (
    source.key !== key ||
    typeof source.actorUid !== "string" ||
    typeof source.createdAt !== "number" ||
    typeof source.id !== "string" ||
    typeof source.resource !== "string" ||
    typeof source.sessionId !== "string" ||
    typeof source.updatedAt !== "number"
  ) {
    return null;
  }

  return {
    actorUid: source.actorUid,
    createdAt: source.createdAt,
    id: source.id,
    key,
    resource: source.resource,
    sessionId: source.sessionId,
    updatedAt: source.updatedAt
  };
}

function remoteSessionKey(input: { resource: string; sessionId: string; userId: string }) {
  return createHash("sha256")
    .update(`${input.resource}\n${input.userId}\n${input.sessionId}`)
    .digest("hex");
}

async function* streamRemoteAgentQuery(input: {
  accessToken: string;
  config: AgentRuntimeConfig;
  fetchFn: typeof fetch;
  input: AssistantTurnInput;
  remoteSessionId: string;
}) {
  const response = await input.fetchFn(buildAgentRuntimeUrl(input.config, "streamQuery"), {
    body: JSON.stringify(buildStreamQueryBody(input.input, input.remoteSessionId)),
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "Content-Type": "application/json"
    },
    method: "POST"
  });

  if (!response.ok) {
    throw new Error(`Agent Runtime stream query failed with HTTP ${response.status}: ${await readErrorBody(response)}`);
  }

  yield* parseAgentRuntimeResponse(response);
}

async function* parseAgentRuntimeResponse(response: Response): AsyncIterable<unknown> {
  const contentType = response.headers.get("content-type") ?? "";

  if (response.body && (contentType.includes("text/event-stream") || contentType.includes("application/json"))) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const parsed = parseAgentRuntimeLine(line);
        if (parsed !== undefined) {
          yield parsed;
        }
      }
    }

    buffer += decoder.decode();
    for (const line of buffer.split(/\r?\n/)) {
      const parsed = parseAgentRuntimeLine(line);
      if (parsed !== undefined) {
        yield parsed;
      }
    }
    return;
  }

  const payload = await response.json();
  if (Array.isArray(payload)) {
    for (const item of payload) {
      yield item;
    }
    return;
  }

  yield payload;
}

function parseAgentRuntimeLine(line: string) {
  const trimmed = line.trim();

  if (!trimmed || trimmed.startsWith(":")) {
    return undefined;
  }

  const data = trimmed.startsWith("data:") ? trimmed.slice("data:".length).trim() : trimmed;
  if (!data || data === "[DONE]") {
    return undefined;
  }

  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

function toAssistantEvents(runtimeEvent: unknown): AssistantEvent[] {
  const events: AssistantEvent[] = [];
  const payload = unwrapRuntimeEvent(runtimeEvent);
  const parts = Array.isArray(payload?.parts)
    ? payload.parts
    : Array.isArray(payload?.content?.parts)
      ? payload.content.parts
      : [];

  for (const part of parts) {
    const text = stringValue(part?.text);
    if (text) {
      events.push({ content: text, type: "message" });
    }

    const toolResponse = part?.function_response?.response ?? part?.functionResponse?.response;
    const action = readToolAction(toolResponse);
    if (action) {
      events.push({ action, type: "action" });
    }
  }

  const output = unwrapRuntimeEvent(runtimeEvent)?.output;
  if (typeof output === "string" && output.trim()) {
    events.push({ content: output.trim(), type: "message" });
  }

  return events;
}

function unwrapRuntimeEvent(event: unknown): Record<string, any> | null {
  if (!event || typeof event !== "object") {
    return null;
  }

  const record = event as Record<string, any>;
  if (record.output && typeof record.output === "object" && !Array.isArray(record.output)) {
    return record.output;
  }

  return record;
}

function readToolAction(value: unknown): TeacherAssistantAction | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const action = (value as { action?: unknown }).action;
  if (!action || typeof action !== "object") {
    return null;
  }

  const candidate = action as TeacherAssistantAction;
  if (candidate.kind === "navigate" || candidate.kind === "confirmation" || candidate.kind === "toolResult") {
    return candidate;
  }

  return null;
}

async function readErrorBody(response: Response) {
  return (await response.text()).slice(0, 800);
}

async function getGoogleAccessToken() {
  const client = await getGoogleAuthClient();
  const accessTokenResponse = await client.getAccessToken();
  const token = typeof accessTokenResponse === "string" ? accessTokenResponse : accessTokenResponse?.token;

  if (!token) {
    throw new Error(
      "Google Application Default Credentials did not return an access token. Configure ADC or service account credentials for Agent Runtime."
    );
  }

  return token;
}

async function getGoogleAuthClient() {
  if (!googleAuthClientPromise) {
    const credentials = getGoogleCredentials();
    const auth = new GoogleAuth({
      ...(credentials ? { credentials } : {}),
      scopes: [cloudPlatformScope]
    });
    googleAuthClientPromise = auth.getClient();
  }

  return googleAuthClientPromise;
}

function getGoogleCredentials(): JWTInput | undefined {
  const serviceAccountJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON ?? process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

  if (serviceAccountJson) {
    const serviceAccount = JSON.parse(serviceAccountJson) as JWTInput & {
      clientEmail?: string;
      privateKey?: string;
      projectId?: string;
    };

    return {
      client_email: serviceAccount.client_email ?? serviceAccount.clientEmail,
      private_key: (serviceAccount.private_key ?? serviceAccount.privateKey)?.replace(/\\n/g, "\n"),
      project_id: serviceAccount.project_id ?? serviceAccount.projectId
    };
  }

  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL ?? process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY ?? process.env.FIREBASE_PRIVATE_KEY;
  const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.FIREBASE_PROJECT_ID;

  if (!clientEmail || !privateKey || !projectId) {
    return undefined;
  }

  return {
    client_email: clientEmail,
    private_key: privateKey.replace(/\\n/g, "\n"),
    project_id: projectId
  };
}

function locationFromResource(resource: string) {
  return resource.match(/^projects\/[^/]+\/locations\/(?<location>[^/]+)\/reasoningEngines\/[^/]+$/)?.groups
    ?.location ?? "";
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
