"use client";

import Link from "next/link";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/AuthProvider";
import { signOutCurrentUser } from "@/lib/auth";

type Subject = "biology" | "math" | "chemistry";

interface ProblemData {
  question: string;
  options?: string[];
  expression?: string;
}

interface SubjectData {
  title: string;
  problem: ProblemData;
  withoutChandra: string;
  withChandra: {
    hint: string;
    action: string;
    explain: string;
    hint_action: string;
    hint_explain: string;
    action_explain: string;
    hint_action_explain: string;
  };
}

const subjectsData: Record<Subject, SubjectData> = {
  biology: {
    title: "Biology",
    problem: {
      question: "Which molecule provides the energy used to power the Calvin cycle?",
      options: ["A. O2", "B. ATP", "C. CO2", "D. Glucose"],
    },
    withoutChandra: "The answer is B. ATP. The Calvin cycle uses ATP as an energy source while building sugars.",
    withChandra: {
      hint: "Look for the choice that cells use as a quick, usable energy carrier.",
      action: "First separate the choices by role: gases, finished sugar, and energy carrier.",
      explain: "The Calvin cycle is a building process, so it needs an input that can provide usable energy during the reactions. Match each option to what it does in photosynthesis.",
      hint_action: "Look for the quick energy carrier. Start by sorting out the gases, then compare what remains.",
      hint_explain: "Focus on the option that transfers usable energy inside cells. A good test is whether the molecule is used to power reactions or whether it is something being produced or exchanged.",
      action_explain: "Sort the options by job first. One is a product, two are gases, and one is used by cells to drive reactions. That role should point you toward the best choice.",
      hint_action_explain: "Look for the quick energy carrier, then sort the choices by job. The Calvin cycle builds sugar, so ask which option helps power that building process rather than being a gas or the final sugar.",
    },
  },
  math: {
    title: "Math",
    problem: {
      question: "Solve for x:",
      expression: "4x - 6 = 18",
    },
    withoutChandra: "Add 6 to both sides to get 4x = 24. Then divide by 4, so x = 6.",
    withChandra: {
      hint: "Think about which operation you should undo first to start isolating x.",
      action: "Focus on the part outside the x-term first. What would cancel the \"minus 6\"?",
      explain: "Solving means keeping both sides balanced while undoing operations around x in reverse order.",
      hint_action: "To isolate x, undo the outside operation first. Look at the \"minus 6\" and decide what operation cancels it.",
      hint_explain: "Work backward from the expression around x. Since x is being changed in more than one way, undo the last change first while doing the same thing to both sides.",
      action_explain: "The first move should remove the constant term from the left side. Whatever you do to the left, you must also do to the right to keep the equation balanced.",
      hint_action_explain: "Start by isolating the x-term. Identify the operation that cancels the constant, apply it to both sides, then look at what operation is still attached to x.",
    },
  },
  chemistry: {
    title: "Chemistry",
    problem: {
      question: "Which particle has a negative charge?",
      options: ["A. Proton", "B. Neutron", "C. Electron", "D. Nucleus"],
    },
    withoutChandra: "The answer is C. Electron. Electrons have a negative charge, protons have a positive charge, and neutrons are neutral.",
    withChandra: {
      hint: "Think about the particle found outside the nucleus of an atom.",
      action: "Eliminate any option that is neutral, positive, or names a whole region instead of one particle.",
      explain: "Atomic particles are often identified by charge and location. Use those two clues to compare each option before choosing.",
      hint_action: "Look for the particle outside the nucleus. Then remove choices that are neutral, positive, or not a single particle.",
      hint_explain: "Use location as your clue: the negatively charged particle is associated with the space around the nucleus, while the nucleus contains different particles.",
      action_explain: "Sort the choices by charge first, then by whether the option names a particle or a region. That should leave the option that matches \"negative charge.\"",
      hint_action_explain: "Use both clues together: outside the nucleus and negative charge. Remove the neutral and positive particles, then remove the option that names a region instead of a particle.",
    },
  },
};

