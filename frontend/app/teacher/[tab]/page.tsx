import { notFound } from "next/navigation";
import { RequireAuth } from "@/components/RequireAuth";
import { TeacherClassManager } from "@/components/TeacherClassManager";

const teacherTabs = new Set(["overview", "roster", "problems", "sources", "settings", "knowledge", "conversations"]);

export default async function TeacherTabPage({
  params
}: {
  params: Promise<{ tab: string }>;
}) {
  const { tab } = await params;

  if (!teacherTabs.has(tab)) {
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
