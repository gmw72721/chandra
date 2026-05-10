import { NextResponse } from "next/server";
import { writeAuditLog } from "@/lib/audit-log";
import { enforceConversationRetention } from "@/lib/conversation-retention";
import { pingBetterStackHeartbeat } from "@/lib/observability";
import { TutorKnowledgeHttpError } from "@/lib/tutor-knowledge-server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    authorizeConversationRetention(request);

    const result = await enforceConversationRetention();
    await writeAuditLog({
      eventType: "admin.conversation_retention.enforced",
      metadata: result,
      route: "/api/admin/retention/conversations"
    });
    pingBetterStackHeartbeat(
      process.env.BETTER_STACK_RETENTION_HEARTBEAT_URL,
      "admin.conversation_retention.enforced"
    );

    return NextResponse.json(result);
  } catch (caughtError) {
    if (caughtError instanceof TutorKnowledgeHttpError) {
      return NextResponse.json({ error: caughtError.message }, { status: caughtError.status });
    }

    const message = caughtError instanceof Error ? caughtError.message : "";

    if (message.includes("Firebase Admin is not configured")) {
      return NextResponse.json({ error: message }, { status: 500 });
    }

    return NextResponse.json({ error: "Conversation retention failed." }, { status: 500 });
  }
}

function authorizeConversationRetention(request: Request) {
  const configuredSecret =
    process.env.CONVERSATION_RETENTION_SECRET ||
    process.env.LEARNING_PROFILE_UPDATE_SECRET ||
    process.env.CRON_SECRET;

  if (!configuredSecret) {
    throw new TutorKnowledgeHttpError(
      "Conversation retention requires CONVERSATION_RETENTION_SECRET or LEARNING_PROFILE_UPDATE_SECRET.",
      503
    );
  }

  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";

  if (token !== configuredSecret) {
    throw new TutorKnowledgeHttpError("Conversation retention is not authorized.", 401);
  }
}
