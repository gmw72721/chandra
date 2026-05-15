"use client";

import type { ReactElement, ReactNode } from "react";
import { useMemo, useState } from "react";

type GuidanceKey = "hint" | "action" | "explain";
type SubjectKey = "biology" | "math" | "chemistry";
type GuidanceCombination =
  | "hint"
  | "action"
  | "explain"
  | "hint+action"
  | "hint+explain"
  | "action+explain"
  | "hint+action+explain";

type ProblemOption = {
  label: string;
  text: ReactNode;
};

type SubjectExample = {
  label: string;
  problem: ReactNode;
  options?: ProblemOption[];
  normalResponse: ReactNode;
  guidance: Record<GuidanceCombination, string>;
};

const guidanceButtons: { key: GuidanceKey; label: string }[] = [
  { key: "hint", label: "Hint" },
  { key: "action", label: "Action" },
  { key: "explain", label: "Explain" }
];

const subjectExamples: Record<SubjectKey, SubjectExample> = {
  biology: {
    label: "Biology",
    problem: "Which molecule provides the energy used to power the Calvin cycle?",
    options: [
      { label: "A", text: <>O<sub>2</sub></> },
      { label: "B", text: "ATP" },
      { label: "C", text: <>CO<sub>2</sub></> },
      { label: "D", text: "Glucose" }
    ],
    normalResponse: (
      <>
        The answer is <strong>B. ATP.</strong> The Calvin cycle uses ATP as an energy source while building sugars.
      </>
    ),
    guidance: {
      hint: "Look for the choice that cells use as a quick, usable energy carrier.",
      action: "First separate the choices by role: gases, finished sugar, and energy carrier.",
      explain:
        "The Calvin cycle is a building process, so it needs an input that can provide usable energy during the reactions. Match each option to what it does in photosynthesis.",
      "hint+action":
        "Look for the quick energy carrier. Start by sorting out the gases, then compare what remains.",
      "hint+explain":
        "Focus on the option that transfers usable energy inside cells. A good test is whether the molecule is used to power reactions or whether it is something being produced or exchanged.",
      "action+explain":
        "Sort the options by job first. One is a product, two are gases, and one is used by cells to drive reactions. That role should point you toward the best choice.",
      "hint+action+explain":
        "Look for the quick energy carrier, then sort the choices by job. The Calvin cycle builds sugar, so ask which option helps power that building process rather than being a gas or the final sugar."
    }
  },
  math: {
    label: "Math",
    problem: (
      <>
        Solve for x:
        <br />
        4x - 6 = 18
      </>
    ),
    normalResponse: <>Add 6 to both sides to get 4x = 24. Then divide by 4, so x = 6.</>,
    guidance: {
      hint: "Think about which operation you should undo first to start isolating x.",
      action: "Focus on the part outside the x-term first. What would cancel the “minus 6”?",
      explain:
        "Solving means keeping both sides balanced while undoing operations around x in reverse order.",
      "hint+action":
        "To isolate x, undo the outside operation first. Look at the “minus 6” and decide what operation cancels it.",
      "hint+explain":
        "Work backward from the expression around x. Since x is being changed in more than one way, undo the last change first while doing the same thing to both sides.",
      "action+explain":
        "The first move should remove the constant term from the left side. Whatever you do to the left, you must also do to the right to keep the equation balanced.",
      "hint+action+explain":
        "Start by isolating the x-term. Identify the operation that cancels the constant, apply it to both sides, then look at what operation is still attached to x."
    }
  },
  chemistry: {
    label: "Chemistry",
    problem: "Which particle has a negative charge?",
    options: [
      { label: "A", text: "Proton" },
      { label: "B", text: "Neutron" },
      { label: "C", text: "Electron" },
      { label: "D", text: "Nucleus" }
    ],
    normalResponse: (
      <>
        The answer is <strong>C. Electron.</strong> Electrons have a negative charge, protons have a positive charge, and neutrons are neutral.
      </>
    ),
    guidance: {
      hint: "Think about the particle found outside the nucleus of an atom.",
      action:
        "Eliminate any option that is neutral, positive, or names a whole region instead of one particle.",
      explain:
        "Atomic particles are often identified by charge and location. Use those two clues to compare each option before choosing.",
      "hint+action":
        "Look for the particle outside the nucleus. Then remove choices that are neutral, positive, or not a single particle.",
      "hint+explain":
        "Use location as your clue: the negatively charged particle is associated with the space around the nucleus, while the nucleus contains different particles.",
      "action+explain":
        "Sort the choices by charge first, then by whether the option names a particle or a region. That should leave the option that matches “negative charge.”",
      "hint+action+explain":
        "Use both clues together: outside the nucleus and negative charge. Remove the neutral and positive particles, then remove the option that names a region instead of a particle."
    }
  }
};

