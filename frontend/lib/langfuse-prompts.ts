import { LangfuseClient } from "@langfuse/client";

export const langfuseProductionLabel = "production";

type PromptVariables = Record<string, string>;
export type LangfuseTracePrompt = { name: string; version: number; isFallback: boolean };

let langfuseClient: LangfuseClient | null | undefined;

export function hasLangfusePromptConfig() {
  return Boolean(
    process.env.LANGFUSE_PUBLIC_KEY &&
      process.env.LANGFUSE_SECRET_KEY &&
      process.env.LANGFUSE_HOST
  );
}

function getLangfuseClient() {
  if (!hasLangfusePromptConfig()) {
    return null;
  }

  if (langfuseClient !== undefined) {
    return langfuseClient;
  }

  langfuseClient = new LangfuseClient({
    baseUrl: process.env.LANGFUSE_HOST,
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY
  });
  return langfuseClient;
}

export async function compileLangfuseTextPrompt({
  fallback,
  name,
  variables = {}
}: {
  fallback: string;
  name: string;
  variables?: PromptVariables;
}) {
  return (await compileLangfuseTextPromptWithMetadata({ fallback, name, variables })).text;
}

export async function compileLangfuseTextPromptWithMetadata({
  fallback,
  name,
  variables = {}
}: {
  fallback: string;
  name: string;
  variables?: PromptVariables;
}): Promise<{ text: string; prompt?: LangfuseTracePrompt }> {
  const client = getLangfuseClient();

  if (!client) {
    return { text: fallback };
  }

  try {
    const prompt = await client.prompt.get(name, {
      fallback,
      label: langfuseProductionLabel,
      type: "text"
    });
    return {
      prompt: prompt.isFallback
        ? undefined
        : {
            isFallback: prompt.isFallback,
            name: prompt.name,
            version: prompt.version
          },
      text: prompt.compile(variables)
    };
  } catch {
    return { text: fallback };
  }
}
