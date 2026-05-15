import type { TeacherAssistantProvider } from "./types.ts";
import { createAgentRuntimeAdkProvider } from "./providers/agent-runtime-adk.ts";
import { createLocalFallbackProvider } from "./providers/local-fallback.ts";

export function createTeacherAssistantProvider(): TeacherAssistantProvider {
  if (process.env.TEACHER_ASSISTANT_PROVIDER === "agent-runtime-adk") {
    return createAgentRuntimeAdkProvider();
  }

  return createLocalFallbackProvider();
}