const subjectOrder: SubjectKey[] = ["biology", "math", "chemistry"];
const guidanceOrder: GuidanceKey[] = ["hint", "action", "explain"];

export function BeforeAfterComparison() {
  const [subjectKey, setSubjectKey] = useState<SubjectKey>("biology");
  const [activeGuidance, setActiveGuidance] = useState<GuidanceKey[]>(["hint"]);

  const subject = subjectExamples[subjectKey];
  const guidanceKey = useMemo(() => {
    return guidanceOrder.filter((key) => activeGuidance.includes(key)).join("+") as GuidanceCombination;
  }, [activeGuidance]);

  function toggleGuidance(key: GuidanceKey) {
    setActiveGuidance((current) => {
      if (current.includes(key)) {
        return current.length === 1 ? current : current.filter((activeKey) => activeKey !== key);
      }

      return guidanceOrder.filter((activeKey) => activeKey === key || current.includes(activeKey));
    });
  }

  return (
    <article className="comparison-card" aria-labelledby="comparison-heading">
      <h2 id="comparison-heading" data-motion="comparison-title">
        <span>Before</span>
        <span aria-hidden="true"> / </span>
        <span>After Chandra</span>
      </h2>
      <div className="comparison-subject-tabs" role="tablist" aria-label="Subject examples" data-motion="comparison-tabs">
        {subjectOrder.map((key) => {
          const isSelected = key === subjectKey;

          return (
            <button
              aria-controls="comparison-panels"
              aria-selected={isSelected}
              className="comparison-subject-button"
              key={key}
              onClick={() => setSubjectKey(key)}
              role="tab"
              type="button"
            >
              {subjectExamples[key].label}
            </button>
          );
        })}
      </div>
      <div className="comparison-grid" id="comparison-panels">
        <ComparisonPanel
          badge="Answer dumping"
          footer="Student gets the answer, but skips the reasoning."
          problem={subject}
          responseLabel="AI"
          title="Without Chandra"
          tone="warning"
        >
          <p>{subject.normalResponse}</p>
        </ComparisonPanel>
        <span className="comparison-vs" aria-hidden="true" data-motion="comparison-vs">
          vs.
        </span>
        <ComparisonPanel
          badge="Guided learning"
          footer="Student reasons through the concept before choosing."
          problem={subject}
          responseLabel="Chandra"
          title="With Chandra"
          tone="success"
        >
          <p>{subject.guidance[guidanceKey]}</p>
          <div className="comparison-guidance-controls" aria-label="Chandra guidance modes">
            {guidanceButtons.map(({ key, label }) => {
              const isPressed = activeGuidance.includes(key);

              return (
                <button
                  aria-pressed={isPressed}
                  className="comparison-guidance-button"
                  key={key}
                  onClick={() => toggleGuidance(key)}
                  type="button"
                >
                  {label}
                </button>
              );
            })}
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
  problem,
  responseLabel,
  title,
  tone
}: {
  badge: string;
  children: ReactNode;
  footer: string;
  problem: SubjectExample;
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
      <ProblemCard problem={problem} />
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

function ProblemCard({ problem }: { problem: SubjectExample }) {
  return (
    <div className="comparison-problem" data-motion="comparison-problem">
      <p>Problem #3</p>
      <span>{problem.problem}</span>
      {problem.options ? (
        <ol type="A">
          {problem.options.map((option) => (
            <li key={option.label}>{option.text}</li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function IconSvg({ children }: { children: ReactElement | ReactElement[] }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.9"
      viewBox="0 0 24 24"
    >
      {children}
    </svg>
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
