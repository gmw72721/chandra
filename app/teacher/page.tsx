"use client";

import Link from "next/link";
import { AuthNav } from "@/components/AuthNav";
import { RequireAuth } from "@/components/RequireAuth";
import { TeacherClassManager } from "@/components/TeacherClassManager";

export default function TeacherPage() {
  return (
    <main className="shell">
      <nav className="topbar">
        <Link className="brand" href="/">
          Chandra
        </Link>
        <AuthNav />
      </nav>

      <RequireAuth role="teacher">
        <section className="dashboard-header">
          <div>
            <p className="eyebrow">Teacher dashboard</p>
            <h1>Classes</h1>
          </div>
        </section>

        <TeacherClassManager />
      </RequireAuth>
    </main>
  );
}
