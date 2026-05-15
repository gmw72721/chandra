import type { AssistantEvent, AssistantTurnInput, TeacherAssistantProvider } from "../types.ts";

export function createAgentRuntimeAdkProvider(): TeacherAssistantProvider {
  return {
    async *send(input: AssistantTurnInput): AsyncIterable<AssistantEvent> {
      const resource = process.env.GEMINI_AGENT_RUNTIME_RESOURCE?.trim();

      if (!resource) {
        yield {
          content:
            "Gemini Enterprise Agent Runtime is selected, but GEMINI_AGENT_RUNTIME_RESOURCE is not configured. Falling back is available by setting TEACHER_ASSISTANT_PROVIDER=local-fallback.",
          type: "message"
        };
        return;
      }

      yield {
        content:
          "Gemini Enterprise Agent Runtime is configured for this deployment. The Chandra gateway is ready for ADK tool callbacks; live Agent Runtime streaming requires Google Cloud credentials in the runtime environment.",
        type: "message"
      };

      if (input.message.trim()) {
        yield {
          content: `Received: ${input.message.trim()}`,
          type: "message"
        };
      }
    }
  };
}
