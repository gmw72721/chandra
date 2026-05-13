import Link from "next/link";
import type { ReactElement, ReactNode } from "react";
import { AuthNav } from "@/components/AuthNav";
import { LandingMotion } from "@/components/LandingMotion";

const navLinks = ["Features", "How it works", "Teachers", "Students", "Pricing"];

const trustItems = [
  { icon: SparkleIcon, label: "Keeps students thinking" },
  { icon: UsersIcon, label: "Teacher-controlled help" },
  { icon: BookIcon, label: "Grounded in class materials" }
];

const features = [
  {
    icon: UserCircleIcon,
    title: "Teachers control the help",
    copy: "Set whether students receive hints, explanations, examples, or review-only support."
  },
  {
    icon: DocumentIcon,
    title: "Grounded in your materials",
    copy: "Use PDFs, worksheets, notes, and textbook pages so tutoring stays tied to class content."
  },
  {
    icon: ShieldCheckIcon,
    title: "Designed to prevent answer dumping",
    copy: "Chandra nudges students through steps, checks attempts, and flags over-help."
  }
];

const steps = [
  { icon: UploadIcon, label: "Upload class materials" },
  { icon: SlidersIcon, label: "Set tutoring policy" },
  { icon: ChatIcon, label: "Students ask for guided help" },
  { icon: ChartIcon, label: "Review learning insights" }
];

const teacherItems = [
  "Control tutoring modes",
  "See where students get stuck",
  "Review answer-seeking patterns",
  "Keep AI aligned with your classroom"
];

const studentItems = [
  "Get hints when stuck",
  "Learn from class materials",
  "Understand steps without copying",
  "Build confidence before submitting"
];

