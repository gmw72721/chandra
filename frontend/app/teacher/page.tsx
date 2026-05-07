import { RequireAuth } from "@/components/RequireAuth";
import { TeacherClassManager } from "@/components/TeacherClassManager";

export default function TeacherPage() {
  return (
    <main className="teacher-page">
      <RequireAuth role="teacher">
        <TeacherClassManager />
      </RequireAuth>
    </main>
  );
}
