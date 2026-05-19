"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { Suspense } from "react";
import { AuthForm } from "@/components/AuthForm";

export default function AuthPage() {
  const [isNavigating, setIsNavigating] = useState(false);
  const router = useRouter();

  const handleNavigation = (e: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    e.preventDefault();
    setIsNavigating(true);
    setTimeout(() => {
      router.push(href as any);
    }, 750);
  };

  const handleAuthSuccess = (destination: string) => {
    setIsNavigating(true);
    setTimeout(() => {
      router.push(destination as any);
    }, 750);
  };

  return (
    <main className="auth-shell">
      <nav className="auth-topbar" aria-label="Authentication navigation">
        <Link 
          className="landing-brand auth-brand" 
          href="/" 
          aria-label="Chandra home"
          onClick={(e) => handleNavigation(e, "/")}
        >
          <span>Chandra</span>
        </Link>
        <div className="nav-actions">
          <Link 
            href="/" 
            className="nav-button-home"
            onClick={(e) => handleNavigation(e, "/")}
          >
            Back to home
          </Link>
        </div>
      </nav>
      <div className="auth-layout">
        <section className="auth-story-panel" aria-label="Chandra introduction">
          <div className="hero-pill auth-pill">
            <SparkleIcon />
            <span>Teacher-guided AI for classroom learning</span>
          </div>
          <h1>Teacher-guided AI tutoring that keeps students doing the thinking.</h1>
          <p>
            Sign in to manage class materials, keep tutoring guardrails in place, and see where
            students need support.
          </p>
        </section>
        <Suspense
          fallback={
            <section className="auth-card">
              <h1>Preparing account setup.</h1>
            </section>
          }
        >
          <AuthForm onAuthSuccess={handleAuthSuccess} />
        </Suspense>
      </div>

      {isNavigating && (
        <div className="page-transition-veil">
          <div className="transition-panel panel-1" />
          <div className="transition-panel panel-2" />
          <div className="transition-panel panel-3" />
          <div className="veil-glow" />
          <div className="transition-content">
            <div className="transition-logo-wrapper">
              {"Chandra".split("").map((char, idx) => (
                <span
                  key={idx}
                  className="logo-letter"
                  style={{ animationDelay: `${0.22 + idx * 0.04}s` }}
                >
                  {char}
                </span>
              ))}
            </div>
            <div className="transition-progress-line">
              <div className="progress-bar-fill" />
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function CrescentIcon() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path
        d="M24.9 22.2C19 24.6 12.2 22 9.5 16.2 6.9 10.5 9.1 3.8 14.4.7 8 1.6 3.1 7.1 3.1 13.7c0 7.3 5.9 13.2 13.2 13.2 3.4 0 6.5-1.3 8.6-4.7Z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconSvg({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.9"
    >
      {children}
    </svg>
  );
}

function SparkleIcon() {
  return (
    <IconSvg>
      <path d="M12 3l1.5 5.2L19 10l-5.5 1.8L12 17l-1.5-5.2L5 10l5.5-1.8L12 3Z" />
      <path d="M5 15l.7 2.3L8 18l-2.3.7L5 21l-.7-2.3L2 18l2.3-.7L5 15Z" />
    </IconSvg>
  );
}
