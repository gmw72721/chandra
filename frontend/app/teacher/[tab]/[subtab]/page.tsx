import { notFound } from "next/navigation";
import { RequireAuth } from "@/components/RequireAuth";
import { TeacherClassManager } from "@/components/TeacherClassManager";

const teacherSubtabs: Record<string, Set<string>> = {
  conversations: new Set(["feedback", "follow-ups", "needs-review", "reviewed"]),
  knowledge: new Set(["access", "advanced", "class-instructions", "help-rules", "tutor-mode", "voice-detail"]),
  settings: new Set(["account", "appearance", "class-access", "general", "notifications", "privacy", "usage"]),
  sources: new Set(["source-settings", "sources"])
};

export default async function TeacherSubtabPage({
  params
}: {
  params: Promise<{ subtab: string; tab: string }>;
}) {
  const { subtab, tab } = await params;

  if (!teacherSubtabs[tab]?.has(subtab)) {
    notFound();
  }

  return (
    <main className="teacher-page">
      <RequireAuth role="teacher">
        <TeacherClassManager />
      </RequireAuth>
    </main>
  );
}
