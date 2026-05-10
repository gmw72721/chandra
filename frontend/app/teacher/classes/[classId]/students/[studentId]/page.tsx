import { RequireAuth } from "@/components/RequireAuth";
import { TeacherClassManager } from "@/components/TeacherClassManager";

export default async function TeacherStudentProfileRoute({
  params
}: {
  params: Promise<{ classId: string; studentId: string }>;
}) {
  const { classId, studentId } = await params;

  return (
    <main className="teacher-page">
      <RequireAuth role="teacher">
        <TeacherClassManager studentProfileRoute={{ classId, studentId }} />
      </RequireAuth>
    </main>
  );
}
