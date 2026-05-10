import Link from "next/link";
import type { ReactElement } from "react";
import { AuthNav } from "@/components/AuthNav";

const navLinks = ["Features", "How it works", "Teachers", "Students", "Pricing"];

const trustItems = [
  { icon: ShieldIcon, label: "No credit card required" },
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
          <div className="hero-pill">
            <SparkleIcon />
            <span>Teacher-guided AI for classroom learning</span>
          </div>
          <h1>Teacher-guided AI tutoring that keeps students doing the thinking.</h1>
          <p>
            Chandra helps teachers set tutoring rules, ground AI help in class materials, and
            review where students get stuck—without turning homework into answer copying.
          </p>
          <div className="hero-actions">
            <Link className="landing-primary-button" href="/auth">
              Create account
            </Link>
            <Link className="landing-secondary-button" href="#how-it-works">
              <PlayIcon />
              See how it works
            </Link>
          </div>
          <div className="trust-row" aria-label="Chandra benefits">
            {trustItems.map(({ icon: Icon, label }) => (
              <span key={label}>
                <Icon />
                {label}
              </span>
            ))}
          </div>
        </div>

        <div className="hero-product" aria-label="Chandra tutoring preview">
          <ChatMockup />
          <TeacherControls />
        </div>
      </section>

      <div className="landing-info-grid">
        <section className="below-hero-grid" id="features">
          <div className="section-rule-title">
            <span>WHY CHANDRA</span>
          </div>
          <div className="feature-card-row">
            {features.map(({ icon: Icon, title, copy }) => (
              <article className="feature-card" key={title}>
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

        <section className="steps-section" id="how-it-works">
          <div className="section-rule-title">
            <span>HOW IT WORKS</span>
          </div>
          <div className="step-row">
            {steps.map(({ icon: Icon, label }, index) => (
              <article className="step-card" key={label}>
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

      <section className="audience-grid">
        <AudiencePanel id="teachers" icon={TeacherBoardIcon} title="For teachers" items={teacherItems} />
        <AudiencePanel id="students" icon={UserCircleIcon} title="For students" items={studentItems} />
      </section>

      <section className="cta-band" id="pricing">
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

function ChatMockup() {
  return (
    <article className="chat-mockup">
      <div className="chat-header">
        <span className="chat-header-icon">
          <BookIcon />
        </span>
        <div>
          <h2>Biology Homework</h2>
          <p>Photosynthesis worksheet</p>
        </div>
      </div>
      <div className="chat-message-row student-row">
        <span className="avatar soft">S</span>
        <div className="message-stack">
          <p className="message-meta">Student <span>9:41 AM</span></p>
          <div className="student-bubble">
            I&apos;m stuck on #3. How does light energy get converted to chemical energy?
          </div>
        </div>
      </div>
      <div className="chat-message-row chandra-row">
        <span className="avatar strong">C</span>
        <div className="message-stack">
          <p className="message-meta">Chandra <span>9:41 AM</span></p>
          <div className="chandra-bubble">
            <p>Let&apos;s take the next step together.</p>
            <p>
              Hint: Focus on what happens to light energy in the light-dependent reactions and the
              molecule that stores that energy.
            </p>
          </div>
        </div>
      </div>
      <div className="hint-chip-row">
        <span>
          <SparkleIcon />
          Hint level: Guided step
        </span>
        <span>
          <DocumentIcon />
          Source: Biology Notes, p. 12
        </span>
      </div>
      <div className="mock-input">
        <span>Ask a follow-up question...</span>
        <button type="button" aria-label="Send follow-up question">
          <SendIcon />
        </button>
      </div>
    </article>
  );
}

function TeacherControls() {
  const controls = [
    { icon: LockIcon, title: "Homework mode", copy: "AI help is tailored for homework assignments" },
    { icon: ShieldIcon, title: "No final answers", copy: "Chandra won't provide final answers" },
    { icon: ClipboardIcon, title: "Require student attempt", copy: "Students must attempt before getting help" }
  ];

  return (
    <aside className="teacher-controls-card">
      <div className="teacher-controls-head">
        <h2>Teacher controls</h2>
        <SettingsIcon />
      </div>
      <div className="control-list">
        {controls.map(({ icon: Icon, title, copy }) => (
          <div className="control-item" key={title}>
            <span className="control-icon">
              <Icon />
            </span>
            <div>
              <h3>{title}</h3>
              <p>{copy}</p>
            </div>
            <span className="toggle-on" aria-label={`${title} enabled`} />
          </div>
        ))}
      </div>
    </aside>
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

function SendIcon() {
  return (
    <IconSvg>
      <path d="M21 3L10 14" />
      <path d="M21 3l-7 18-4-7-7-4 18-7Z" />
    </IconSvg>
  );
}

function LockIcon() {
  return (
    <IconSvg>
      <rect x="6" y="10" width="12" height="10" rx="2" />
      <path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10" />
    </IconSvg>
  );
}

function ClipboardIcon() {
  return (
    <IconSvg>
      <path d="M9 4h6l1 2h3v15H5V6h3l1-2Z" />
      <path d="M9 11l2 2 4-4" />
      <path d="M9 17h6" />
    </IconSvg>
  );
}

function SettingsIcon() {
  return (
    <IconSvg>
      <circle cx="12" cy="12" r="3" />
      <path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1a7.5 7.5 0 0 0-1.7-1L14.5 3h-5l-.3 3.1a7.5 7.5 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.5a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.4-1a7.5 7.5 0 0 0 1.7 1l.3 3.1h5l.3-3.1a7.5 7.5 0 0 0 1.7-1l2.4 1 2-3.4-2-1.5c.1-.3.1-.7.1-1Z" />
    </IconSvg>
  );
}