export default function LandingPage() {
  const [activeSubject, setActiveSubject] = useState<Subject>("biology");
  const [isChangingSubject, setIsChangingSubject] = useState(false);
  const [hintActive, setHintActive] = useState<boolean>(true);
  const [actionActive, setActionActive] = useState<boolean>(false);
  const [explainActive, setExplainActive] = useState<boolean>(false);
  const [isNavigating, setIsNavigating] = useState(false);
  const [isNavCompact, setIsNavCompact] = useState(false);
  const router = useRouter();

  const handleNavigation = (e: React.MouseEvent<HTMLAnchorElement | HTMLButtonElement>, href: string) => {
    e.preventDefault();
    setIsNavigating(true);
    setTimeout(() => {
      router.push(href as any);
    }, 750);
  };

  useEffect(() => {
    const updateNavDensity = () => {
      setIsNavCompact(window.scrollY > 32);
    };

    updateNavDensity();
    window.addEventListener("scroll", updateNavDensity, { passive: true });

    return () => {
      window.removeEventListener("scroll", updateNavDensity);
    };
  }, []);

  // Scroll reveal Intersection Observer setup
  useEffect(() => {
    const observerOptions = {
      threshold: 0.08,
      rootMargin: "0px 0px -80px 0px"
    };

    const scrollObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("revealed");
          scrollObserver.unobserve(entry.target);
        }
      });
    }, observerOptions);

    const revealTargets = document.querySelectorAll(".reveal-element");
    revealTargets.forEach((target) => scrollObserver.observe(target));

    return () => {
      revealTargets.forEach((target) => scrollObserver.unobserve(target));
    };
  }, []);

  const handleSubjectChange = (subj: Subject) => {
    if (subj === activeSubject || isChangingSubject) return;
    setIsChangingSubject(true);
    // Smooth transition fade-out/fade-in (180ms duration matches snappy product transitions)
    setTimeout(() => {
      setActiveSubject(subj);
      setIsChangingSubject(false);
    }, 180);
  };

  const currentSubjectData = subjectsData[activeSubject];

  const getChandraResponse = () => {
    const { hint, action, explain, hint_action, hint_explain, action_explain, hint_action_explain } =
      currentSubjectData.withChandra;

    if (hintActive && actionActive && explainActive) return hint_action_explain;
    if (hintActive && actionActive) return hint_action;
    if (hintActive && explainActive) return hint_explain;
    if (actionActive && explainActive) return action_explain;
    if (hintActive) return hint;
    if (actionActive) return action;
    if (explainActive) return explain;

    return "Toggle one or more guidance modes below to activate Chandra's tutoring response.";
  };

  const handleScrollToSection = (e: React.MouseEvent<HTMLAnchorElement>, id: string) => {
    e.preventDefault();
    const element = document.getElementById(id);
    if (element) {
      element.scrollIntoView({ behavior: "smooth" });
    }
  };

  return (
    <main className="chandra-home">
      {/* Scope Style Overrides */}
      <style jsx global>{`
        .chandra-home {
          --heading-font: "Libre Baskerville", Georgia, serif;
          --body-font: "Lexend", system-ui, sans-serif;
          
          /* Official Vibrant Teal Brand Palette */
          --color-teal-brand: #075b60;
          --color-teal-brand-hover: #0b7c83;
          --color-teal-glow: rgba(7, 91, 96, 0.14);
          
          /* Deep Backgrounds & Canvas tones */
          --color-deep-forest: #031416;
          --color-soft-forest: #072629;
          --color-light-cream: #fafaf6;
          --color-pure-white: #ffffff;
          --color-dark-ink: #111616;
          --color-sand-line: #e3ded5;
          --color-muted-teal: #586b6c;
          
          /* Core Easing Formulas from Paul Bakaus' Motion Skill */
          --ease-out-quart: cubic-bezier(0.25, 1, 0.5, 1);    /* Smooth & natural */
          --ease-out-quint: cubic-bezier(0.22, 1, 0.36, 1);   /* Snappy feedback */
          --ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);     /* Confident & decisive entrance */
          
          font-family: var(--body-font);
          background-color: var(--color-light-cream);
          color: var(--color-dark-ink);
          overflow-x: hidden;
          position: relative;
          
          /* Scholastic Notebook Backdrop Blueprint Grid */
          background-image: 
            linear-gradient(to right, rgba(227, 222, 213, 0.16) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(227, 222, 213, 0.16) 1px, transparent 1px);
          background-size: 80px 80px;
        }

        /* Nav Bar - Translucent Spruce Backdrop */
        .landing-nav {
          display: flex;
          justify-content: space-between;
          align-items: center;
          min-height: 84px;
          padding: 0 clamp(2rem, 5vw, 6rem);
          background: rgba(3, 20, 22, 0.95);
          backdrop-filter: blur(12px);
          border-bottom: 1px solid rgba(227, 222, 213, 0.05);
          box-sizing: border-box;
          left: 0;
          position: fixed;
          right: 0;
          top: 0;
          width: 100%;
          z-index: 100;
          transition:
            min-height 0.32s var(--ease-out-quint),
            background-color 0.32s var(--ease-out-quint),
            border-color 0.32s var(--ease-out-quint),
            box-shadow 0.32s var(--ease-out-quint);
        }

        .landing-nav--compact {
          min-height: 64px;
          background: rgba(3, 20, 22, 0.985);
          border-bottom-color: rgba(227, 222, 213, 0.11);
          box-shadow: 0 14px 30px rgba(0, 0, 0, 0.16);
        }

        .landing-brand {
          font-family: var(--heading-font);
          font-size: 1.75rem;
          font-weight: 400;
          color: var(--color-light-cream);
          text-decoration: none;
          letter-spacing: -0.01em;
          transition: opacity 0.3s ease;
        }

        .landing-brand:hover {
          opacity: 0.88;
        }

        .landing-nav-links {
          display: flex;
          gap: clamp(1.4rem, 2.6vw, 2.7rem);
          align-items: center;
        }

        .landing-nav-links a {
          color: #9ab3b5;
          text-decoration: none;
          font-size: 0.95rem;
          font-weight: 500;
          transition: all 0.25s var(--ease-out-quart);
          position: relative;
        }

        .landing-nav-links a::after {
          content: "";
          position: absolute;
          width: 100%;
          transform: scaleX(0);
          height: 2px;
          bottom: -6px;
          left: 0;
          background-color: var(--color-teal-brand);
          transform-origin: bottom right;
          transition: transform 0.25s var(--ease-out-quart);
        }

        .landing-nav-links a:hover {
          color: var(--color-light-cream);
        }

        .landing-nav-links a:hover::after {
          transform: scaleX(1);
          transform-origin: bottom left;
        }

        /* Spacious Drenched Hero Fold with cinematic Radial Glows */
        .landing-hero-grid {
          background-color: var(--color-deep-forest);
          color: var(--color-light-cream);
          padding: clamp(6.5rem, 11vw, 12.5rem) clamp(2rem, 5vw, 6rem) 15.5rem;
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
          margin-top: 84px;
          position: relative;
          background-image: 
            radial-gradient(circle at 15% 25%, rgba(7, 91, 96, 0.08) 0%, transparent 45%),
            radial-gradient(circle at 85% 75%, rgba(7, 38, 41, 0.45) 0%, transparent 55%);
        }

        .hero-copy {
          max-width: 960px;
          margin-top: -2.75rem;
          z-index: 2;
          display: flex;
          flex-direction: column;
          align-items: center;
        }

        /* Staggered Hero Elements Load Choreography (500-800ms duration, expo curve) */
        .hero-pill-animate {
          opacity: 0;
          transform: translateY(22px);
          animation: fadeInUpExpo 0.75s var(--ease-out-expo) forwards;
        }

        .hero-title-animate {
          opacity: 0;
          transform: translateY(26px);
          animation: fadeInUpExpo 0.8s var(--ease-out-expo) 100ms forwards;
        }

        .hero-desc-animate {
          opacity: 0;
          transform: translateY(26px);
          animation: fadeInUpExpo 0.8s var(--ease-out-expo) 200ms forwards;
        }

        .hero-actions-animate {
          opacity: 0;
          transform: translateY(26px);
          animation: fadeInUpExpo 0.85s var(--ease-out-expo) 300ms forwards;
        }

        .hero-trust-animate {
          opacity: 0;
          transform: translateY(22px);
          animation: fadeInUpExpo 0.85s var(--ease-out-expo) 400ms forwards;
        }

        @keyframes fadeInUpExpo {
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .hero-pill {
          display: inline-flex;
          align-items: center;
          gap: 0.6rem;
          background: var(--color-teal-glow);
          border: 1px solid rgba(7, 91, 96, 0.35);
          color: #a4e6ea;
          padding: 0.45rem 1.25rem;
          border-radius: 99px;
          font-size: 0.78rem;
          font-weight: 600;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          margin-bottom: 2.2rem;
          box-shadow: 0 4px 15px rgba(0,0,0,0.15);
        }

        .hero-pill svg {
          width: 14px;
          height: 14px;
          color: var(--color-teal-brand);
        }

        .hero-copy h1 {
          font-family: var(--heading-font);
          font-size: clamp(2.65rem, 4.8vw, 4.25rem);
          line-height: 1.14;
          font-weight: 400;
          margin: 0 0 1.8rem;
          letter-spacing: -0.02em;
          max-width: 20ch;
        }

        .hero-copy p {
          font-size: 1.2rem;
          line-height: 1.72;
          color: #a7bebf;
          max-width: 58ch;
          margin: 0 0 3.2rem;
        }

        .hero-actions {
          display: flex;
          align-items: center;
          gap: 1.5rem;
          margin-bottom: 4.5rem;
        }

        .hero-actions .landing-primary-button {
          align-items: center;
          background: var(--color-teal-brand);
          color: #ffffff;
          display: inline-flex;
          justify-content: center;
          line-height: 1.15;
          padding: 1.15rem 2.6rem;
          border-radius: 8px;
          font-weight: 600;
          font-size: 1.02rem;
          text-decoration: none;
          box-shadow: 0 15px 30px rgba(7, 91, 96, 0.22);
          transition: all 0.35s var(--ease-out-quint);
        }

        .hero-actions .landing-primary-button:hover {
          transform: translateY(-3px);
          background-color: var(--color-teal-brand-hover);
          box-shadow: 0 20px 35px rgba(7, 91, 96, 0.32);
        }

        .hero-actions .landing-primary-button:active {
          transform: translateY(-1px) scale(0.97);
        }

        .landing-secondary-button {
          align-items: center;
          border: 1px solid rgba(227, 222, 213, 0.25);
          color: var(--color-light-cream);
          display: inline-flex;
          justify-content: center;
          line-height: 1.15;
          padding: 1.15rem 2.6rem;
          border-radius: 8px;
          font-weight: 600;
          font-size: 1.02rem;
          text-decoration: none;
          transition: all 0.35s var(--ease-out-quint);
        }

        .landing-secondary-button:hover {
          background-color: rgba(250, 250, 247, 0.08);
          border-color: rgba(250, 250, 247, 0.6);
          transform: translateY(-2px);
        }

        .landing-secondary-button:active {
          transform: translateY(-1px) scale(0.97);
        }

        .trust-row {
          display: flex;
          gap: 4rem;
          border-top: 1px solid rgba(227, 222, 213, 0.08);
          padding-top: 2.4rem;
          width: 100%;
          justify-content: center;
        }

        .trust-row span {
          display: flex;
          align-items: center;
          gap: 0.6rem;
          font-size: 0.92rem;
          font-weight: 500;
          color: #8da2a3;
        }

        .trust-row span svg {
          color: var(--color-teal-brand);
        }

        /* ─── Premium Scroll Reveal Animation System ─── */
        .reveal-element {
          opacity: 0;
          transform: translateY(32px) scale(0.985);
          transition: 
            opacity 1.1s var(--ease-out-expo),
            transform 1.1s var(--ease-out-expo);
          will-change: transform, opacity;
        }

        .reveal-element.revealed {
          opacity: 1;
          transform: translateY(0) scale(1);
        }

        /* Staggered Delay classes */
        .delay-1 { transition-delay: 80ms !important; }
        .delay-2 { transition-delay: 160ms !important; }
        .delay-3 { transition-delay: 240ms !important; }
        .delay-4 { transition-delay: 320ms !important; }

        /* Large Floating Sandbox Container overlapping Hero */
        .hero-product-container {
          width: 100%;
          max-width: 1240px;
          margin: -10rem auto 0;
          padding: 0 2rem;
          position: relative;
          z-index: 10;
        }

        .comparison-card {
          background: var(--color-pure-white);
          border: 1px solid var(--color-sand-line);
          border-radius: 16px;
          padding: 2.8rem;
          box-shadow: 0 35px 80px -20px rgba(3, 20, 22, 0.12);
          color: var(--color-dark-ink);
        }

        .comparison-card h2 {
          font-family: var(--heading-font);
          font-size: 1.95rem;
          text-align: center;
          margin: 0 0 2.2rem;
          color: var(--color-deep-forest);
          letter-spacing: -0.01em;
          font-weight: 400;
        }

        .comparison-card h2 span:first-child {
          color: #b33924;
          font-style: italic;
          font-weight: 400;
        }

        .comparison-card h2 span:last-child {
          color: var(--color-teal-brand);
          font-weight: 700;
        }

        /* Tab Switcher - Slidable pill backing */
        .comparison-subject-tabs {
          display: flex;
          justify-content: center;
          gap: 0.75rem;
          background: #efebdf;
          padding: 0.45rem;
          border-radius: 99px;
          max-width: 400px;
          margin: 0 auto 2.8rem;
          border: 1px solid rgba(227, 222, 213, 0.5);
          position: relative;
        }

        .comparison-subject-active-pill {
          position: absolute;
          top: 4px;
          left: 4px;
          bottom: 4px;
          width: calc(33.333% - 5.33px);
          background: var(--color-pure-white);
          border-radius: 99px;
          box-shadow: 0 4px 12px rgba(3, 20, 22, 0.08);
          transition: transform 0.35s var(--ease-out-quint);
          z-index: 1;
        }

        .comparison-subject-button {
          background: transparent;
          border: none;
          padding: 0.7rem 2.2rem;
          font-weight: 600;
          font-size: 0.92rem;
          color: #5d6768;
          border-radius: 99px;
          cursor: pointer;
          transition: color 0.3s var(--ease-out-quint);
          flex: 1;
          position: relative;
          z-index: 2;
        }

        .comparison-subject-button[aria-selected="true"] {
          color: var(--color-deep-forest);
        }

        .comparison-grid {
          display: grid;
          grid-template-columns: 1fr auto 1fr;
          gap: 1.8rem;
          align-items: stretch;
        }

        /* Sandbox Fading Transition Panel classes (Product: 180ms crossfade) */
        .comparison-panel-fade {
          opacity: 1;
          transform: translateY(0);
          transition: 
            opacity 0.18s var(--ease-out-quint), 
            transform 0.18s var(--ease-out-quint);
        }

        .comparison-panel-fade.changing {
          opacity: 0;
          transform: translateY(6px);
        }

        .comparison-panel {
          border-radius: 12px;
          padding: 2.2rem;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          min-height: 560px;
        }

        .comparison-panel.warning {
          background: #fffefb;
          border: 1px solid #f6dfdc;
        }

        .comparison-panel.success {
          background: #fafcfa;
          border: 1px solid #daebd8;
        }

        .comparison-panel-head {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 1.6rem;
        }

        .comparison-panel-head h3 {
          font-family: var(--heading-font);
          font-size: 1.3rem;
          margin: 0;
          color: var(--color-deep-forest);
          font-weight: 500;
        }

        .comparison-panel-head span {
          font-size: 0.72rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          padding: 0.3rem 0.8rem;
          border-radius: 4px;
        }

        .comparison-panel.warning .comparison-panel-head span {
          background: rgba(179, 57, 36, 0.08);
          color: #b33924;
        }

        .comparison-panel.success .comparison-panel-head span {
          background: rgba(7, 91, 96, 0.08);
          color: var(--color-teal-brand);
        }

        .comparison-dialogue {
          display: flex;
          gap: 1.1rem;
          margin-bottom: 1.4rem;
        }

        .comparison-avatar {
          width: 34px;
          height: 34px;
          border-radius: 99px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 700;
          font-size: 0.82rem;
          flex-shrink: 0;
        }

        .comparison-panel.warning .comparison-avatar {
          background: #f7ebea;
          color: #b33924;
        }

        .comparison-panel.success .comparison-avatar {
          background: #e3ede8;
          color: var(--color-teal-brand);
        }

        .comparison-meta {
          font-size: 0.76rem;
          font-weight: 700;
          color: #727d7e;
          margin-bottom: 0.2rem;
          text-transform: uppercase;
          letter-spacing: 0.03em;
        }

        .comparison-question,
        .comparison-response p {
          font-size: 0.9rem;
          line-height: 1.58;
          margin: 0;
          color: #242c2c;
        }

        .comparison-problem {
          background: var(--color-pure-white);
          border: 1px solid var(--color-sand-line);
          border-radius: 8px;
          padding: 1.4rem;
          margin-bottom: 1.4rem;
          font-size: 0.88rem;
        }

        .comparison-problem p {
          font-weight: 700;
          color: #727d7e;
          margin: 0 0 0.6rem;
          font-size: 0.75rem;
          text-transform: uppercase;
        }

        .comparison-problem span,
        .comparison-problem li {
          font-size: 0.86rem;
          line-height: 1.48;
          color: var(--color-dark-ink);
        }

        .comparison-response-row {
          background: var(--color-pure-white);
          border: 1px solid var(--color-sand-line);
          border-radius: 8px;
          padding: 1.4rem;
          flex-grow: 1;
          margin-bottom: 1.6rem;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.005);
          overflow: hidden;
        }

        .comparison-panel.success .comparison-response-row {
          border-color: #b7cbcc;
          background: #fbfdfd;
          box-shadow: 0 4px 20px rgba(7, 91, 96, 0.02);
        }

        /* Guided Chat Reveal Transition (Quint easing, Decisive slide reveal) */
        .comparison-response-text {
          animation: slideDownFade 0.4s var(--ease-out-quint) forwards;
          transform-origin: top;
          will-change: transform, opacity;
        }

        @keyframes slideDownFade {
          from {
            opacity: 0;
            transform: translateY(-8px) scaleY(0.98);
          }
          to {
            opacity: 1;
            transform: translateY(0) scaleY(1);
          }
        }

        .comparison-guidance-controls {
          display: flex;
          gap: 0.5rem;
          margin-bottom: 1.4rem;
          background: #ecf0f1;
          padding: 0.35rem;
          border-radius: 8px;
        }

        .comparison-guidance-button {
          flex: 1;
          background: transparent;
          border: none;
          padding: 0.7rem;
          font-size: 0.82rem;
          font-weight: 600;
          border-radius: 6px;
          cursor: pointer;
          transition: all 0.2s var(--ease-out-quint);
          color: #4a5253;
        }

        .comparison-guidance-button:hover {
          transform: translateY(-1.5px);
          color: var(--color-teal-brand);
        }

        .comparison-guidance-button:active {
          transform: translateY(0.5px) scale(0.96);
        }

        .comparison-guidance-button[aria-pressed="true"] {
          background: var(--color-pure-white);
          color: var(--color-teal-brand);
          box-shadow: 0 3px 10px rgba(0,0,0,0.03);
        }

        .comparison-strip {
          display: flex;
          align-items: center;
          gap: 0.6rem;
          font-size: 0.82rem;
          font-weight: 600;
          padding-top: 1.1rem;
          border-top: 1px dashed var(--color-sand-line);
        }

        .comparison-panel.warning .comparison-strip {
          color: #b33924;
        }

        .comparison-panel.success .comparison-strip {
          color: var(--color-teal-brand);
        }

        .comparison-vs {
          align-self: center;
          font-weight: 800;
          color: #727d7e;
          font-size: 0.92rem;
          background: #f3efe6;
          width: 38px;
          height: 38px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 99px;
          border: 1px solid var(--color-sand-line);
          z-index: 10;
          box-shadow: 0 4px 12px rgba(0,0,0,0.03);
        }

        /* Asymmetrical Features Section */
        .features-section {
          padding: 11rem clamp(2rem, 5vw, 6rem) 9rem;
          max-width: 1400px;
          margin: 0 auto;
        }

        .asymmetric-features-grid {
          display: grid;
          grid-template-columns: 0.85fr 1.15fr;
          gap: 8rem;
          align-items: start;
        }

        .features-narrative {
          position: sticky;
          top: 140px;
        }

        .features-narrative span {
          font-size: 0.82rem;
          font-weight: 700;
          color: var(--color-teal-brand);
          text-transform: uppercase;
          letter-spacing: 0.12em;
          display: block;
          margin-bottom: 1.3rem;
        }

        .features-narrative h2 {
          font-family: var(--heading-font);
          font-size: clamp(2.3rem, 4.2vw, 3.5rem);
          line-height: 1.22;
          color: var(--color-deep-forest);
          font-weight: 400;
          margin: 0 0 1.8rem;
          letter-spacing: -0.01em;
        }

        .features-narrative p {
          font-size: 1.1rem;
          line-height: 1.7;
          color: #495354;
          margin-bottom: 2.4rem;
        }

        .features-quote {
          border-left: 2px solid var(--color-teal-brand);
          padding-left: 1.8rem;
          margin: 3.8rem 0 0;
        }

        .features-quote p {
          font-family: var(--heading-font);
          font-size: 1.38rem;
          font-style: italic;
          color: var(--color-deep-forest);
          line-height: 1.52;
          margin-bottom: 0.6rem;
          font-weight: 400;
        }

        .features-quote cite {
          font-size: 0.76rem;
          font-weight: 600;
          text-transform: uppercase;
          color: #727d7e;
          font-style: normal;
          letter-spacing: 0.06em;
        }

        .features-cards-stack {
          display: flex;
          flex-direction: column;
          gap: 2.4rem;
        }

        .asymmetric-card {
          background: var(--color-pure-white);
          border: 1px solid var(--color-sand-line);
          border-radius: 14px;
          padding: 3rem;
          transition: all 0.4s var(--ease-out-quint);
          display: flex;
          gap: 2.2rem;
          box-shadow: 0 4px 25px rgba(3, 20, 22, 0.005);
        }

        .asymmetric-card:hover {
          transform: translateY(-6px) scale(1.01);
          box-shadow: 0 25px 50px rgba(3, 20, 22, 0.06);
          border-color: rgba(7, 91, 96, 0.22);
        }

        .asymmetric-card:nth-child(2) {
          margin-left: 2.8rem;
        }

        .card-icon-wrapper {
          width: 60px;
          height: 60px;
          border-radius: 12px;
          background: #edf3f5;
          color: var(--color-teal-brand);
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          transition: all 0.35s var(--ease-out-quint);
        }

        .asymmetric-card:hover .card-icon-wrapper {
          background: var(--color-teal-brand);
          color: var(--color-light-cream);
          transform: rotate(5deg) scale(1.05);
        }

        .asymmetric-card h3 {
          font-family: var(--heading-font);
          font-size: 1.48rem;
          font-weight: 500;
          margin: 0 0 0.8rem;
          color: var(--color-deep-forest);
        }

        .asymmetric-card p {
          font-size: 0.98rem;
          line-height: 1.64;
          color: #495354;
          margin: 0;
        }

        /* Timeline Step Section */
        .how-it-works-section {
          background: #efebe2;
          padding: 9.5rem clamp(2rem, 5vw, 6rem);
          border-top: 1px solid var(--color-sand-line);
          border-bottom: 1px solid var(--color-sand-line);
          position: relative;
        }

        .how-it-works-section .section-header {
          text-align: center;
          max-width: 750px;
          margin: 0 auto 6rem;
        }

        .how-it-works-section .section-header span {
          font-size: 0.82rem;
          font-weight: 700;
          color: var(--color-teal-brand);
          text-transform: uppercase;
          letter-spacing: 0.12em;
        }

        .how-it-works-section .section-header h2 {
          font-family: var(--heading-font);
          font-size: clamp(2.2rem, 4vw, 3.2rem);
          color: var(--color-deep-forest);
          font-weight: 400;
          margin: 0.8rem 0 0;
          letter-spacing: -0.01em;
        }

        .staggered-timeline {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 2.4rem;
          max-width: 1300px;
          margin: 0 auto;
          position: relative;
        }

        .timeline-card {
          background: var(--color-pure-white);
          border: 1px solid var(--color-sand-line);
          border-radius: 12px;
          padding: 2.6rem 2.2rem;
          position: relative;
          transition: all 0.4s var(--ease-out-quint);
          box-shadow: 0 4px 15px rgba(0,0,0,0.01);
        }

        .timeline-card:hover {
          transform: translateY(-6px) scale(1.015);
          box-shadow: 0 25px 45px rgba(3, 20, 22, 0.05);
          border-color: rgba(7, 91, 96, 0.2);
        }

        .timeline-number {
          font-family: var(--heading-font);
          font-size: 3.6rem;
          line-height: 1;
          color: rgba(7, 91, 96, 0.18);
          position: absolute;
          top: 1.5rem;
          right: 2rem;
          font-weight: 700;
        }

        .timeline-card h3 {
          font-family: var(--heading-font);
          font-size: 1.35rem;
          font-weight: 500;
          margin: 2rem 0 0.8rem;
          color: var(--color-deep-forest);
          line-height: 1.25;
        }

        /* Classroom Split Columns */
        .audience-section {
          padding: 9.5rem clamp(2rem, 5vw, 6rem);
          max-width: 1300px;
          margin: 0 auto;
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 4.8rem;
        }

        .audience-box {
          background: var(--color-pure-white);
          border: 1px solid var(--color-sand-line);
          border-radius: 16px;
          padding: 4.8rem;
          box-shadow: 0 4px 30px rgba(0, 0, 0, 0.005);
          transition: all 0.4s var(--ease-out-quint);
        }

        .audience-box:hover {
          transform: translateY(-4px);
          box-shadow: 0 20px 45px rgba(3, 20, 22, 0.04);
        }

        .audience-box h2 {
          font-family: var(--heading-font);
          font-size: 2.25rem;
          color: var(--color-deep-forest);
          margin: 0 0 2.5rem;
          font-weight: 400;
          display: flex;
          align-items: center;
          gap: 1.2rem;
        }

        .audience-box h2 svg {
          color: var(--color-teal-brand);
          width: 32px;
          height: 32px;
          transition: transform 0.35s var(--ease-out-quint);
        }

        .audience-box:hover h2 svg {
          transform: scale(1.1) rotate(-3deg);
        }

        .audience-box ul {
          list-style: none;
          padding: 0;
          margin: 0;
          display: flex;
          flex-direction: column;
          gap: 1.5rem;
        }

        .audience-box li {
          display: flex;
          align-items: flex-start;
          gap: 1.2rem;
          font-size: 1.05rem;
          line-height: 1.52;
          color: #3b4242;
        }

        .audience-box li svg {
          margin-top: 0.22rem;
          color: var(--color-teal-brand);
          flex-shrink: 0;
          width: 18px;
          height: 18px;
        }

        /* Call To Action Band */
        .cta-band {
          background: var(--color-deep-forest);
          color: var(--color-light-cream);
          padding: 7rem clamp(2rem, 5vw, 6rem);
          border-top: 1px solid var(--color-sand-line);
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 5rem;
          position: relative;
          overflow: hidden;
          background-image: radial-gradient(circle at 10% 90%, rgba(7, 91, 96, 0.12) 0%, transparent 60%);
        }

        .cta-band h2 {
          font-family: var(--heading-font);
          font-size: clamp(2rem, 4vw, 3.1rem);
          line-height: 1.22;
          font-weight: 400;
          margin: 0;
          max-width: 22ch;
          z-index: 1;
          letter-spacing: -0.01em;
        }

        .cta-actions {
          display: flex;
          gap: 1.5rem;
          z-index: 1;
          flex-shrink: 0;
        }

        .cta-actions .landing-primary-button {
          background: var(--color-teal-brand);
          color: #ffffff;
          padding: 1.15rem 2.6rem;
          border-radius: 8px;
          font-weight: 600;
          font-size: 1.02rem;
          text-decoration: none;
          box-shadow: 0 15px 30px rgba(7, 91, 96, 0.2);
          transition: all 0.35s var(--ease-out-quint);
        }

        .cta-actions .landing-primary-button:hover {
          transform: translateY(-3px);
          background-color: var(--color-teal-brand-hover);
          box-shadow: 0 20px 35px rgba(7, 91, 96, 0.3);
        }

        /* Nav Bar action buttons */
        .landing-nav .nav-actions {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .landing-nav .nav-link,
        .landing-nav .nav-button {
          min-height: 42px;
          border: 1px solid rgba(227, 222, 213, 0.12);
          border-radius: 6px;
          background: transparent;
          padding: 0 18px;
          color: #9ab3b5;
          text-decoration: none;
          font-weight: 600;
          font-size: 0.92rem;
          display: inline-flex;
          align-items: center;
          cursor: pointer;
          transition: all 0.3s var(--ease-out-quint);
        }

        .landing-nav--compact .nav-link,
        .landing-nav--compact .nav-button {
          min-height: 38px;
        }

        .landing-nav .nav-link:hover,
        .landing-nav .nav-button:hover {
          background: rgba(250, 250, 247, 0.05);
          border-color: var(--color-light-cream);
          color: var(--color-light-cream);
          transform: translateY(-1px);
        }

        .landing-nav .nav-link-primary {
          background: var(--color-teal-brand);
          color: #ffffff;
          border-color: var(--color-teal-brand);
        }

        .landing-nav .nav-link-primary:hover {
          background-color: var(--color-teal-brand-hover);
          border-color: var(--color-teal-brand-hover);
        }

        .landing-nav .account-pill {
          background: rgba(250, 250, 247, 0.08);
          border: 1px solid rgba(227, 222, 213, 0.12);
          padding: 0 15px;
          border-radius: 99px;
          font-size: 0.88rem;
          font-weight: 600;
          color: var(--color-light-cream);
          min-height: 42px;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          cursor: pointer;
          list-style: none;
          max-width: 190px;
        }

        .landing-nav--compact .account-pill {
          min-height: 38px;
        }

        .landing-nav .account-pill::-webkit-details-marker {
          display: none;
        }

        .landing-nav .account-pill span:first-child {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .landing-nav .account-menu {
          position: relative;
        }

        .landing-nav .account-menu-panel {
          background: #071b1e;
          border: 1px solid rgba(227, 222, 213, 0.12);
          border-radius: 8px;
          box-shadow: 0 18px 38px rgba(0, 0, 0, 0.24);
          color: #9ab3b5;
          display: grid;
          gap: 8px;
          min-width: 210px;
          padding: 10px;
          position: absolute;
          right: 0;
          top: calc(100% + 10px);
        }

        .landing-nav .account-menu-role {
          border-bottom: 1px solid rgba(227, 222, 213, 0.1);
          color: #a7bebf;
          font-size: 0.78rem;
          font-weight: 600;
          padding: 4px 4px 10px;
        }

        .landing-nav .nav-menu-button {
          background: transparent;
          border: 0;
          border-radius: 6px;
          color: var(--color-light-cream);
          cursor: pointer;
          font: inherit;
          font-size: 0.9rem;
          font-weight: 600;
          min-height: 36px;
          padding: 0 10px;
          text-align: left;
        }

        .landing-nav .nav-menu-button:hover {
          background: rgba(250, 250, 247, 0.08);
        }

        /* Footer styling */
        .landing-footer {
          border-top: 1px solid var(--color-sand-line);
          padding: 4.5rem clamp(2rem, 5vw, 6rem);
          display: flex;
          justify-content: space-between;
          align-items: center;
          background: #efebe2;
        }

        .footer-brand {
          font-family: var(--heading-font);
          font-size: 1.45rem;
          font-weight: 400;
          color: var(--color-teal-brand);
          text-decoration: none;
        }

        .footer-links {
          display: flex;
          gap: 3.5rem;
        }

        .footer-links a,
        .landing-footer p {
          font-size: 0.9rem;
          color: #636e6f;
          text-decoration: none;
          font-weight: 500;
          transition: color 0.2s ease;
        }

        .footer-links a:hover {
          color: var(--color-teal-brand);
        }

        /* ─── Accessibility: prefers-reduced-motion block ─── */
        @media (prefers-reduced-motion: reduce) {
          * {
            animation-duration: 0.01ms !important;
            animation-iteration-count: 1 !important;
            transition-duration: 0.01ms !important;
            scroll-behavior: auto !important;
          }
          .reveal-element {
            opacity: 1 !important;
            transform: none !important;
          }
        }

        @media (max-width: 1024px) {
          .landing-hero-grid {
            padding-bottom: 12rem;
          }

          .hero-product-container {
            margin-top: -8rem;
          }

          .asymmetric-features-grid {
            grid-template-columns: 1fr;
            gap: 5rem;
          }

          .features-narrative {
            position: relative;
            top: 0;
          }

          .asymmetric-card:nth-child(2) {
            margin-left: 0;
          }

          .staggered-timeline {
            grid-template-columns: 1fr 1fr;
          }

          .audience-section {
            grid-template-columns: 1fr;
            gap: 3.5rem;
          }

          .cta-band {
            flex-direction: column;
            text-align: center;
            gap: 3rem;
          }
        }

        @media (max-width: 768px) {
          .landing-nav {
            min-height: 72px;
            padding: 0 20px;
          }

          .landing-nav--compact {
            min-height: 60px;
          }

          .landing-brand {
            font-size: 1.58rem;
          }

          .landing-nav .nav-actions {
            gap: 8px;
          }

          .landing-nav .nav-link,
          .landing-nav .nav-button {
            min-height: 40px;
            padding: 0 13px;
            font-size: 0.8rem;
            line-height: 1.05;
            white-space: nowrap;
          }

          .landing-hero-grid {
            margin-top: 72px;
            padding: 3.8rem 2rem 10rem;
          }

          .hero-copy {
            margin-top: 0;
          }

          .hero-pill {
            align-self: stretch;
            justify-content: center;
            margin-bottom: 1.75rem;
            padding: 0.55rem 0.95rem;
            font-size: 0.66rem;
            letter-spacing: 0.09em;
          }

          .hero-copy h1 {
            font-size: 2.8rem;
            line-height: 1.05;
            max-width: 10.5ch;
            margin-bottom: 1.5rem;
          }

          .hero-copy p {
            font-size: 1.02rem;
            line-height: 1.6;
            margin-bottom: 2.4rem;
          }

          .hero-actions {
            align-items: stretch;
            gap: 1rem;
            justify-content: center;
            margin-bottom: 3rem;
            width: 100%;
          }

          .hero-actions .landing-primary-button,
          .hero-actions .landing-secondary-button {
            align-items: center;
            flex: 1;
            justify-content: center;
            min-height: 58px;
            min-width: 0;
            padding: 0 1rem;
            text-align: center;
          }

          .hero-product-container {
            margin-top: -6rem;
            padding: 0 18px;
          }

          .comparison-card {
            animation: mobileComparisonShellIn 0.72s var(--ease-out-expo) both;
            border-radius: 14px;
            overflow: hidden;
            padding: 1.25rem 0.9rem 1rem;
          }

          .comparison-card h2 {
            font-family: var(--body-font);
            font-size: 0.82rem;
            font-weight: 700;
            letter-spacing: 0.11em;
            line-height: 1.25;
            margin: 0 0 1rem;
            text-transform: uppercase;
          }

          .comparison-card h2 span {
            display: inline;
            font-family: inherit;
            font-style: normal;
            font-weight: 800;
          }

          .comparison-card h2,
          .comparison-subject-tabs {
            animation: mobileComparisonHeaderIn 0.58s var(--ease-out-expo) both;
          }

          .comparison-subject-tabs {
            animation-delay: 90ms;
          }

          .comparison-subject-tabs {
            display: grid;
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 0.38rem;
            background: transparent;
            border: 0;
            margin-bottom: 1rem;
            max-width: none;
            padding: 0;
            width: 100%;
          }

          .comparison-subject-active-pill {
            display: none;
          }

          .comparison-subject-button {
            background: #efebe2;
            border: 1px solid rgba(227, 222, 213, 0.9);
            border-radius: 8px;
            color: #596364;
            font-size: 0.78rem;
            font-weight: 700;
            min-width: 0;
            overflow: hidden;
            padding: 0.62rem 0.2rem;
            text-overflow: ellipsis;
            transition:
              background-color 0.22s var(--ease-out-quint),
              border-color 0.22s var(--ease-out-quint),
              box-shadow 0.22s var(--ease-out-quint),
              transform 0.22s var(--ease-out-quint);
            white-space: nowrap;
          }

          .comparison-subject-button:active {
            transform: scale(0.97);
          }

          .comparison-subject-button[aria-selected="true"] {
            background: var(--color-pure-white);
            border-color: rgba(7, 91, 96, 0.18);
            box-shadow: 0 6px 14px rgba(3, 20, 22, 0.08);
            color: var(--color-deep-forest);
          }

          .comparison-grid {
            display: flex;
            gap: 0.7rem;
            margin: 0 -0.2rem;
            overflow-x: auto;
            overscroll-behavior-x: contain;
            padding: 0 0.2rem 0.35rem;
            scroll-padding-left: 0.2rem;
            scroll-snap-type: x mandatory;
            scroll-behavior: smooth;
            -webkit-overflow-scrolling: touch;
          }

          .comparison-grid::-webkit-scrollbar {
            display: none;
          }

          .comparison-vs {
            display: none;
          }

          .comparison-panel {
            flex: 0 0 88%;
            min-height: 0;
            padding: 1.05rem 0.95rem;
            border-radius: 10px;
            opacity: 0;
            scroll-snap-align: start;
            scroll-snap-stop: always;
            transform: translateY(12px) scale(0.985);
            animation: mobileCompareCardIn 0.6s var(--ease-out-expo) forwards;
            transition:
              border-color 0.24s var(--ease-out-quint),
              box-shadow 0.24s var(--ease-out-quint),
              transform 0.24s var(--ease-out-quint);
          }

          .comparison-panel.success {
            animation-delay: 90ms;
          }

          .comparison-panel:active {
            transform: translateY(0) scale(0.992);
          }

          .comparison-panel.warning,
          .comparison-panel.success {
            background: #fffffb;
          }

          @keyframes mobileCompareCardIn {
            to {
              opacity: 1;
              transform: translateY(0) scale(1);
            }
          }

          @keyframes mobileComparisonShellIn {
            from {
              opacity: 0;
              transform: translateY(18px) scale(0.985);
            }
            to {
              opacity: 1;
              transform: translateY(0) scale(1);
            }
          }

          @keyframes mobileComparisonHeaderIn {
            from {
              opacity: 0;
              transform: translateY(10px);
            }
            to {
              opacity: 1;
              transform: translateY(0);
            }
          }

          .comparison-panel-head {
            align-items: flex-start;
            gap: 0.7rem;
            margin-bottom: 1rem;
          }

          .comparison-panel-head h3 {
            font-size: 1.28rem;
            line-height: 1.05;
          }

          .comparison-panel-head span {
            border-radius: 6px;
            font-size: 0.56rem;
            line-height: 1.25;
            padding: 0.32rem 0.48rem;
            text-align: center;
          }

          .comparison-dialogue {
            gap: 0.72rem;
            margin-bottom: 0.8rem;
          }

          .comparison-avatar {
            height: 28px;
            width: 28px;
          }

          .comparison-meta {
            font-size: 0.58rem;
            letter-spacing: 0.055em;
          }

          .comparison-question,
          .comparison-response p {
            font-size: 0.82rem;
            line-height: 1.45;
          }

          .comparison-problem,
          .comparison-response-row {
            border-radius: 8px;
            padding: 0.85rem;
            margin-bottom: 0.8rem;
          }

          .comparison-response-row {
            flex-grow: 0;
          }

          .comparison-problem p {
            font-size: 0.61rem;
            margin-bottom: 0.45rem;
          }

          .comparison-problem span,
          .comparison-problem li {
            font-size: 0.78rem;
            line-height: 1.4;
          }

          .comparison-guidance-controls {
            background: #eef2f1;
            gap: 0.26rem;
            margin-bottom: 0.8rem;
            padding: 0.22rem;
          }

          .comparison-guidance-button {
            min-height: 42px;
            padding: 0.42rem 0.1rem;
            font-size: 0.68rem;
          }

          .comparison-strip {
            align-items: flex-start;
            font-size: 0.78rem;
            line-height: 1.35;
            padding-top: 0.75rem;
          }

          .landing-nav-links {
            display: none;
          }

          .trust-row {
            flex-direction: column;
            gap: 1.25rem;
            align-items: center;
          }

          .features-section {
            padding: 5.5rem 1.35rem 5rem;
          }

          .asymmetric-features-grid {
            gap: 2.6rem;
          }

          .features-narrative span {
            font-size: 0.72rem;
            margin-bottom: 0.9rem;
          }

          .features-narrative h2 {
            font-size: 2.38rem;
            line-height: 1.08;
            max-width: 11.5ch;
          }

          .features-narrative p {
            font-size: 1rem;
          }

          .reveal-element {
            transform: translateY(22px) scale(0.992);
            transition-duration: 0.78s;
          }

          .asymmetric-card.reveal-element,
          .timeline-card.reveal-element,
          .audience-box.reveal-element {
            transform: translateY(26px) scale(0.985);
          }

          .asymmetric-card.reveal-element.revealed,
          .timeline-card.reveal-element.revealed,
          .audience-box.reveal-element.revealed {
            transform: translateY(0) scale(1);
          }

          .features-narrative.revealed h2,
          .section-header.revealed h2,
          .cta-band.revealed h2 {
            animation: mobileSectionTitleIn 0.68s var(--ease-out-expo) both;
          }

          @keyframes mobileSectionTitleIn {
            from {
              opacity: 0;
              transform: translateY(12px);
            }
            to {
              opacity: 1;
              transform: translateY(0);
            }
          }
        }

        @media (max-width: 640px) {
          .landing-nav .nav-link:not(.nav-link-primary) {
            display: none;
          }

          .landing-nav .nav-link-primary {
            min-width: 118px;
          }

          .staggered-timeline {
            grid-template-columns: 1fr;
          }

          .cta-actions {
            flex-direction: column;
            width: 100%;
          }

          .cta-actions a {
            text-align: center;
            width: 100%;
          }

          .audience-box {
            padding: 3rem 2rem;
          }
        }
      `}</style>

      {/* Navigation */}
      <nav className={`landing-nav ${isNavCompact ? "landing-nav--compact" : ""}`} aria-label="Main Navigation">
        <Link href="/" className="landing-brand">
          <span>Chandra</span>
        </Link>
        <div className="landing-nav-links">
          <a href="#how-it-works" onClick={(e) => handleScrollToSection(e, "how-it-works")}>How it works</a>
          <a href="#teachers" onClick={(e) => handleScrollToSection(e, "teachers")}>Teacher controls</a>
          <a href="#students" onClick={(e) => handleScrollToSection(e, "students")}>Student experience</a>
          <a href="#features" onClick={(e) => handleScrollToSection(e, "features")}>Evidence & safety</a>
        </div>
        <LocalAuthNav onNavigate={handleNavigation} />
      </nav>

      {/* Hero section */}
      <section className="landing-hero-grid" aria-label="Introduction">
        <div className="hero-copy">
          <div className="hero-pill hero-pill-animate">
            <SparkleIcon />
            <span>Teacher-guided AI for classroom learning</span>
          </div>
          <h1 className="hero-title-animate">Teacher-guided AI tutoring that keeps students doing the thinking.</h1>
          <p className="hero-desc-animate">
            Chandra lets teachers set tutoring rules, anchor AI support in class materials, and
            spot where students are getting stuck, so homework stays focused on learning instead of
            answer copying.
          </p>
          <div className="hero-actions hero-actions-animate">
            <LocalLandingActions onNavigate={handleNavigation} />
            <a
              className="landing-secondary-button"
              href="#how-it-works"
              onClick={(e) => handleScrollToSection(e, "how-it-works")}
            >
              See how it works
            </a>
          </div>

          <div className="trust-row hero-trust-animate">
            <span>
              <CheckCircleIcon />
              Keeps students thinking
            </span>
            <span>
              <CheckCircleIcon />
              Teacher-controlled help
            </span>
            <span>
              <CheckCircleIcon />
              Grounded in class materials
            </span>
          </div>
        </div>
      </section>

      {/* Live Interactive Sandbox Widget (Overlapping the Hero) */}
      <div className="hero-product-container reveal-element delay-1">
        <div className="comparison-card">
          <h2>
            <span>Without Chandra</span> vs <span>With Chandra</span>
          </h2>

          {/* Subject selector tab list with Absolute Indicator Pill */}
          <div className="comparison-subject-tabs" role="tablist" aria-label="Subjects">
            <div 
              className="comparison-subject-active-pill" 
              style={{
                transform: 
                  activeSubject === "biology" ? "translateX(0)" : 
                  activeSubject === "math" ? "translateX(calc(100% + 8px))" : 
                  "translateX(calc(200% + 16px))"
              }}
            />
            {(Object.keys(subjectsData) as Subject[]).map((subj) => (
              <button
                key={subj}
                role="tab"
                aria-selected={activeSubject === subj}
                className="comparison-subject-button"
                onClick={() => handleSubjectChange(subj)}
              >
                {subjectsData[subj].title}
              </button>
            ))}
          </div>

          <div className={`comparison-grid comparison-panel-fade ${isChangingSubject ? "changing" : ""}`}>
            {/* Without Chandra (Generic AI Answer Dumping) */}
            <div className="comparison-panel warning">
              <div className="comparison-panel-head">
                <h3>Generic AI</h3>
                <span>Answer dumping</span>
              </div>
              
              <div className="comparison-dialogue">
                <div className="comparison-avatar">S</div>
                <div>
                  <div className="comparison-meta">Student asks</div>
                  <p className="comparison-question">{"\"I'm stuck on #3. Where do I start?\""}</p>
                </div>
              </div>

              <div className="comparison-problem">
                <p>Problem #3</p>
                <span>{currentSubjectData.problem.question}</span>
                {currentSubjectData.problem.expression && (
                  <div style={{ fontFamily: "monospace", fontSize: "0.95rem", margin: "6px 0", fontWeight: "bold" }}>
                    {currentSubjectData.problem.expression}
                  </div>
                )}
                {currentSubjectData.problem.options && (
                  <ul style={{ listStyle: "none", padding: 0, margin: "6px 0 0" }}>
                    {currentSubjectData.problem.options.map((opt) => (
                      <li key={opt} style={{ margin: "2px 0", fontSize: "0.75rem" }}>{opt}</li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="comparison-response-row">
                <div className="comparison-dialogue">
                  <div className="comparison-avatar response">AI</div>
                  <div className="comparison-response">
                    <div className="comparison-meta">AI Response</div>
                    <p>{currentSubjectData.withoutChandra}</p>
                  </div>
                </div>
              </div>

              <div className="comparison-strip">
                <AlertCircleIcon />
                <span>Student gets the answer, but skips the reasoning.</span>
              </div>
            </div>

            {/* VS separator */}
            <div className="comparison-vs">VS</div>

            {/* With Chandra (Guided Learning) */}
            <div className="comparison-panel success">
              <div className="comparison-panel-head">
                <h3>Chandra AI</h3>
                <span>Guided learning</span>
              </div>

              <div className="comparison-dialogue">
                <div className="comparison-avatar">S</div>
                <div>
                  <div className="comparison-meta">Student asks</div>
                  <p className="comparison-question">{"\"I'm stuck on #3. Where do I start?\""}</p>
                </div>
              </div>

              <div className="comparison-problem">
                <p>Problem #3</p>
                <span>{currentSubjectData.problem.question}</span>
                {currentSubjectData.problem.expression && (
                  <div style={{ fontFamily: "monospace", fontSize: "0.95rem", margin: "6px 0", fontWeight: "bold" }}>
                    {currentSubjectData.problem.expression}
                  </div>
                )}
                {currentSubjectData.problem.options && (
                  <ul style={{ listStyle: "none", padding: 0, margin: "6px 0 0" }}>
                    {currentSubjectData.problem.options.map((opt) => (
                      <li key={opt} style={{ margin: "2px 0", fontSize: "0.75rem" }}>{opt}</li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="comparison-response-row">
                <div className="comparison-dialogue">
                  <div className="comparison-avatar response">C</div>
                  <div className="comparison-response">
                    <div className="comparison-meta">Chandra Response</div>
                    {/* Key property triggers CSS exit/entry keyframe rendering on text recalculation */}
                    <p key={getChandraResponse()} className="comparison-response-text">
                      {getChandraResponse()}
                    </p>
                  </div>
                </div>
              </div>

              {/* Sandbox Control Toggles */}
              <div className="comparison-guidance-controls">
                <button
                  type="button"
                  aria-pressed={hintActive}
                  className="comparison-guidance-button"
                  onClick={() => setHintActive(!hintActive)}
                >
                  Hint {hintActive ? "✓" : "+"}
                </button>
                <button
                  type="button"
                  aria-pressed={actionActive}
                  className="comparison-guidance-button"
                  onClick={() => setActionActive(!actionActive)}
                >
                  Action {actionActive ? "✓" : "+"}
                </button>
                <button
                  type="button"
                  aria-pressed={explainActive}
                  className="comparison-guidance-button"
                  onClick={() => setExplainActive(!explainActive)}
                >
                  Explain {explainActive ? "✓" : "+"}
                </button>
              </div>

              <div className="comparison-strip">
                <CheckCircleIcon />
                <span>Student reasons through the concept before choosing.</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Asymmetric Features Section ("Why Chandra") */}
      <section id="features" className="features-section" aria-labelledby="features-title">
        <div className="asymmetric-features-grid">
          {/* Narrative Column */}
          <div className="features-narrative reveal-element">
            <span id="features-title">Why Chandra</span>
            <h2>Designed to align tutoring support with classroom curriculum.</h2>
            <p>
              Rather than generic AI engines that skip straight to results, Chandra bridges the gap
              between independent student assignments and teacher-designed instruction policies.
            </p>
            <div className="features-quote">
              <p>
                {"\"Chandra gives my AP students the customized nudge they need during homework hours, without simply doing the work for them.\""}
              </p>
              <cite>Sarah Jenkins, Chemistry Teacher</cite>
            </div>
          </div>

          {/* Cards Stack Column with asymmetric alignments */}
          <div className="features-cards-stack">
            <div className="asymmetric-card reveal-element delay-1">
              <div className="card-icon-wrapper">
                <SlidersIcon />
              </div>
              <div>
                <h3>Teachers control the help</h3>
                <p>
                  Set detailed rules governing whether students receive high-level conceptual hints,
                  strategic next steps, background explanations, or review-only support based on classroom need.
                </p>
              </div>
            </div>

            <div className="asymmetric-card reveal-element delay-2">
              <div className="card-icon-wrapper">
                <BookOpenIcon />
              </div>
              <div>
                <h3>Grounded in your materials</h3>
                <p>
                  Upload PDFs, worksheets, class notes, and textbook pages so that Chandra&apos;s AI tutoring
                  explanations always anchor directly to the exact terminology and methods you taught in class.
                </p>
              </div>
            </div>

            <div className="asymmetric-card reveal-element delay-3">
              <div className="card-icon-wrapper">
                <ShieldAlertIcon />
              </div>
              <div>
                <h3>Designed to prevent answer dumping</h3>
                <p>
                  Chandra nudges students progressively through challenges, checks intermediate attempts, and
                  flags patterns of rapid answer-seeking or excessive tutor assistance.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* How it Works Staggered Timeline Section */}
      <section id="how-it-works" className="how-it-works-section" aria-labelledby="how-it-works-title">
        <div className="section-header reveal-element">
          <span id="how-it-works-title">How It Works</span>
          <h2>A seamless loop between tutoring guardrails and learning insights.</h2>
        </div>
        
        <div className="staggered-timeline">
          <div className="timeline-card reveal-element delay-1">
            <div className="timeline-number">I</div>
            <h3>Upload class materials</h3>
            <p style={{ fontSize: "0.9rem", lineHeight: "1.6", color: "#495354", marginTop: "0.5rem" }}>
              Provide PDFs, study guides, worksheets, or textbook pages to establish the grounding corpus.
            </p>
          </div>

          <div className="timeline-card reveal-element delay-2">
            <div className="timeline-number">II</div>
            <h3>Set tutoring policy</h3>
            <p style={{ fontSize: "0.9rem", lineHeight: "1.6", color: "#495354", marginTop: "0.5rem" }}>
              Define the rules, enabling or limiting hints, explanations, and review tools for assignments.
            </p>
          </div>

          <div className="timeline-card reveal-element delay-3">
            <div className="timeline-number">III</div>
            <h3>Students ask for guided help</h3>
            <p style={{ fontSize: "0.9rem", lineHeight: "1.6", color: "#495354", marginTop: "0.5rem" }}>
              Students interact with the chatbot, getting scaffolded next steps rather than instant answers.
            </p>
          </div>

          <div className="timeline-card reveal-element delay-4">
            <div className="timeline-number">IV</div>
            <h3>Review learning insights</h3>
            <p style={{ fontSize: "0.9rem", lineHeight: "1.6", color: "#495354", marginTop: "0.5rem" }}>
              Spot exactly where students got stuck and examine engagement patterns to adjust your lesson plans.
            </p>
          </div>
        </div>
      </section>

      {/* Classroom Symmetrical Split columns */}
      <section id="teachers" className="audience-section" aria-label="Audience Benefits">
        <div className="audience-box reveal-element delay-1">
          <h2>
            <GraduationCapIcon />
            <span>For Teachers</span>
          </h2>
          <ul>
            <li>
              <CheckIcon />
              <span>Control precise tutoring modes and guardrail rules</span>
            </li>
            <li>
              <CheckIcon />
              <span>Identify concept blockages and track student progress</span>
            </li>
            <li>
              <CheckIcon />
              <span>Spot and review suspicious answer-seeking patterns</span>
            </li>
            <li>
              <CheckIcon />
              <span>Ensure AI support stays strictly aligned with your syllabus</span>
            </li>
          </ul>
        </div>

        <div id="students" className="audience-box reveal-element delay-2">
          <h2>
            <UsersIcon />
            <span>For Students</span>
          </h2>
          <ul>
            <li>
              <CheckIcon />
              <span>Get immediate, targeted hints when stuck on homework</span>
            </li>
            <li>
              <CheckIcon />
              <span>Learn directly from class worksheets and specific notes</span>
            </li>
            <li>
              <CheckIcon />
              <span>Build robust understanding without copy-pasting code or keys</span>
            </li>
            <li>
              <CheckIcon />
              <span>Boost overall learning confidence before submitting exams</span>
            </li>
          </ul>
        </div>
      </section>

      {/* Call to Action Band */}
      <section className="cta-band reveal-element" aria-label="Get Started">
        <h2>Give students support without giving away the work.</h2>
        <div className="cta-actions">
          <Link 
            className="landing-primary-button" 
            href="/auth?mode=signup"
            onClick={(e) => handleNavigation(e, "/auth?mode=signup")}
          >
            Create account
          </Link>
          <Link className="landing-secondary-button" href="/teacher" style={{ border: "1px solid rgba(250, 250, 247, 0.25)" }}>
            Open teacher dashboard
          </Link>
        </div>
      </section>

      {/* Page Footer */}
      <footer className="landing-footer" aria-label="Footer">
        <Link href="/" className="footer-brand">
          <span>Chandra</span>
        </Link>
        <div className="footer-links">
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
          <a href="/contact">Contact</a>
        </div>
        <p>© 2026 Chandra. All rights reserved.</p>
      </footer>
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

/* ─── Local Navigation Action Components (Inlined for self-contained elegance) ─── */

interface NavigationProps {
  onNavigate: (e: React.MouseEvent<HTMLAnchorElement | HTMLButtonElement>, href: string) => void;
}

function LocalLandingActions({ onNavigate }: NavigationProps) {
  const { firebaseReady, isLoading, profile, user } = useAuth();

  if (!firebaseReady || isLoading || !user) {
    return (
      <Link 
        className="landing-primary-button" 
        href="/auth?mode=signup"
        onClick={(e) => onNavigate(e, "/auth?mode=signup")}
      >
        Create account
      </Link>
    );
  }

  if (profile?.role === "student") {
    return (
      <Link 
        className="landing-primary-button" 
        href="/student"
        onClick={(e) => onNavigate(e, "/student")}
      >
        Open Student Chat
      </Link>
    );
  }

  if (profile?.role === "teacher") {
    return (
      <Link 
        className="landing-primary-button" 
        href="/teacher"
        onClick={(e) => onNavigate(e, "/teacher")}
      >
        Open Teacher Dashboard
      </Link>
    );
  }

  return (
    <Link 
      className="landing-primary-button" 
      href="/auth?mode=signup"
      onClick={(e) => onNavigate(e, "/auth?mode=signup")}
    >
      Create account
    </Link>
  );
}

function LocalAuthNav({ onNavigate }: NavigationProps) {
  const { firebaseReady, isLoading, profile, user } = useAuth();

  async function handleSignOut(e: React.MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    await signOutCurrentUser();
    onNavigate(e, "/auth?mode=signin");
  }

  if (!firebaseReady) {
    return (
      <div className="nav-actions">
        <Link 
          className="nav-link nav-link-primary"
          href="/auth?mode=signup"
          onClick={(e) => onNavigate(e, "/auth?mode=signup")}
        >
          Request demo
        </Link>
      </div>
    );
  }

  if (isLoading) {
    return <div className="nav-actions" style={{ color: "#9ab3b5" }}>Loading</div>;
  }

  if (!user) {
    return (
      <div className="nav-actions">
        <Link 
          className="nav-link"
          href="/auth?mode=signin"
          onClick={(e) => onNavigate(e, "/auth?mode=signin")}
        >
          Sign in
        </Link>
        <Link 
          className="nav-link nav-link-primary"
          href="/auth?mode=signup"
          onClick={(e) => onNavigate(e, "/auth?mode=signup")}
        >
          Request demo
        </Link>
      </div>
    );
  }

  const isStudent = profile?.role === "student";
  const actionHref = isStudent ? "/student" : "/teacher";
  const actionLabel = isStudent ? "Open study space" : "Open dashboard";
  const accountLabel = profile?.displayName || user.email || "Account";
  const accountRole = isStudent ? "Student account" : "Teacher account";

  return (
    <div className="nav-actions">
      <Link
        className="nav-link nav-link-primary"
        href={actionHref}
        onClick={(e) => onNavigate(e, actionHref)}
      >
        {actionLabel}
      </Link>
      <details className="account-menu">
        <summary className="account-pill" aria-label="Account menu">
          <span>{accountLabel}</span>
          <span aria-hidden="true">▾</span>
        </summary>
        <div className="account-menu-panel">
          <span className="account-menu-role">{accountRole}</span>
          <button className="nav-menu-button" type="button" onClick={handleSignOut}>
            Sign out
          </button>
        </div>
      </details>
    </div>
  );
}

/* ─── Custom Inline SVGs ─── */

function SparkleIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      width="15"
      height="15"
    >
      <path d="M12 3l1.5 5.2L19 10l-5.5 1.8L12 17l-1.5-5.2L5 10l5.5-1.8L12 3Z" />
      <path d="M5 15l.7 2.3L8 18l-2.3.7L5 21l-.7-2.3L2 18l2.3-.7L5 15Z" />
    </svg>
  );
}

function AlertCircleIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2.5"
      width="16"
      height="16"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function CheckCircleIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2.5"
      width="16"
      height="16"
    >
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="3"
      width="14"
      height="14"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function SlidersIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      width="20"
      height="20"
    >
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
    </svg>
  );
}

function BookOpenIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      width="20"
      height="20"
    >
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </svg>
  );
}

function ShieldAlertIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      width="20"
      height="20"
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function GraduationCapIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      width="24"
      height="24"
    >
      <path d="M22 10v6M2 10l10-5 10 5-10 5z" />
      <path d="M6 12v5c0 2 2 3 6 3s6-1 6-3v-5" />
    </svg>
  );
}

function UsersIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      width="24"
      height="24"
    >
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
