import Link from "next/link";
import { Suspense } from "react";
import { AuthForm } from "@/components/AuthForm";

export default function AuthPage() {
  return (
    <main className="shell auth-shell">
      <nav className="topbar auth-topbar">
        <Link className="brand" href="/">
          Chandra
        </Link>
      </nav>
      <Suspense
        fallback={
          <section className="auth-card">
            <h1>Preparing account setup.</h1>
          </section>
        }
      >
        <AuthForm />
      </Suspense>
    </main>
  );
}