export default function HomePage() {
  return (
    <main className="chandra-home">
      <LandingMotion />
      <nav className="landing-nav" aria-label="Main navigation">
        <Link className="landing-brand" href="/" aria-label="Chandra home">
          <CrescentIcon />
          <span>Chandra</span>
        </Link>
        <div className="landing-nav-links" aria-label="Page sections">
          {navLinks.map((label) => (
            <Link key={label} href={`#${label.toLowerCase().replaceAll(" ", "-")}`}>
              {label}
            </Link>
          ))}
        </div>
        <AuthNav showCreateAccount />
      </nav>

      <section className="landing-hero-grid">
        <div className="hero-copy">
          <div className="hero-pill" data-motion="hero-pill">
            <SparkleIcon />
            <span>Teacher-guided AI for classroom learning</span>
          </div>
          <h1 data-motion="hero-heading">Teacher-guided AI tutoring that keeps students doing the thinking.</h1>
          <p data-motion="hero-copy">
            Chandra lets teachers set tutoring rules, anchor AI support in class materials, and
            spot where students are getting stuck, so homework stays focused on learning instead
            of answer copying.
          </p>
          <div className="hero-actions" data-motion="hero-cta">
            <Link className="landing-secondary-button" href="#how-it-works">
              <PlayIcon />
              See how it works
            </Link>
          </div>
          <div className="trust-row" aria-label="Chandra benefits" data-motion="hero-trust">
            {trustItems.map(({ icon: Icon, label }) => (
              <span key={label}>
                <Icon />
                {label}
              </span>
            ))}
          </div>
        </div>

        <div className="hero-product" aria-label="Before and after Chandra comparison" data-motion="hero-product">
          <BeforeAfterComparison />
        </div>
      </section>

      <div className="landing-info-grid">
        <section className="below-hero-grid" id="features" data-motion-reveal="section">
          <div className="section-rule-title" data-motion="section-title">
            <span>WHY CHANDRA</span>
          </div>
          <div className="feature-card-row">
            {features.map(({ icon: Icon, title, copy }) => (
              <article className="feature-card" key={title} data-motion="scroll-card">
                <span className="feature-icon">
                  <Icon />
                </span>
                <div>
                  <h2>{title}</h2>
                  <p>{copy}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="steps-section" id="how-it-works" data-motion-reveal="timeline">
          <div className="section-rule-title" data-motion="section-title">
            <span>HOW IT WORKS</span>
          </div>
          <div className="step-row">
            {steps.map(({ icon: Icon, label }, index) => (
              <article className="step-card" key={label} data-motion="timeline-step">
                <div className="step-number">{index + 1}</div>
                <span className="step-icon">
                  <Icon />
                </span>
                <h2>{label}</h2>
              </article>
            ))}
          </div>
        </section>
      </div>

      <section className="audience-grid" data-motion-reveal="section">
        <AudiencePanel id="teachers" icon={TeacherBoardIcon} title="For teachers" items={teacherItems} />
        <AudiencePanel id="students" icon={UserCircleIcon} title="For students" items={studentItems} />
      </section>

      <section className="cta-band" id="pricing" data-motion-reveal="section">
        <h2>Give students support without giving away the work.</h2>
        <div>
          <Link className="landing-primary-button" href="/auth">
            Create account
          </Link>
          <Link className="landing-secondary-button" href="/teacher">
            Open teacher dashboard
          </Link>
        </div>
      </section>

      <footer className="landing-footer">
        <Link className="landing-brand footer-brand" href="/">
          <CrescentIcon />
          <span>Chandra</span>
        </Link>
        <div className="footer-links">
          {["Features", "Pricing", "Privacy", "Terms", "Contact"].map((label) => (
            <Link key={label} href={label === "Features" ? "#features" : "#"}>
              {label}
            </Link>
          ))}
        </div>
        <p>© 2024 Chandra. All rights reserved.</p>
      </footer>
    </main>
  );
}

function BeforeAfterComparison() {
  return (
    <article className="comparison-card" aria-labelledby="comparison-heading">
      <h2 id="comparison-heading" data-motion="comparison-title">
        <span>Before</span>
        <span aria-hidden="true"> / </span>
        <span>After Chandra</span>
      </h2>
      <div className="comparison-grid">
        <ComparisonPanel
          badge="Answer dumping"
          footer="Student gets the answer, but skips the reasoning."
          responseLabel="AI"
          title="Without Chandra"
          tone="warning"
        >
          <p>
            Start by looking for the molecule that directly stores usable energy for the cell. The
            Calvin cycle uses energy made during the light-dependent reactions, and that energy is
            carried by <strong>ATP.</strong>
          </p>
        </ComparisonPanel>
        <span className="comparison-vs" aria-hidden="true" data-motion="comparison-vs">
          vs.
        </span>
        <ComparisonPanel
          badge="Guided learning"
          footer="Student reasons through the concept before choosing."
          responseLabel="Chandra"
          title="With Chandra"
          tone="success"
        >
          <p>
            Start by sorting the choices by their job: two are gases, one carries high-energy
            electrons, and one is the cell&apos;s short-term energy carrier. Which choice matches the
            molecule that would power the Calvin cycle?
          </p>
          <div className="comparison-chip-row">
            <span>
              <CheckIcon />
              Requires attempt
            </span>
            <span>
              <ShieldIcon />
              No final answers
            </span>
          </div>
        </ComparisonPanel>
      </div>
    </article>
  );
}

function ComparisonPanel({
  badge,
  children,
  footer,
  responseLabel,
  title,
  tone
}: {
  badge: string;
  children: ReactNode;
  footer: string;
  responseLabel: string;
  title: string;
  tone: "success" | "warning";
}) {
  return (
    <section className={`comparison-panel ${tone}`} data-motion="comparison-panel">
      <div className="comparison-panel-head" data-motion="comparison-panel-head">
        <h3>{title}</h3>
        <span>{badge}</span>
      </div>
      <div className="comparison-dialogue" data-motion="comparison-student">
        <span className="comparison-avatar">S</span>
        <div>
          <p className="comparison-meta">Student asks:</p>
          <p className="comparison-question">&ldquo;I&apos;m stuck on #3. Where do I start?&rdquo;</p>
        </div>
      </div>
      <ProblemCard />
      <div className="comparison-dialogue comparison-response-row" data-motion="comparison-response">
        <span className="comparison-avatar response">{responseLabel === "Chandra" ? "C" : "AI"}</span>
        <div className="comparison-response">
          <p className="comparison-meta">{responseLabel} response:</p>
          {children}
        </div>
      </div>
      <div className="comparison-strip" data-motion="comparison-strip">
        {tone === "success" ? <CheckIcon /> : <AlertIcon />}
        <span>{footer}</span>
      </div>
    </section>
  );
}

function ProblemCard() {
  return (
    <div className="comparison-problem" data-motion="comparison-problem">
      <p>Problem #3</p>
      <span>Which molecule stores energy that is used to power the Calvin cycle?</span>
      <ol type="A">
        <li>O<sub>2</sub></li>
        <li>NADPH</li>
        <li>ATP</li>
        <li>CO<sub>2</sub></li>
      </ol>
    </div>
  );
}

function AudiencePanel({
  icon: Icon,
  id,
  items,
  title
}: {
  icon: IconComponent;
  id: string;
  items: string[];
  title: string;
}) {
  return (
    <article className="audience-panel" id={id}>
      <span className="audience-icon">
        <Icon />
      </span>
      <div>
        <h2>{title}</h2>
        <ul>
          {items.map((item) => (
            <li key={item}>
              <CheckIcon />
              {item}
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}

type IconComponent = () => ReactElement;

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

function IconSvg({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9">
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

function PlayIcon() {
  return (
    <IconSvg>
      <circle cx="12" cy="12" r="9" />
      <path d="M10 8.8v6.4l5-3.2-5-3.2Z" />
    </IconSvg>
  );
}

function ShieldIcon() {
  return (
    <IconSvg>
      <path d="M12 3l7 3v5.3c0 4.4-2.8 7.5-7 9.7-4.2-2.2-7-5.3-7-9.7V6l7-3Z" />
      <path d="M9.5 12l1.7 1.7 3.6-4" />
    </IconSvg>
  );
}

function UsersIcon() {
  return (
    <IconSvg>
      <path d="M16 20c0-2.2-1.8-4-4-4H8c-2.2 0-4 1.8-4 4" />
      <circle cx="10" cy="8" r="4" />
      <path d="M20 19c0-1.8-1-3.2-2.5-3.8" />
      <path d="M17 4.5a3.5 3.5 0 0 1 0 6.8" />
    </IconSvg>
  );
}

function BookIcon() {
  return (
    <IconSvg>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5v-16Z" />
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 8H20" />
      <path d="M10 3v11l2-1.4 2 1.4V3" />
    </IconSvg>
  );
}

function UserCircleIcon() {
  return (
    <IconSvg>
      <circle cx="12" cy="8" r="4" />
      <path d="M5 21c.8-4 3.1-6 7-6s6.2 2 7 6" />
    </IconSvg>
  );
}

function DocumentIcon() {
  return (
    <IconSvg>
      <path d="M7 3h7l4 4v14H7V3Z" />
      <path d="M14 3v5h5" />
      <path d="M10 13h5" />
      <path d="M10 17h4" />
    </IconSvg>
  );
}

function ShieldCheckIcon() {
  return (
    <IconSvg>
      <path d="M12 3l7 3v5.4c0 4.2-2.8 7.3-7 9.6-4.2-2.3-7-5.4-7-9.6V6l7-3Z" />
      <path d="M9 12l2 2 4-4" />
    </IconSvg>
  );
}

function UploadIcon() {
  return (
    <IconSvg>
      <path d="M12 15V4" />
      <path d="M8 8l4-4 4 4" />
      <path d="M6 15.5a4 4 0 0 0 0 8h12a4 4 0 0 0 .4-8" />
    </IconSvg>
  );
}

function SlidersIcon() {
  return (
    <IconSvg>
      <path d="M4 7h10" />
      <path d="M18 7h2" />
      <circle cx="16" cy="7" r="2" />
      <path d="M4 17h3" />
      <path d="M11 17h9" />
      <circle cx="9" cy="17" r="2" />
      <path d="M4 12h5" />
      <path d="M13 12h7" />
      <circle cx="11" cy="12" r="2" />
    </IconSvg>
  );
}

function ChatIcon() {
  return (
    <IconSvg>
      <path d="M7 18l-4 3V8c0-2.8 2.2-5 5-5h8c2.8 0 5 2.2 5 5v5c0 2.8-2.2 5-5 5H7Z" />
    </IconSvg>
  );
}

function ChartIcon() {
  return (
    <IconSvg>
      <path d="M5 20V9" />
      <path d="M12 20V4" />
      <path d="M19 20v-7" />
      <path d="M3 20h18" />
    </IconSvg>
  );
}

function TeacherBoardIcon() {
  return (
    <IconSvg>
      <path d="M4 5h16v10H4V5Z" />
      <path d="M8 19l4-4 4 4" />
      <path d="M12 15v6" />
      <path d="M8 9h4" />
      <path d="M8 12h7" />
    </IconSvg>
  );
}

function CheckIcon() {
  return (
    <IconSvg>
      <path d="M5 12.5l4 4L19 6" />
    </IconSvg>
  );
}

function AlertIcon() {
  return (
    <IconSvg>
      <path d="M12 4l9 16H3l9-16Z" />
      <path d="M12 9v5" />
      <path d="M12 17h.01" />
    </IconSvg>
  );
}
