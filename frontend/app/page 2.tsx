"use client";

import Link from "next/link";
import { useState } from "react";
import { ChandraLogoMark } from "@/components/ChandraLogoMark";
import { AuthNav } from "@/components/AuthNav";
import { LandingActions } from "@/components/LandingActions";

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
  const [showWithChandra, setShowWithChandra] = useState<boolean>(true);
  const [hintActive, setHintActive] = useState<boolean>(true);
  const [actionActive, setActionActive] = useState<boolean>(false);
  const [explainActive, setExplainActive] = useState<boolean>(false);

  const currentSubjectData = subjectsData[activeSubject];

  // Helper to determine the dynamic Chandra response
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

    return "Select one or more guidance modes below to see how Chandra guides the student.";
  };

  const handleScrollToHowItWorks = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    const element = document.getElementById("how-it-works");
    if (element) {
      element.scrollIntoView({ behavior: "smooth" });
    }
  };

  return (
    <main className="chandra-home">
      {/* Navigation */}
      <nav className="landing-nav" aria-label="Main Navigation">
        <Link href="/" className="landing-brand">
          <ChandraLogoMark />
          <span>Chandra</span>
        </Link>
        <div className="landing-nav-links">
          <a href="#how-it-works" onClick={handleScrollToHowItWorks}>How it works</a>
          <a href="#features">Features</a>
          <a href="#teachers">Teachers</a>
          <a href="#students">Students</a>
          <a href="#pricing">Pricing</a>
        </div>
        <AuthNav showCreateAccount={true} />
      </nav>

      {/* Hero Section */}
      <section className="landing-hero-grid" aria-label="Introduction">
        <div className="hero-copy">
          <div className="hero-pill">
            <SparkleIcon />
            <span>Teacher-guided AI for classroom learning</span>
          </div>
          <h1>Teacher-guided AI tutoring that keeps students doing the thinking.</h1>
          <p>
            Chandra lets teachers set tutoring rules, anchor AI support in class materials, and
            spot where students are getting stuck, so homework stays focused on learning instead of
            answer copying.
          </p>
          <div className="hero-actions">
            <LandingActions />
            <a
              className="landing-secondary-button"
              href="#how-it-works"
              onClick={handleScrollToHowItWorks}
            >
              See how it works
            </a>
          </div>
        </div>

        {/* Interactive Mockup Widget */}
        <div className="hero-product">
          <div className="comparison-card">
            <h2>
              <span>Without Chandra</span> vs <span>With Chandra</span>
            </h2>

            {/* Subject Selector Tabs */}
            <div className="comparison-subject-tabs" role="tablist" aria-label="Subjects">
              {(Object.keys(subjectsData) as Subject[]).map((subj) => (
                <button
                  key={subj}
                  role="tab"
                  aria-selected={activeSubject === subj}
                  className="comparison-subject-button"
                  onClick={() => setActiveSubject(subj)}
                >
                  {subjectsData[subj].title}
                </button>
              ))}
            </div>

            <div className="comparison-grid">
              {/* Without Chandra Panel */}
              <div className={`comparison-panel warning ${!showWithChandra ? "active" : ""}`}>
                <div className="comparison-panel-head">
                  <h3>Generic AI</h3>
                  <span>Answer dumping</span>
                </div>
                <div className="comparison-dialogue">
                  <div className="comparison-avatar">S</div>
                  <div>
                    <div className="comparison-meta">Student asks</div>
                    <p className="comparison-question">"I'm stuck on #3. Where do I start?"</p>
                  </div>
                </div>

                <div className="comparison-problem">
                  <p>Problem #3</p>
                  <span>{currentSubjectData.problem.question}</span>
                  {currentSubjectData.problem.expression && (
                    <div style={{ fontFamily: "monospace", fontSize: "1.1rem", margin: "8px 0" }}>
                      {currentSubjectData.problem.expression}
                    </div>
                  )}
                  {currentSubjectData.problem.options && (
                    <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0" }}>
                      {currentSubjectData.problem.options.map((opt) => (
                        <li key={opt} style={{ margin: "4px 0" }}>{opt}</li>
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

              {/* VS Divider */}
              <div className="comparison-vs">VS</div>

              {/* With Chandra Panel */}
              <div className={`comparison-panel success ${showWithChandra ? "active" : ""}`}>
                <div className="comparison-panel-head">
                  <h3>Chandra AI</h3>
                  <span>Guided learning</span>
                </div>
                <div className="comparison-dialogue">
                  <div className="comparison-avatar">S</div>
                  <div>
                    <div className="comparison-meta">Student asks</div>
                    <p className="comparison-question">"I'm stuck on #3. Where do I start?"</p>
                  </div>
                </div>

                <div className="comparison-problem">
                  <p>Problem #3</p>
                  <span>{currentSubjectData.problem.question}</span>
                  {currentSubjectData.problem.expression && (
                    <div style={{ fontFamily: "monospace", fontSize: "1.1rem", margin: "8px 0" }}>
                      {currentSubjectData.problem.expression}
                    </div>
                  )}
                  {currentSubjectData.problem.options && (
                    <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0" }}>
                      {currentSubjectData.problem.options.map((opt) => (
                        <li key={opt} style={{ margin: "4px 0" }}>{opt}</li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="comparison-response-row">
                  <div className="comparison-dialogue">
                    <div className="comparison-avatar response">C</div>
                    <div className="comparison-response">
                      <div className="comparison-meta">Chandra Response</div>
                      <p>{getChandraResponse()}</p>
                    </div>
                  </div>
                </div>

                {/* Interactive Toggles for Chandra Guidance Modes */}
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
      </section>

      {/* Benefits section (Why Chandra) */}
      <section id="features" className="below-hero-grid" aria-labelledby="features-title">
        <div className="section-rule-title">
          <span id="features-title">WHY CHANDRA</span>
        </div>
        <div className="feature-card-row">
          <div className="feature-card">
            <div className="feature-icon">
              <SlidersIcon />
            </div>
            <div>
              <h2>Teachers control the help</h2>
              <p>Set whether students receive hints, explanations, examples, or review-only support.</p>
            </div>
          </div>
          <div className="feature-card">
            <div className="feature-icon">
              <BookOpenIcon />
            </div>
            <div>
              <h2>Grounded in your materials</h2>
              <p>Use PDFs, worksheets, notes, and textbook pages so tutoring stays tied to class content.</p>
            </div>
          </div>
          <div className="feature-card">
            <div className="feature-icon">
              <ShieldAlertIcon />
            </div>
            <div>
              <h2>Designed to prevent answer dumping</h2>
              <p>Chandra nudges students through steps, checks attempts, and flags over-help.</p>
            </div>
          </div>
        </div>
      </section>

      {/* How it Works Section */}
      <section id="how-it-works" className="steps-section" aria-labelledby="how-it-works-title">
        <div className="section-rule-title">
          <span id="how-it-works-title">HOW IT WORKS</span>
        </div>
        <div className="step-row">
          <div className="step-card">
            <div className="step-number">1</div>
            <h2>Upload class materials</h2>
          </div>
          <div className="step-card">
            <div className="step-number">2</div>
            <h2>Set tutoring policy</h2>
          </div>
          <div className="step-card">
            <div className="step-number">3</div>
            <h2>Students ask for guided help</h2>
          </div>
          <div className="step-card">
            <div className="step-number">4</div>
            <h2>Review learning insights</h2>
          </div>
        </div>
      </section>

      {/* Audience Section */}
      <section id="teachers" className="audience-grid" aria-label="Audience Benefits">
        <div className="audience-panel">
          <div className="audience-icon">
            <GraduationCapIcon />
          </div>
          <div>
            <h2>For Teachers</h2>
            <ul>
              <li>
                <CheckIcon />
                <span>Control tutoring modes</span>
              </li>
              <li>
                <CheckIcon />
                <span>See where students get stuck</span>
              </li>
              <li>
                <CheckIcon />
                <span>Review answer-seeking patterns</span>
              </li>
              <li>
                <CheckIcon />
                <span>Keep AI aligned with your classroom</span>
              </li>
            </ul>
          </div>
        </div>

        <div id="students" className="audience-panel">
          <div className="audience-icon">
            <UsersIcon />
          </div>
          <div>
            <h2>For Students</h2>
            <ul>
              <li>
                <CheckIcon />
                <span>Get hints when stuck</span>
              </li>
              <li>
                <CheckIcon />
                <span>Learn from class materials</span>
              </li>
              <li>
                <CheckIcon />
                <span>Understand steps without copying</span>
              </li>
              <li>
                <CheckIcon />
                <span>Build confidence before submitting</span>
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* Call to Action Band */}
      <section id="pricing" className="cta-band" aria-label="Get Started">
        <h2>Give students support without giving away the work.</h2>
        <div>
          <Link className="landing-primary-button" href="/auth?mode=signup">
            Create account
          </Link>
          <Link className="landing-secondary-button" href="/teacher">
            Open teacher dashboard
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="landing-footer" aria-label="Footer">
        <Link href="/" className="landing-brand footer-brand">
          <ChandraLogoMark />
          <span>Chandra</span>
        </Link>
        <div className="footer-links">
          <a href="#features">Features</a>
          <a href="#pricing">Pricing</a>
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
          <Link href="/contact">Contact</Link>
        </div>
        <p>© 2026 Chandra. All rights reserved.</p>
      </footer>
    </main>
  );
}

/* ─── Inline icons to avoid lucide-react dependencies ─── */

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
      width="18"
      height="18"
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
      width="12"
      height="12"
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
      width="28"
      height="28"
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
      width="28"
      height="28"
    >
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
