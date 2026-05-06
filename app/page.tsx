import Link from "next/link";
import { AuthNav } from "@/components/AuthNav";

export default function HomePage() {
  return (
    <main className="shell">
      <nav className="topbar">
        <Link className="brand" href="/">
          Chandra
        </Link>
        <AuthNav />
      </nav>

      <section className="workspace two-column">
        <div className="intro-panel">
          <h1>Teacher-guided AI tutoring that keeps students doing the thinking.</h1>
          <p>
            Chandra lets teachers set the tutoring behavior, ground answers in course material,
            and review where students are getting stuck.
          </p>
          <div className="button-row">
            <Link className="primary-button" href="/student">
              Open Student Chat
            </Link>
            <Link className="secondary-button" href="/teacher">
              Open Teacher Dashboard
            </Link>
            <Link className="secondary-button" href="/auth">
              Create Account
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
