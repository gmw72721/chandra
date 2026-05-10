"use client";

import { Suspense } from "react";
import { StudentWorkspace } from "@/app/student/page";

export default function TeacherStudentViewPage() {
  return (
    <main className="student-workspace-page">
      <Suspense
        fallback={
          <section className="auth-state-panel">
            <h1>Preparing student view.</h1>
          </section>
        }
      >
        <StudentWorkspace />
      </Suspense>
    </main>
  );
}
