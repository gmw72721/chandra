import Link from "next/link";
import { AuthNav } from "@/components/AuthNav";
import { LandingActions } from "@/components/LandingActions";

export default function HomePage() {
  return (
    <main className="shell landing-shell">
      <nav className="topbar landing-topbar">
        <Link className="brand" href="/">
          Chandra
        </Link>
        <AuthNav showCreateAccount />
      </nav>

      <section className="workspace two-column landing-hero">
        <div className="intro-panel">
          <h1>Teacher-guided AI tutoring that keeps students doing the thinking.</h1>
          <p>
            Teachers set tutoring behavior, ground answers in your course material, and review
            where students get stuck—so you can focus on teaching, not troubleshooting.
          </p>
          <LandingActions />
        </div>
      </section>
    </main>
  );
}
