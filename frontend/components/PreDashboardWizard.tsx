"use client";

import { useState, useRef, type CSSProperties } from "react";
import {
  createTeacherClass,
  updateTeacherClassSettings,
  ensureClassJoinCode
} from "@/lib/classes";
import { updateUserThemePreference } from "@/lib/auth";
import { apiUrl } from "@/lib/api-client";
import { useAuth } from "./AuthProvider";
import {
  defaultTeacherClassAppearance,
  defaultTeacherClassThemeColor,
  defaultTeacherClassThemeMood,
  normalizeTeacherClassAppearance,
  normalizeTeacherClassThemeColor,
  normalizeTeacherClassThemeMood,
  teacherClassThemeColorOptions,
  teacherClassThemeMoodOptions,
  type TeacherClassAppearance,
  type TeacherClassThemeColor,
  type TeacherClassThemeMood
} from "@/lib/class-theme";
import {
  normalizeAnswerPolicySettings,
  normalizeClassModelSettings,
  normalizeNotificationSettings,
  normalizePrivacySettings,
  normalizeResponseFormatSettings,
  normalizeSourceDefaultsSettings,
  normalizeSourceUsageSettings,
  normalizeTutorAccessSettings,
  normalizeTutorBehavior,
  type AnswerPolicySettings,
  type ClassModelSettings,
  type ClassPrivacySettings,
  type NotificationSettings,
  type ResponseFormatSettings,
  type SourceDefaultsSettings,
  type SourceUsageSettings,
  type TutorAccessSettings,
  type TutorBehavior
} from "@/lib/class-settings";
import { tutorKnowledgeKinds, type TutorKnowledgeKind } from "@/lib/tutor-knowledge";

interface PreDashboardWizardProps {
  onComplete: (newClassId: string) => void;
}

type WizardUpload = {
  file: File;
  kind: TutorKnowledgeKind;
};

type WizardMotionDirection = "forward" | "backward";

export function PreDashboardWizard({ onComplete }: PreDashboardWizardProps) {
  const { user, profile } = useAuth();
  const [step, setStep] = useState(1);
  const [maxStepReached, setMaxStepReached] = useState(1);
  const [motionDirection, setMotionDirection] = useState<WizardMotionDirection>("forward");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  // Personal theme
  const [userAppearance, setUserAppearance] = useState<TeacherClassAppearance>(() =>
    normalizeTeacherClassAppearance(profile?.appearance ?? defaultTeacherClassAppearance)
  );
  const [themeColor, setThemeColor] = useState<TeacherClassThemeColor>(() =>
    normalizeTeacherClassThemeColor(profile?.themeColor ?? defaultTeacherClassThemeColor)
  );
  const [themeMood, setThemeMood] = useState<TeacherClassThemeMood>(() =>
    normalizeTeacherClassThemeMood(profile?.themeMood ?? defaultTeacherClassThemeMood)
  );

  // Class Info
  const [className, setClassName] = useState("");
  const [classSection, setClassSection] = useState("");
  const [classSubject, setClassSubject] = useState("General");

  // Tutor Style
  const [tutorStyle, setTutorStyle] = useState("guided");

  // Answer Policy Rules
  const [doNotGiveAnswers, setDoNotGiveAnswers] = useState(true);
  const [requireAttempt, setRequireAttempt] = useState(true);
  const [askGuiding, setAskGuiding] = useState(true);
  const [allowExamples, setAllowExamples] = useState(false);

  // Student Instructions
  const [openingMessage, setOpeningMessage] = useState(
    "Welcome to our AI tutor. Ask me questions about assignments or concepts, and I will help guide you step-by-step."
  );
  const [studentInstructions, setStudentInstructions] = useState(
    "Show your work before asking for help.\nUse class materials when possible.\nBe specific about where you are stuck."
  );
  const [hiddenInstructions, setHiddenInstructions] = useState(
    "Do not give final answers. Ask for the student's next reasoning move and use class materials before generic explanations."
  );

  // Materials Skip/Upload Info
  const [uploadedFiles, setUploadedFiles] = useState<WizardUpload[]>([]);
  const [isUploadingMaterials, setIsUploadingMaterials] = useState(false);
  const [materialUploadStatus, setMaterialUploadStatus] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Join Code Info
  const [joinCode, setJoinCode] = useState("");
  const [studentChatEnabled, setStudentChatEnabled] = useState(true);
  const [inviteCopyStatus, setInviteCopyStatus] = useState<"" | "code" | "link" | "failed">("");

  // Active Class Cache
  const [createdClassId, setCreatedClassId] = useState("");

  const totalSteps = 7;
  const romanNumerals = ["I", "II", "III", "IV", "V", "VI", "VII"];
  const wizardStepMeta = [
    { title: "Theme", nextLabel: "Choose the workspace look" },
    { title: "Class", nextLabel: "Identify the class" },
    { title: "Tutor Style", nextLabel: "Choose tutor behavior" },
    { title: "Rules", nextLabel: "Confirm guardrails" },
    { title: "Instructions", nextLabel: "Refine the voice" },
    { title: "Materials", nextLabel: "Upload materials or skip" },
    { title: "Launch", nextLabel: "Review and launch" }
  ];
  const currentStepMeta = wizardStepMeta[step - 1] ?? wizardStepMeta[0];
  const nextStepMeta = wizardStepMeta[step] ?? null;
  const stepProgressScale = totalSteps > 1 ? (step - 1) / (totalSteps - 1) : 0;
  const wizardMotionStyle = {
    "--wizard-dashboard-shift": `${(step - 1) * -10}px`,
    "--wizard-step-progress-scale": stepProgressScale.toString()
  } as CSSProperties;

  const styleOptions = [
    {
      id: "guided",
      title: "Guided Problem Solving",
      desc: "Helps students break down complex problems line-by-line without doing it for them.",
      num: "I"
    },
    {
      id: "socratic",
      title: "Socratic Dialogues",
      desc: "Responds primarily with insightful questions to make students deduce the answer themselves.",
      num: "II"
    },
    {
      id: "check",
      title: "Check My Work",
      desc: "Analyzes student work steps, points out mathematical or logical errors, and prompts correction.",
      num: "III"
    },
    {
      id: "review",
      title: "Exam Prep & Review",
      desc: "Focuses on testing core concepts, explaining underlying theories, and giving practice questions.",
      num: "IV"
    },
    {
      id: "helper",
      title: "Reading & Material Helper",
      desc: "Summarizes notes, clarifies vocabulary, and cites specific parts of uploaded textbooks.",
      num: "V"
    }
  ];

  async function saveWizardProgressBeforeNavigation() {
    if (step === 1) {
      await saveWizardUserTheme();
    }

    if (createdClassId) {
      if (!className.trim()) {
        throw new Error("Class name is required.");
      }

      await saveWizardClassSettings(createdClassId);
    }
  }

  function goToStep(nextStep: number) {
    setMotionDirection(nextStep > step ? "forward" : "backward");
    setStep(nextStep);
    setMaxStepReached((currentMaxStep) => Math.max(currentMaxStep, nextStep));
  }

  async function handleStepSelect(nextStep: number) {
    if (isLoading || isUploadingMaterials || nextStep === step || nextStep > maxStepReached) {
      return;
    }

    setError("");
    setIsLoading(true);
    try {
      await saveWizardProgressBeforeNavigation();
    } catch (err: any) {
      setError(err?.message || "Failed to save settings before changing steps.");
      setIsLoading(false);
      return;
    }
    setIsLoading(false);
    goToStep(nextStep);
  }

  async function handleNext() {
    setError("");
    if (step === 1) {
      setIsLoading(true);
      try {
        await saveWizardUserTheme();
        if (createdClassId) {
          await saveWizardClassSettings(createdClassId);
        }
        goToStep(2);
      } catch (err: any) {
        setError(err?.message || "Failed to save your theme settings. Please try again.");
      } finally {
        setIsLoading(false);
      }
    } else if (step === 2) {
      if (!className.trim()) {
        setError("Class name is required.");
        return;
      }
      if (createdClassId) {
        setIsLoading(true);
        try {
          await saveWizardClassSettings(createdClassId);
        } catch (err: any) {
          setError(err?.message || "Failed to save class details. Please try again.");
          setIsLoading(false);
          return;
        }
        setIsLoading(false);
      }
      goToStep(3);
    } else if (step === 3) {
      if (createdClassId) {
        setIsLoading(true);
        try {
          await saveWizardClassSettings(createdClassId);
        } catch (err: any) {
          setError(err?.message || "Failed to save tutor style. Please try again.");
          setIsLoading(false);
          return;
        }
        setIsLoading(false);
      }
      goToStep(4);
    } else if (step === 4) {
      if (createdClassId) {
        setIsLoading(true);
        try {
          await saveWizardClassSettings(createdClassId);
        } catch (err: any) {
          setError(err?.message || "Failed to save answer rules. Please try again.");
          setIsLoading(false);
          return;
        }
        setIsLoading(false);
      }
      goToStep(5);
    } else if (step === 5) {
      setIsLoading(true);
      try {
        if (!user || !profile) {
          throw new Error("You must be signed in to set up a class.");
        }

        const classId = createdClassId || (await createTeacherClass({
          name: className.trim(),
          section: classSection.trim() || "Period 1",
          teacherId: user.uid,
          teacherName: profile.displayName || user.email || "Teacher"
        })).id;

        setCreatedClassId(classId);

        await saveWizardClassSettings(classId);

        if (!joinCode) {
          const code = await ensureClassJoinCode(classId);
          setJoinCode(code);
        }

        goToStep(6);
      } catch (err: any) {
        setError(err?.message || "Failed to set up class settings. Please try again.");
      } finally {
        setIsLoading(false);
      }
    } else if (step === 6) {
      setIsUploadingMaterials(true);
      try {
        await uploadSelectedMaterials();
        goToStep(7);
      } catch (err: any) {
        setError(err?.message || "Failed to upload class materials. Please try again.");
      } finally {
        setIsUploadingMaterials(false);
      }
    }
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    if (event.target.files) {
      const filesArray = Array.from(event.target.files).map((file) => ({
        file,
        kind: "Reading" as TutorKnowledgeKind
      }));
      setUploadedFiles((prev) => [...prev, ...filesArray]);
    }
  }

  function handleRemoveFile(idx: number) {
    setUploadedFiles((prev) => prev.filter((_, i) => i !== idx));
  }

  function handleFileKindChange(idx: number, kind: TutorKnowledgeKind) {
    setUploadedFiles((prev) =>
      prev.map((upload, i) => (i === idx ? { ...upload, kind } : upload))
    );
  }

  async function saveWizardClassSettings(classId: string) {
    let styleTitle: TutorBehavior = "Guided problem solving";
    if (tutorStyle === "socratic") styleTitle = "Socratic";
    else if (tutorStyle === "check") styleTitle = "Check my work";
    else if (tutorStyle === "review") styleTitle = "Exam review";
    else if (tutorStyle === "helper") styleTitle = "Reading helper";

    const answerPolicy: AnswerPolicySettings = normalizeAnswerPolicySettings({
      doNotGiveFinalAnswers: doNotGiveAnswers,
      requireStudentAttemptFirst: requireAttempt,
      askGuidingQuestionBeforeExplaining: askGuiding,
      allowWorkedExamples: allowExamples,
      refuseAnswerOnlyRequests: true
    });

    const modelSettings: ClassModelSettings = normalizeClassModelSettings({
      provider: "google",
      model: "gemini-1.5-pro",
      temperature: 0.15,
      maxTokens: 2048,
      topP: 0.95
    });

    const privacySettings: ClassPrivacySettings = normalizePrivacySettings({
      conversationRetention: "indefinite"
    });

    const notificationSettings: NotificationSettings = normalizeNotificationSettings({
      weeklyDigest: false,
      followUpReminders: true,
      newStudentJoinedClass: true
    });

    const responseFormat: ResponseFormatSettings = normalizeResponseFormatSettings({
      oneStepAtATime: true,
      endWithCheckQuestion: true,
      simpleWording: false,
      tutorVoice: "encouraging",
      exampleFrequency: "sometimes",
      mathNotation: "latex"
    });

    const sourceDefaults: SourceDefaultsSettings = normalizeSourceDefaultsSettings({
      activeForStudents: true,
      teacherOnly: false,
      citationsRequired: true,
      priority: "medium",
      answerKeysTeacherReviewOnly: true
    });

    const sourceUsage: SourceUsageSettings = normalizeSourceUsageSettings({
      useClassMaterialsFirst: true,
      citeSourcePages: true,
      askClarificationIfSourceUnclear: true,
      preferredSourceType: "any",
      quoteSourcePassages: true
    });

    const tutorAccess: TutorAccessSettings = normalizeTutorAccessSettings({
      enabled: studentChatEnabled
    });

    await updateTeacherClassSettings({
      classId,
      name: className.trim(),
      section: classSection.trim() || "Period 1",
      appearance: normalizeTeacherClassAppearance(userAppearance),
      themeColor: normalizeTeacherClassThemeColor(themeColor),
      themeMood: normalizeTeacherClassThemeMood(themeMood),
      behaviorTitle: normalizeTutorBehavior(styleTitle),
      behaviorInstructions: [
        `Adopt a teaching style of ${styleTitle}.`,
        `Class subject: ${classSubject}.`,
        hiddenInstructions.trim(),
        studentInstructions.trim()
      ].filter(Boolean).join("\n"),
      defaultAssignmentContext: "",
      openingMessage: openingMessage.trim(),
      studentFacingInstructions: studentInstructions.trim(),
      refusalStyle: "Socratic redirect",
      modelSettings,
      answerPolicy,
      privacySettings,
      notificationSettings,
      responseFormat,
      sourceDefaults,
      sourceUsage,
      tutorAccess
    });
  }

  async function saveWizardUserTheme() {
    if (!user) {
      throw new Error("Sign in to save your theme.");
    }

    await updateUserThemePreference({
      appearance: normalizeTeacherClassAppearance(userAppearance),
      themeColor: normalizeTeacherClassThemeColor(themeColor),
      themeMood: normalizeTeacherClassThemeMood(themeMood),
      uid: user.uid
    });
  }

  async function uploadSelectedMaterials() {
    if (uploadedFiles.length === 0) {
      return;
    }

    if (!createdClassId) {
      throw new Error("Create the class before uploading materials.");
    }

    if (!user) {
      throw new Error("Sign in as the class teacher to upload materials.");
    }

    const token = await user.getIdToken();

    for (const [index, upload] of uploadedFiles.entries()) {
      const { file } = upload;
      validateWizardMaterialFile(file);
      setMaterialUploadStatus(`Uploading ${index + 1} of ${uploadedFiles.length}: ${file.name}`);

      const formData = new FormData();
      formData.append("classId", createdClassId);
      formData.append("materialId", createWizardMaterialId());
      formData.append("jobId", createWizardMaterialJobId());
      formData.append("title", titleFromFileName(file.name));
      formData.append("kind", upload.kind);
      formData.append("text", "");
      formData.append("sourceUrl", "");
      formData.append("file", file);

      const response = await fetch(apiUrl("/api/materials"), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`
        },
        body: formData
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };

      if (!response.ok) {
        throw new Error(data.error ?? `Failed to upload ${file.name}.`);
      }
    }

    setMaterialUploadStatus(
      uploadedFiles.length === 1
        ? "Class material uploaded."
        : `${uploadedFiles.length} class materials uploaded.`
    );
  }

  async function handleFinish() {
    if (createdClassId) {
      setIsLoading(true);
      try {
        await saveWizardClassSettings(createdClassId);
      } catch (err: any) {
        setError(err?.message || "Failed to save launch settings. Please try again.");
        setIsLoading(false);
        return;
      }
      setIsLoading(false);
      onComplete(createdClassId);
    }
  }

  async function copyInvite(kind: "code" | "link") {
    const value =
      kind === "code"
        ? joinCode
        : `${window.location.origin}/auth?mode=signup&role=student&classId=${encodeURIComponent(joinCode)}`;

    if (!value) {
      setInviteCopyStatus("failed");
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      setInviteCopyStatus(kind);
      window.setTimeout(() => setInviteCopyStatus(""), 1800);
    } catch {
      setInviteCopyStatus("failed");
    }
  }

  return (
      <div
        className="wizard-backdrop"
        data-appearance={userAppearance}
        data-theme-color={themeColor}
        data-theme-mood={themeMood}
        data-motion-direction={motionDirection}
        style={wizardMotionStyle}
      >
      <div className="wizard-dashboard-backdrop" aria-hidden="true">
        <div className="wizard-dashboard-shell">
          <aside className="wizard-dashboard-sidebar">
            <span className="wizard-dashboard-logo" />
            <span />
            <span />
            <span />
            <span />
          </aside>
          <main className="wizard-dashboard-main">
            <div className="wizard-dashboard-topbar">
              <span />
              <span />
            </div>
            <div className="wizard-dashboard-grid">
              <section className="wizard-dashboard-panel tall">
                <span />
                <strong />
                <i />
                <i />
                <i />
              </section>
              <section className="wizard-dashboard-panel">
                <span />
                <strong />
                <i />
              </section>
              <section className="wizard-dashboard-panel">
                <span />
                <strong />
                <i />
              </section>
              <section className="wizard-dashboard-panel wide">
                <span />
                <strong />
                <i />
                <i />
                <i />
              </section>
            </div>
          </main>
        </div>
      </div>
      <div className="wizard-container">
        <div className="wizard-steps-header" aria-label="Setup progress">
          <div className="wizard-step-track">
            <div className="wizard-step-rail" aria-hidden="true">
              <span />
            </div>
            {Array.from({ length: totalSteps }).map((_, i) => {
              const stepNum = i + 1;
              const canSelectStep = stepNum !== step && stepNum <= maxStepReached && !isLoading && !isUploadingMaterials;
              return (
                <button
                  key={i}
                  className={`wizard-step-indicator ${
                    step === stepNum
                      ? "active"
                      : step > stepNum
                      ? "completed"
                      : ""
                  } ${canSelectStep ? "available" : ""}`}
                  aria-current={step === stepNum ? "step" : undefined}
                  aria-label={canSelectStep ? `Go to step ${stepNum} of ${totalSteps}` : `Step ${stepNum} of ${totalSteps}`}
                  disabled={!canSelectStep}
                  title={canSelectStep ? `Go to step ${stepNum}` : undefined}
                type="button"
                onClick={() => void handleStepSelect(stepNum)}
              >
                <span className="wizard-step-roman">{romanNumerals[i]}</span>
                <span className="wizard-step-name">{wizardStepMeta[i]?.title}</span>
              </button>
            );
          })}
        </div>
        <div className="wizard-flow-context">
            <span className="wizard-flow-count">Step {step} of {totalSteps}</span>
            <span className="wizard-mobile-step-label">{step} of {totalSteps}: {currentStepMeta.title}</span>
            <strong>{currentStepMeta.title}</strong>
            <em>{nextStepMeta ? `Next: ${nextStepMeta.nextLabel}` : "Ready for the dashboard"}</em>
          </div>
        </div>

        {/* Step 1: Theme */}
        {step === 1 && (
          <div className="wizard-step fade-in">
            <header className="wizard-header">
              <span className="wizard-badge">Your Workspace</span>
              <h2>Choose the workspace look</h2>
            </header>

            <div className="wizard-theme-panel">
              <div className="wizard-theme-group">
                <span className="wizard-theme-label">Appearance</span>
                <div className="wizard-toggle-row" role="radiogroup" aria-label="Appearance">
                  {(["light", "dark"] as TeacherClassAppearance[]).map((appearance) => (
                    <button
                      aria-pressed={userAppearance === appearance}
                      className="wizard-choice-pill"
                      key={appearance}
                      type="button"
                      onClick={() => setUserAppearance(appearance)}
                    >
                      {appearance === "dark" ? "Dark" : "Light"}
                    </button>
                  ))}
                </div>
              </div>

              <div className="wizard-theme-group">
                <span className="wizard-theme-label">Accent color</span>
                <div className="wizard-color-grid" role="radiogroup" aria-label="Accent color">
                  {teacherClassThemeColorOptions.map((option) => (
                    <button
                      aria-pressed={themeColor === option.id}
                      className="wizard-color-choice"
                      key={option.id}
                      type="button"
                      onClick={() => setThemeColor(option.id)}
                    >
                      <span style={{ backgroundColor: userAppearance === "dark" ? option.darkColor : option.color }} aria-hidden="true" />
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="wizard-theme-group">
                <span className="wizard-theme-label">Mood</span>
                <div className="wizard-mood-grid" role="radiogroup" aria-label="Mood">
                  {teacherClassThemeMoodOptions.map((option) => (
                    <button
                      aria-pressed={themeMood === option.id}
                      className="wizard-mood-choice"
                      key={option.id}
                      type="button"
                      onClick={() => setThemeMood(option.id)}
                    >
                      <div className="wizard-mood-preview" data-preview-mood={option.id} aria-hidden="true">
                        <span />
                        <span />
                        <span />
                      </div>
                      <div className="wizard-mood-copy">
                        <strong>{option.label}</strong>
                        <span>{option.description}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {error && <div className="wizard-error">{error}</div>}

            <div className="wizard-footer">
              <button type="button" onClick={handleNext} className="wizard-btn-primary" disabled={isLoading}>
                {isLoading ? "Saving" : "Continue"}
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Welcome & Create Class */}
        {step === 2 && (
          <div className="wizard-step fade-in">
            <header className="wizard-header">
              <span className="wizard-badge">Academic Onboarding</span>
              <h2>Identify the class</h2>
              <p>
                Chandra helps teachers provide high-impact, guided tutoring. Students get <strong>guided help, not direct answers</strong>.
              </p>
            </header>

            <form onSubmit={(e) => { e.preventDefault(); handleNext(); }} className="wizard-form">
              <div className="wizard-input-group">
                <label htmlFor="className">Class Name <span className="req">*</span></label>
                <input
                  id="className"
                  type="text"
                  placeholder="e.g., Algebra 2"
                  value={className}
                  onChange={(e) => setClassName(e.target.value)}
                  required
                  autoFocus
                />
              </div>

              <div className="wizard-input-group">
                <label htmlFor="classSection">Section / Period</label>
                <input
                  id="classSection"
                  type="text"
                  placeholder="e.g., Period 3"
                  value={classSection}
                  onChange={(e) => setClassSection(e.target.value)}
                />
              </div>

              <div className="wizard-input-group">
                <label htmlFor="classSubject">Subject</label>
                <select
                  id="classSubject"
                  value={classSubject}
                  onChange={(e) => setClassSubject(e.target.value)}
                >
                  <option>General</option>
                  <option>Math</option>
                  <option>English</option>
                  <option>Science</option>
                  <option>History</option>
                  <option>Computer Science</option>
                </select>
              </div>

              {error && <div className="wizard-error">{error}</div>}

              <div className="wizard-footer">
                <button type="submit" className="wizard-btn-primary">
                  Continue
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Step 3: Choose Tutor Style */}
        {step === 3 && (
          <div className="wizard-step fade-in">
            <header className="wizard-header">
              <span className="wizard-badge">Tutor Persona</span>
              <h2>Choose tutor behavior</h2>
              <p>Select the pedagogical model that matches your classroom style.</p>
            </header>

            <div className="wizard-style-grid">
              {styleOptions.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`wizard-style-card ${tutorStyle === opt.id ? "selected" : ""}`}
                  onClick={() => setTutorStyle(opt.id)}
                >
                  <span className="wizard-style-num">{opt.num}</span>
                  <div className="wizard-style-content">
                    <strong>{opt.title}</strong>
                    <span>{opt.desc}</span>
                  </div>
                </button>
              ))}
            </div>

            <div className="wizard-footer">
              <button type="button" onClick={() => goToStep(2)} className="wizard-btn-secondary">
                Back
              </button>
              <button type="button" onClick={handleNext} className="wizard-btn-primary">
                Continue
              </button>
            </div>
          </div>
        )}

        {/* Step 4: Set Answer Rules */}
        {step === 4 && (
          <div className="wizard-step fade-in">
            <header className="wizard-header">
              <span className="wizard-badge">Pedagogical Guardrails</span>
              <h2>Confirm guardrails</h2>
              <p>Configure strict boundaries to ensure Chandra helps students learn without cheating.</p>
            </header>

            <div className="wizard-rules-container">
              <label className="editorial-checkbox">
                <input
                  type="checkbox"
                  checked={doNotGiveAnswers}
                  onChange={(e) => setDoNotGiveAnswers(e.target.checked)}
                />
                <span className="checkbox-box" />
                <div className="checkbox-text">
                  <strong>Do not give final answers</strong>
                  <span>Chandra will never output the direct final result, prompting students to take the last step.</span>
                </div>
              </label>

              <label className="editorial-checkbox">
                <input
                  type="checkbox"
                  checked={requireAttempt}
                  onChange={(e) => setRequireAttempt(e.target.checked)}
                />
                <span className="checkbox-box" />
                <div className="checkbox-text">
                  <strong>Require student attempt first</strong>
                  <span>Students must show their work or explain their thoughts before getting direct help.</span>
                </div>
              </label>

              <label className="editorial-checkbox">
                <input
                  type="checkbox"
                  checked={askGuiding}
                  onChange={(e) => setAskGuiding(e.target.checked)}
                />
                <span className="checkbox-box" />
                <div className="checkbox-text">
                  <strong>Ask guiding questions</strong>
                  <span>Always prompt students to take the next step instead of explaining too much at once.</span>
                </div>
              </label>

              <label className="editorial-checkbox">
                <input
                  type="checkbox"
                  checked={allowExamples}
                  onChange={(e) => setAllowExamples(e.target.checked)}
                />
                <span className="checkbox-box" />
                <div className="checkbox-text">
                  <strong>Allow worked examples</strong>
                  <span>Allow Chandra to give similar worked examples or block them to force direct conceptual learning.</span>
                </div>
              </label>
            </div>

            {error && <div className="wizard-error">{error}</div>}

            <div className="wizard-footer">
              <button
                type="button"
                onClick={() => goToStep(3)}
                className="wizard-btn-secondary"
                disabled={isLoading}
              >
                Back
              </button>
              <button
                type="button"
                onClick={handleNext}
                className="wizard-btn-primary"
                disabled={isLoading}
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {/* Step 5: Instructions */}
        {step === 5 && (
          <div className="wizard-step fade-in">
            <header className="wizard-header">
              <span className="wizard-badge">Class Instructions</span>
              <h2>Refine the voice</h2>
              <p>Keep student-facing copy clear, then add hidden teacher-only instructions for Chandra.</p>
            </header>

            <div className="wizard-rules-container">
              <div className="wizard-input-group">
                <label>Opening message students see</label>
                <input
                  type="text"
                  value={openingMessage}
                  onChange={(e) => setOpeningMessage(e.target.value)}
                />
              </div>

              <div className="wizard-input-group">
                <label>Student-facing instructions</label>
                <textarea
                  rows={3}
                  value={studentInstructions}
                  onChange={(e) => setStudentInstructions(e.target.value)}
                />
              </div>

              <div className="wizard-input-group">
                <label>Hidden tutor instructions</label>
                <textarea
                  rows={5}
                  value={hiddenInstructions}
                  onChange={(e) => setHiddenInstructions(e.target.value)}
                />
              </div>
            </div>

            {error && <div className="wizard-error">{error}</div>}

            <div className="wizard-footer">
              <button
                type="button"
                onClick={() => goToStep(4)}
                className="wizard-btn-secondary"
                disabled={isLoading}
              >
                Back
              </button>
              <button
                type="button"
                onClick={handleNext}
                className="wizard-btn-primary"
                disabled={isLoading}
              >
                {isLoading ? "Saving class..." : createdClassId ? "Save & Continue" : "Create Class"}
              </button>
            </div>
          </div>
        )}

        {/* Step 6: Add Class Materials */}
        {step === 6 && (
          <div className="wizard-step fade-in">
            <header className="wizard-header">
              <span className="wizard-badge">Tutor Knowledge</span>
              <h2>Upload materials or skip</h2>
              <p>
                Upload PDFs, homework assignments, notes, or textbook excerpts.
                <strong> Chandra can cite these sources directly while tutoring.</strong>
              </p>
            </header>

            <div className="wizard-uploader-container">
              <div
                className="wizard-dropzone"
                onClick={() => fileInputRef.current?.click()}
              >
                <span className="wizard-upload-icon">📖</span>
                <strong>Click to browse materials</strong>
                <span>Supports PDF, TXT, MD, CSV</span>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".pdf,.txt,.md,.csv"
                  style={{ display: "none" }}
                  onChange={handleFileChange}
                />
              </div>

              {uploadedFiles.length > 0 && (
                <div className="wizard-file-list">
                  {uploadedFiles.map((upload, i) => (
                    <div key={i} className="wizard-file-row">
                      <span className="wizard-file-name">📄 {upload.file.name}</span>
                      <select
                        aria-label={`Source type for ${upload.file.name}`}
                        className="wizard-file-kind"
                        value={upload.kind}
                        onChange={(event) => handleFileKindChange(i, event.target.value as TutorKnowledgeKind)}
                      >
                        {tutorKnowledgeKinds.map((kind) => (
                          <option key={kind} value={kind}>
                            {kind === "Practice Solutions" ? "Answer Key" : kind}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="wizard-file-remove"
                        onClick={() => handleRemoveFile(i)}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {materialUploadStatus && <div className="wizard-status">{materialUploadStatus}</div>}
            {error && <div className="wizard-error">{error}</div>}

            <div className="wizard-footer">
              <button
                type="button"
                onClick={() => goToStep(7)}
                className="wizard-btn-secondary"
                disabled={isUploadingMaterials}
              >
                Skip for now
              </button>
              <button
                type="button"
                onClick={handleNext}
                className="wizard-btn-primary"
                disabled={isUploadingMaterials}
              >
                {isUploadingMaterials ? "Uploading..." : "Upload & Continue"}
              </button>
            </div>
          </div>
        )}

        {/* Step 7: Preview & Invite */}
        {step === 7 && (
          <div className="wizard-step fade-in">
            <header className="wizard-header">
              <span className="wizard-badge">Launch</span>
              <h2>Review and launch</h2>
              <p>Confirm the workspace, copy the invite, and open the dashboard.</p>
            </header>

            <label className="editorial-checkbox wizard-access-toggle">
              <input
                type="checkbox"
                checked={studentChatEnabled}
                onChange={(event) => setStudentChatEnabled(event.target.checked)}
              />
              <span className="checkbox-box" />
              <div className="checkbox-text">
                <strong>Allow students to start chatting now</strong>
                <span>Turn this off if you want to review materials or settings before students send messages.</span>
              </div>
            </label>

            <div className="wizard-launch-review" aria-label="Launch review">
              <div className="wizard-review-item">
                <span aria-hidden="true">✓</span>
                <div>
                  <strong>Theme set</strong>
                  <em>{userAppearance === "dark" ? "Dark" : "Light"} workspace, {themeColor} accent, {themeMood} mood</em>
                </div>
              </div>
              <div className="wizard-review-item">
                <span aria-hidden="true">✓</span>
                <div>
                  <strong>Class created</strong>
                  <em>{className.trim() || "Class"}{classSection.trim() ? `, ${classSection.trim()}` : ""}</em>
                </div>
              </div>
              <div className="wizard-review-item">
                <span aria-hidden="true">✓</span>
                <div>
                  <strong>Tutor rules active</strong>
                  <em>{doNotGiveAnswers ? "Final answers blocked" : "Final answer blocking off"}, {requireAttempt ? "attempt required" : "attempt optional"}</em>
                </div>
              </div>
              <div className="wizard-review-item">
                <span aria-hidden="true">✓</span>
                <div>
                  <strong>{uploadedFiles.length > 0 ? "Materials ready" : "Materials skipped"}</strong>
                  <em>{uploadedFiles.length > 0 ? `${uploadedFiles.length} source${uploadedFiles.length === 1 ? "" : "s"} selected` : "You can add sources later"}</em>
                </div>
              </div>
              <div className="wizard-review-item">
                <span aria-hidden="true">✓</span>
                <div>
                  <strong>Student chat {studentChatEnabled ? "on" : "off"}</strong>
                  <em>{studentChatEnabled ? "Students can start once they join" : "You can turn it on from settings"}</em>
                </div>
              </div>
            </div>

            <hr className="wizard-divider" />

            <div className="wizard-invite-card">
              <h3>Invite Students</h3>
              <p>Students can join your class instantly with this code:</p>
              <div className="wizard-invite-row">
                <div className="wizard-code-box">{joinCode || "CODE"}</div>
                <button
                  type="button"
                  className="wizard-btn-secondary compact"
                  disabled={!joinCode}
                  onClick={() => void copyInvite("code")}
                >
                  {inviteCopyStatus === "code" ? "Copied" : "Copy Code"}
                </button>
                <button
                  type="button"
                  className="wizard-btn-secondary compact"
                  disabled={!joinCode}
                  onClick={() => void copyInvite("link")}
                >
                  {inviteCopyStatus === "link" ? "Copied" : "Copy Invite Link"}
                </button>
                <button
                  type="button"
                  className="wizard-btn-secondary compact"
                  onClick={() => {
                    if (createdClassId) {
                      window.open(`/teacher/student-view?classId=${encodeURIComponent(createdClassId)}`, "_blank", "noopener,noreferrer");
                    }
                  }}
                >
                  Open Student Preview
                </button>
              </div>
              {inviteCopyStatus === "failed" ? <p className="wizard-copy-status">Copy failed. Try again.</p> : null}
            </div>

            <div className="wizard-footer">
              <button
                type="button"
                onClick={() => void handleFinish()}
                className="wizard-btn-primary full-width"
                disabled={isLoading}
              >
                {isLoading ? "Saving..." : "Finish & Go to Dashboard"}
              </button>
            </div>
          </div>
        )}
      </div>

      <style jsx global>{`
        .wizard-backdrop {
          position: fixed;
          inset: 0;
          --ease-out-quart: cubic-bezier(0.25, 1, 0.5, 1);
          --ease-out-quint: cubic-bezier(0.22, 1, 0.36, 1);
          --ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);
          --wizard-shadow-color: color-mix(in srgb, var(--wizard-accent, #167c3d) 10%, rgba(44, 42, 33, 0.18));
          --wizard-bg: var(--app-bg-layer, #f7f3e8);
          --wizard-panel: var(--card-bg-strong, #fffdf7);
          --wizard-panel-subtle: var(--card-bg, #fffdf7);
          --wizard-border: color-mix(in srgb, var(--theme-primary, #167c3d) calc(var(--mood-border-strength, 0.9) * 18%), var(--soft-border, #d7d4c7));
          --wizard-text: var(--text-primary, #252a23);
          --wizard-muted: var(--text-muted, #596052);
          --wizard-accent: var(--theme-primary, #167c3d);
          --wizard-accent-strong: var(--theme-primary-strong, #106330);
          --wizard-accent-soft: var(--theme-primary-soft, rgba(22, 124, 61, 0.12));
          --wizard-ring: var(--theme-primary-ring, rgba(22, 124, 61, 0.22));
          background:
            radial-gradient(circle at top left, color-mix(in srgb, var(--wizard-accent) 13%, transparent), transparent 34%),
            linear-gradient(135deg, color-mix(in srgb, var(--wizard-accent-soft) 42%, transparent), transparent 42%),
            var(--wizard-bg);
          z-index: 10000;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          overflow: hidden auto;
          font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          isolation: isolate;
          transition: background-color 180ms var(--ease-out-quart);
        }

        .wizard-dashboard-backdrop {
          display: grid;
          inset: 0;
          opacity: 0.72;
          padding: 28px;
          place-items: center;
          pointer-events: none;
          position: absolute;
          z-index: 0;
        }

        .wizard-dashboard-shell {
          background: color-mix(in srgb, var(--wizard-panel) 86%, var(--wizard-accent-soft));
          border: 1px solid color-mix(in srgb, var(--wizard-accent) 12%, var(--wizard-border));
          border-radius: max(12px, calc(var(--mood-radius, 12px) + 6px));
          box-shadow: 0 34px 90px color-mix(in srgb, var(--wizard-shadow-color) 78%, transparent);
          display: grid;
          filter: blur(12px) saturate(0.96);
          grid-template-columns: 190px minmax(0, 1fr);
          height: min(780px, calc(100vh - 56px));
          max-width: 1180px;
          overflow: hidden;
          transform: translate3d(var(--wizard-dashboard-shift, 0), 0, 0) scale(1.045);
          transition: transform 360ms var(--ease-out-expo), opacity 220ms var(--ease-out-quart);
          width: min(1180px, calc(100vw - 56px));
        }

        .wizard-dashboard-sidebar {
          background: color-mix(in srgb, var(--sidebar-bg, var(--wizard-panel-subtle)) 92%, var(--wizard-accent-soft));
          border-right: 1px solid var(--wizard-border);
          display: grid;
          gap: 18px;
          grid-auto-rows: max-content;
          padding: 28px 22px;
        }

        .wizard-dashboard-sidebar span,
        .wizard-dashboard-topbar span,
        .wizard-dashboard-panel span,
        .wizard-dashboard-panel strong,
        .wizard-dashboard-panel i {
          background: color-mix(in srgb, var(--wizard-accent) 14%, var(--wizard-panel));
          border-radius: 999px;
          display: block;
        }

        .wizard-dashboard-sidebar .wizard-dashboard-logo {
          background: var(--wizard-accent);
          height: 34px;
          width: 92px;
        }

        .wizard-dashboard-sidebar span:not(.wizard-dashboard-logo) {
          height: 13px;
          opacity: 0.58;
          width: 118px;
        }

        .wizard-dashboard-sidebar span:nth-child(4) {
          width: 86px;
        }

        .wizard-dashboard-main {
          display: grid;
          gap: 22px;
          grid-template-rows: auto 1fr;
          min-width: 0;
          padding: 28px;
        }

        .wizard-dashboard-topbar {
          align-items: center;
          display: flex;
          justify-content: space-between;
        }

        .wizard-dashboard-topbar span:first-child {
          height: 28px;
          width: 260px;
        }

        .wizard-dashboard-topbar span:last-child {
          height: 38px;
          width: 152px;
        }

        .wizard-dashboard-grid {
          display: grid;
          gap: 18px;
          grid-template-columns: 1.1fr 0.9fr 0.9fr;
          grid-template-rows: 170px 1fr;
          min-height: 0;
        }

        .wizard-dashboard-panel {
          background: color-mix(in srgb, var(--card-bg-strong, var(--wizard-panel)) 92%, var(--wizard-accent-soft));
          border: 1px solid color-mix(in srgb, var(--wizard-border) 84%, transparent);
          border-radius: max(8px, var(--mood-radius, 12px));
          display: grid;
          gap: 14px;
          grid-auto-rows: max-content;
          padding: 22px;
        }

        .wizard-dashboard-panel.tall {
          grid-row: span 2;
        }

        .wizard-dashboard-panel.wide {
          grid-column: span 2;
        }

        .wizard-dashboard-panel span {
          height: 14px;
          opacity: 0.58;
          width: 112px;
        }

        .wizard-dashboard-panel strong {
          background: color-mix(in srgb, var(--wizard-accent) 28%, var(--wizard-text));
          height: 34px;
          opacity: 0.28;
          width: min(280px, 74%);
        }

        .wizard-dashboard-panel i {
          height: 12px;
          opacity: 0.44;
          width: 88%;
        }

        .wizard-dashboard-panel i:nth-of-type(2) {
          width: 72%;
        }

        .wizard-dashboard-panel i:nth-of-type(3) {
          width: 56%;
        }

        .wizard-container {
          background: var(--wizard-panel);
          border: 1px solid var(--wizard-border);
          border-radius: var(--mood-radius, 12px);
          width: min(100%, 720px);
          max-height: min(920px, calc(100vh - 48px));
          box-shadow:
            0 30px 80px color-mix(in srgb, var(--wizard-shadow-color) 74%, transparent),
            0 1px 0 color-mix(in srgb, var(--wizard-panel) 88%, var(--wizard-accent));
          overflow: hidden;
          display: flex;
          flex-direction: column;
          position: relative;
          contain: layout paint;
          z-index: 1;
        }

        .wizard-steps-header {
          display: grid;
          gap: 12px;
          padding: 16px 32px 14px;
          border-bottom: 1px solid var(--wizard-border);
          background: var(--wizard-panel-subtle);
          position: relative;
          isolation: isolate;
        }

        .wizard-step-track {
          display: flex;
          gap: 10px;
          justify-content: center;
          position: relative;
        }

        .wizard-step-rail {
          background: color-mix(in srgb, var(--wizard-border) 68%, transparent);
          border-radius: 999px;
          height: 2px;
          left: 44px;
          overflow: hidden;
          position: absolute;
          right: 44px;
          top: 50%;
          transform: translateY(-50%);
          z-index: 0;
        }

        .wizard-step-rail span {
          background: linear-gradient(90deg, var(--wizard-accent), color-mix(in srgb, var(--wizard-accent) 46%, var(--wizard-panel)));
          border-radius: inherit;
          display: block;
          height: 100%;
          transform: scaleX(var(--wizard-step-progress-scale, 0));
          transform-origin: left center;
          transition: transform 260ms var(--ease-out-expo);
          width: 100%;
        }

        .wizard-flow-context {
          align-items: center;
          color: var(--wizard-muted);
          display: grid;
          font-size: 0.76rem;
          gap: 10px;
          grid-template-columns: auto 1fr auto;
          line-height: 1.2;
          min-width: 0;
        }

        .wizard-flow-context span {
          color: color-mix(in srgb, var(--wizard-muted) 78%, transparent);
          font-weight: 700;
          text-transform: uppercase;
        }

        .wizard-flow-context strong {
          color: var(--wizard-text);
          font-size: 0.9rem;
          min-width: 0;
        }

        .wizard-flow-context em {
          color: color-mix(in srgb, var(--wizard-accent) 55%, var(--wizard-muted));
          font-style: normal;
          min-width: 0;
          overflow: hidden;
          text-align: right;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .wizard-mobile-step-label {
          display: none;
        }

        .wizard-step-indicator {
          appearance: none;
          border: 1px solid transparent;
          background: var(--wizard-panel-subtle);
          cursor: default;
          font-family: Georgia, serif;
          font-size: 0.84rem;
          font-weight: bold;
          color: color-mix(in srgb, var(--wizard-muted) 45%, transparent);
          align-items: center;
          display: inline-flex;
          gap: 6px;
          justify-content: center;
          min-width: 34px;
          min-height: 32px;
          line-height: 1;
          margin: 0;
          padding: 0 6px;
          position: relative;
          opacity: 1;
          z-index: 1;
          transition:
            color 180ms var(--ease-out-quart),
            background 180ms var(--ease-out-quart),
            border-color 180ms var(--ease-out-quart),
            box-shadow 180ms var(--ease-out-quart),
          transform 180ms var(--ease-out-quart);
        }

        .wizard-step-name {
          font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          font-size: 0.72rem;
          font-weight: 750;
          max-width: 0;
          opacity: 0;
          overflow: hidden;
          text-transform: uppercase;
          transition: max-width 220ms var(--ease-out-expo), opacity 160ms var(--ease-out-quart);
          white-space: nowrap;
        }

        .wizard-step-indicator:disabled {
          cursor: default;
          opacity: 1;
        }

        .wizard-step-indicator.active {
          background: var(--wizard-panel);
          border-color: var(--wizard-accent);
          color: var(--wizard-accent);
          box-shadow:
            0 0 0 4px color-mix(in srgb, var(--wizard-ring) 58%, transparent),
            0 10px 20px color-mix(in srgb, var(--wizard-accent) 10%, transparent);
          text-shadow: none;
          transform: translateY(-1px);
        }

        .wizard-step-indicator.active .wizard-step-name,
        .wizard-step-indicator.available:hover .wizard-step-name,
        .wizard-step-indicator.available:focus-visible .wizard-step-name {
          max-width: 96px;
          opacity: 1;
        }

        .wizard-step-indicator.available {
          color: var(--wizard-muted);
          cursor: pointer;
        }

        .wizard-step-indicator.available:hover {
          background: var(--wizard-accent-soft);
          border-color: var(--wizard-ring);
          color: var(--wizard-accent);
          transform: translateY(-1px);
        }

        .wizard-step-indicator.available:focus-visible {
          outline: 2px solid var(--wizard-ring);
          outline-offset: 2px;
          border-radius: 8px;
        }

        .wizard-step-indicator.completed {
          color: var(--wizard-muted);
        }

        .wizard-step-indicator.completed::after {
          content: "";
          position: absolute;
          bottom: 5px;
          left: 50%;
          transform: translateX(-50%);
          width: 3px;
          height: 3px;
          background: var(--wizard-accent);
          border-radius: 50%;
        }

        .wizard-step {
          flex: 1 1 auto;
          min-height: 0;
          padding: 40px;
          overflow: auto;
          scrollbar-gutter: stable;
          will-change: opacity, transform, filter;
        }

        .wizard-header {
          margin-bottom: 32px;
          text-align: center;
        }

        .wizard-badge {
          display: inline-block;
          font-size: 0.7rem;
          text-transform: uppercase;
          letter-spacing: 0.12em;
          color: var(--wizard-accent);
          background: var(--wizard-accent-soft);
          border: 1px solid var(--wizard-ring);
          padding: 4px 12px;
          border-radius: 4px;
          margin-bottom: 16px;
          font-weight: 600;
        }

        .wizard-header h2 {
          font-family: Georgia, serif;
          font-size: 2rem;
          color: var(--wizard-text);
          margin: 0 0 12px;
          letter-spacing: 0;
          line-height: 1.25;
        }

        .wizard-header p {
          color: var(--wizard-muted);
          font-size: 0.95rem;
          line-height: 1.6;
          margin: 0;
          max-width: 500px;
          margin-left: auto;
          margin-right: auto;
        }

        .wizard-form {
          display: flex;
          flex-direction: column;
          gap: 24px;
        }

        .wizard-input-group {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .wizard-input-group label {
          color: var(--wizard-text);
          font-size: 0.85rem;
          font-weight: 500;
          letter-spacing: 0.02em;
        }

        .wizard-input-group input,
        .wizard-input-group select,
        .wizard-input-group textarea {
          background: var(--input-bg, transparent);
          border: none;
          border-bottom: 1px solid var(--input-border, var(--wizard-border));
          border-radius: 0;
          padding: 10px 0;
          color: var(--wizard-text);
          font-size: 0.98rem;
          transition:
            border-color 180ms var(--ease-out-quart),
            box-shadow 180ms var(--ease-out-quart),
            background 180ms var(--ease-out-quart);
        }

        .wizard-input-group input:focus,
        .wizard-input-group select:focus,
        .wizard-input-group textarea:focus {
          outline: none;
          border-bottom-color: var(--wizard-accent);
        }

        .wizard-style-grid {
          display: flex;
          flex-direction: column;
          gap: 12px;
          max-height: 320px;
          overflow-y: auto;
          padding-right: 4px;
        }

        .wizard-style-card {
          background: var(--wizard-panel-subtle);
          border: 1px solid var(--wizard-border);
          border-radius: var(--mood-radius, 8px);
          padding: 16px;
          display: flex;
          align-items: center;
          gap: 20px;
          text-align: left;
          cursor: pointer;
          position: relative;
          transition:
            background 180ms var(--ease-out-quart),
            border-color 180ms var(--ease-out-quart),
            box-shadow 180ms var(--ease-out-quart),
            transform 180ms var(--ease-out-quart);
        }

        .wizard-style-card:hover {
          background: var(--row-hover-bg, var(--wizard-panel));
          border-color: var(--wizard-ring);
          transform: translateY(-1px);
        }

        .wizard-style-card.selected {
          background: var(--wizard-accent-soft);
          border-color: var(--wizard-accent);
          box-shadow:
            inset 0 0 0 1px color-mix(in srgb, var(--wizard-accent) 22%, transparent),
            0 12px 24px color-mix(in srgb, var(--wizard-accent) 8%, transparent);
        }

        .wizard-style-num {
          font-family: Georgia, serif;
          font-size: 1.2rem;
          color: var(--wizard-accent);
          font-weight: bold;
          min-width: 32px;
          text-align: center;
        }

        .wizard-style-content {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .wizard-style-content strong {
          color: var(--wizard-text);
          font-size: 0.95rem;
        }

        .wizard-style-content span {
          color: var(--wizard-muted);
          font-size: 0.85rem;
          line-height: 1.45;
        }

        .wizard-rules-container {
          display: flex;
          flex-direction: column;
          gap: 16px;
          max-height: 380px;
          overflow-y: auto;
          padding-right: 6px;
        }

        .wizard-theme-panel {
          display: grid;
          gap: var(--mood-section-gap, 24px);
        }

        .wizard-theme-group {
          display: grid;
          gap: 10px;
        }

        .wizard-theme-label {
          color: var(--wizard-text);
          font-size: 0.82rem;
          font-weight: 750;
        }

        .wizard-toggle-row,
        .wizard-color-grid,
        .wizard-mood-grid {
          display: grid;
          gap: 10px;
        }

        .wizard-toggle-row {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        .wizard-color-grid {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }

        .wizard-mood-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        .wizard-choice-pill,
        .wizard-color-choice,
        .wizard-mood-choice {
          min-height: var(--mood-control-height, 40px);
          border: 1px solid var(--wizard-border);
          border-radius: var(--mood-radius, 8px);
          background: var(--wizard-panel-subtle);
          color: var(--wizard-text);
          cursor: pointer;
          font: inherit;
          text-align: left;
          overflow: hidden;
          position: relative;
          transition:
            border-color 180ms var(--ease-out-quart),
            background 180ms var(--ease-out-quart),
            box-shadow 180ms var(--ease-out-quart),
            transform 180ms var(--ease-out-quart);
        }

        .wizard-choice-pill::before,
        .wizard-color-choice::before,
        .wizard-mood-choice::before,
        .wizard-style-card::before,
        .editorial-checkbox::before {
          background: linear-gradient(135deg, color-mix(in srgb, var(--wizard-accent) 13%, transparent), transparent 54%);
          content: "";
          inset: 0;
          opacity: 0;
          pointer-events: none;
          position: absolute;
          transition: opacity 180ms var(--ease-out-quart);
        }

        .wizard-backdrop[data-theme-mood] .wizard-container,
        .wizard-backdrop[data-theme-mood] .wizard-style-card,
        .wizard-backdrop[data-theme-mood] .wizard-file-list,
        .wizard-backdrop[data-theme-mood] .wizard-invite-card,
        .wizard-backdrop[data-theme-mood] .wizard-transcript-container,
        .wizard-backdrop[data-theme-mood] .summary-card {
          border-color: var(--card-border);
          border-radius: var(--mood-radius);
          background: var(--card-bg-strong);
          box-shadow: var(--app-shadow);
        }

        .wizard-backdrop[data-theme-mood] .wizard-container {
          box-shadow:
            0 30px 80px color-mix(in srgb, var(--wizard-shadow-color) 74%, transparent),
            0 1px 0 color-mix(in srgb, var(--card-bg-strong) 88%, var(--wizard-accent));
        }

        .wizard-backdrop[data-theme-mood] .wizard-choice-pill,
        .wizard-backdrop[data-theme-mood] .wizard-color-choice,
        .wizard-backdrop[data-theme-mood] .wizard-mood-choice,
        .wizard-backdrop[data-theme-mood] .wizard-btn-secondary,
        .wizard-backdrop[data-theme-mood] .transcript-input-bar input,
        .wizard-backdrop[data-theme-mood] .transcript-input-bar button {
          min-height: var(--mood-control-height);
          border-color: var(--card-border);
          border-radius: max(6px, calc(var(--mood-radius) - 4px));
          background: var(--card-bg);
        }

        .wizard-backdrop[data-theme-mood] .wizard-input-group input,
        .wizard-backdrop[data-theme-mood] .wizard-input-group select,
        .wizard-backdrop[data-theme-mood] .wizard-input-group textarea,
        .wizard-backdrop[data-theme-mood] .wizard-file-kind-select {
          border-color: var(--input-border);
          border-radius: max(6px, calc(var(--mood-radius) - 4px));
          background: var(--input-bg);
        }

        .wizard-backdrop[data-theme-mood] .wizard-steps-header,
        .wizard-backdrop[data-theme-mood] .transcript-header,
        .wizard-backdrop[data-theme-mood] .transcript-input-bar {
          border-color: var(--card-border);
          background: var(--sidebar-bg);
        }

        .wizard-backdrop[data-theme-mood] .transcript-row {
          border-color: var(--card-border);
          border-radius: max(6px, calc(var(--mood-radius) - 6px));
          background: var(--row-bg);
        }

        .wizard-backdrop[data-theme-mood] .transcript-row:hover {
          background: var(--row-hover-bg);
        }

        .wizard-backdrop[data-theme-mood="calm"] .wizard-choice-pill[aria-pressed="true"],
        .wizard-backdrop[data-theme-mood="calm"] .wizard-color-choice[aria-pressed="true"],
        .wizard-backdrop[data-theme-mood="calm"] .wizard-mood-choice[aria-pressed="true"] {
          box-shadow:
            inset 0 0 0 1px color-mix(in srgb, var(--theme-primary) 12%, transparent),
            var(--app-shadow);
        }

        .wizard-backdrop[data-theme-mood="focused"] .wizard-choice-pill,
        .wizard-backdrop[data-theme-mood="focused"] .wizard-color-choice,
        .wizard-backdrop[data-theme-mood="focused"] .wizard-mood-choice {
          box-shadow: none;
        }

        .wizard-backdrop[data-theme-mood="warm"] .wizard-choice-pill[aria-pressed="true"],
        .wizard-backdrop[data-theme-mood="warm"] .wizard-color-choice[aria-pressed="true"],
        .wizard-backdrop[data-theme-mood="warm"] .wizard-mood-choice[aria-pressed="true"] {
          box-shadow:
            inset 0 0 0 1px color-mix(in srgb, var(--theme-primary) 30%, transparent),
            0 8px 20px rgba(108, 68, 22, 0.08);
        }

        .wizard-backdrop[data-theme-mood="highContrast"] .wizard-container,
        .wizard-backdrop[data-theme-mood="highContrast"] .wizard-choice-pill,
        .wizard-backdrop[data-theme-mood="highContrast"] .wizard-color-choice,
        .wizard-backdrop[data-theme-mood="highContrast"] .wizard-mood-choice,
        .wizard-backdrop[data-theme-mood="highContrast"] .wizard-style-card,
        .wizard-backdrop[data-theme-mood="highContrast"] .wizard-file-list,
        .wizard-backdrop[data-theme-mood="highContrast"] .wizard-invite-card,
        .wizard-backdrop[data-theme-mood="highContrast"] .wizard-transcript-container,
        .wizard-backdrop[data-theme-mood="highContrast"] .summary-card {
          border-width: 2px;
        }

        .wizard-backdrop[data-theme-mood="highContrast"] .wizard-choice-pill[aria-pressed="true"],
        .wizard-backdrop[data-theme-mood="highContrast"] .wizard-color-choice[aria-pressed="true"],
        .wizard-backdrop[data-theme-mood="highContrast"] .wizard-mood-choice[aria-pressed="true"],
        .wizard-backdrop[data-theme-mood="highContrast"] input:focus,
        .wizard-backdrop[data-theme-mood="highContrast"] select:focus,
        .wizard-backdrop[data-theme-mood="highContrast"] textarea:focus {
          border-color: var(--theme-primary);
          box-shadow: 0 0 0 3px var(--focus-ring);
        }

        .wizard-choice-pill,
        .wizard-color-choice {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          font-size: 0.84rem;
          font-weight: 750;
          padding: 0 12px;
        }

        .wizard-color-choice span {
          width: 14px;
          height: 14px;
          border-radius: 50%;
          box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.45);
          position: relative;
          transition: transform 180ms var(--ease-out-quart), box-shadow 180ms var(--ease-out-quart);
        }

        .wizard-mood-choice {
          align-items: center;
          display: grid;
          gap: 12px;
          grid-template-columns: 78px minmax(0, 1fr);
          padding: 14px;
        }

        .wizard-mood-preview {
          background: color-mix(in srgb, var(--wizard-accent-soft) 46%, var(--wizard-panel));
          border: 1px solid color-mix(in srgb, var(--wizard-border) 76%, transparent);
          border-radius: max(6px, calc(var(--mood-radius, 8px) - 2px));
          display: grid;
          gap: 5px;
          grid-template-columns: 18px 1fr;
          grid-template-rows: 10px 10px 10px;
          min-height: 52px;
          padding: 8px;
        }

        .wizard-mood-preview span {
          background: color-mix(in srgb, var(--wizard-accent) 26%, var(--wizard-panel));
          border-radius: 999px;
          display: block;
          height: auto;
          min-width: 0;
          width: auto;
        }

        .wizard-mood-preview span:first-child {
          background: var(--wizard-accent);
          border-radius: 5px;
          grid-row: 1 / 4;
          opacity: 0.72;
        }

        .wizard-mood-preview span:nth-child(2) {
          grid-column: 2;
          opacity: 0.5;
        }

        .wizard-mood-preview span:nth-child(3) {
          grid-column: 2;
          opacity: 0.32;
          width: 72%;
        }

        .wizard-mood-preview[data-preview-mood="focused"] {
          border-color: color-mix(in srgb, var(--wizard-accent) 42%, var(--wizard-border));
          box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--wizard-accent) 18%, transparent);
        }

        .wizard-mood-preview[data-preview-mood="warm"] {
          background: color-mix(in srgb, #c0782f 10%, var(--wizard-panel));
        }

        .wizard-mood-preview[data-preview-mood="highContrast"] {
          background: var(--wizard-panel);
          border-color: var(--wizard-text);
        }

        .wizard-mood-copy {
          display: grid;
          gap: 4px;
          min-width: 0;
        }

        .wizard-mood-copy strong {
          font-size: 0.88rem;
        }

        .wizard-mood-copy span {
          color: var(--wizard-muted);
          font-size: 0.78rem;
          line-height: 1.35;
        }

        .wizard-choice-pill[aria-pressed="true"],
        .wizard-color-choice[aria-pressed="true"],
        .wizard-mood-choice[aria-pressed="true"] {
          background: var(--wizard-accent-soft);
          border-color: var(--wizard-accent);
          box-shadow:
            inset 0 0 0 1px color-mix(in srgb, var(--wizard-accent) 18%, transparent),
            0 0 0 3px color-mix(in srgb, var(--wizard-ring) 72%, transparent);
          transform: translateY(-1px);
        }

        .wizard-choice-pill:hover,
        .wizard-color-choice:hover,
        .wizard-mood-choice:hover {
          border-color: var(--wizard-ring);
          transform: translateY(-1px);
        }

        .wizard-choice-pill:hover::before,
        .wizard-color-choice:hover::before,
        .wizard-mood-choice:hover::before,
        .wizard-choice-pill[aria-pressed="true"]::before,
        .wizard-color-choice[aria-pressed="true"]::before,
        .wizard-mood-choice[aria-pressed="true"]::before,
        .wizard-style-card:hover::before,
        .wizard-style-card.selected::before,
        .editorial-checkbox:hover::before {
          opacity: 1;
        }

        .wizard-color-choice[aria-pressed="true"] span,
        .wizard-color-choice:hover span {
          box-shadow:
            inset 0 0 0 1px rgba(255, 255, 255, 0.52),
            0 0 0 4px color-mix(in srgb, var(--wizard-ring) 65%, transparent);
          transform: scale(1.08);
        }

        .wizard-backdrop[data-theme-mood="calm"] .wizard-choice-pill[aria-pressed="true"],
        .wizard-backdrop[data-theme-mood="calm"] .wizard-color-choice[aria-pressed="true"],
        .wizard-backdrop[data-theme-mood="calm"] .wizard-mood-choice[aria-pressed="true"] {
          box-shadow:
            inset 0 0 0 1px color-mix(in srgb, var(--theme-primary) 18%, transparent),
            0 6px 14px rgba(44, 42, 33, 0.04);
        }

        .wizard-backdrop[data-theme-mood="focused"] .wizard-choice-pill[aria-pressed="true"],
        .wizard-backdrop[data-theme-mood="focused"] .wizard-color-choice[aria-pressed="true"],
        .wizard-backdrop[data-theme-mood="focused"] .wizard-mood-choice[aria-pressed="true"] {
          box-shadow: none;
        }

        .wizard-backdrop[data-theme-mood="warm"] .wizard-choice-pill[aria-pressed="true"],
        .wizard-backdrop[data-theme-mood="warm"] .wizard-color-choice[aria-pressed="true"],
        .wizard-backdrop[data-theme-mood="warm"] .wizard-mood-choice[aria-pressed="true"] {
          box-shadow:
            inset 0 0 0 1px color-mix(in srgb, var(--theme-primary) 26%, transparent),
            0 8px 18px rgba(91, 61, 24, 0.075);
        }

        .wizard-backdrop[data-theme-mood="highContrast"] .wizard-choice-pill[aria-pressed="true"],
        .wizard-backdrop[data-theme-mood="highContrast"] .wizard-color-choice[aria-pressed="true"],
        .wizard-backdrop[data-theme-mood="highContrast"] .wizard-mood-choice[aria-pressed="true"] {
          border-color: var(--theme-primary);
          box-shadow: 0 0 0 3px var(--focus-ring);
        }

        /* Editorial Custom Checkbox */
        .editorial-checkbox {
          display: flex;
          align-items: flex-start;
          gap: 14px;
          padding: 14px 16px;
          background: var(--wizard-panel-subtle);
          border: 1px solid var(--wizard-border);
          border-radius: var(--mood-radius, 8px);
          cursor: pointer;
          overflow: hidden;
          position: relative;
          transition:
            background 180ms var(--ease-out-quart),
            border-color 180ms var(--ease-out-quart),
            transform 180ms var(--ease-out-quart);
        }

        .editorial-checkbox:hover {
          background: var(--row-hover-bg, var(--wizard-panel));
          border-color: var(--wizard-ring);
          transform: translateY(-1px);
        }

        .editorial-checkbox input {
          display: none;
        }

        .checkbox-box {
          width: 18px;
          height: 18px;
          border: 1px solid var(--wizard-border);
          border-radius: 4px;
          background: transparent;
          flex-shrink: 0;
          margin-top: 2px;
          display: flex;
          align-items: center;
          justify-content: center;
          position: relative;
          transition:
            background 160ms var(--ease-out-quart),
            border-color 160ms var(--ease-out-quart),
            box-shadow 160ms var(--ease-out-quart),
            transform 160ms var(--ease-out-quart);
        }

        .editorial-checkbox input:checked + .checkbox-box {
          background: var(--wizard-accent);
          border-color: var(--wizard-accent);
          box-shadow: 0 0 0 3px color-mix(in srgb, var(--wizard-ring) 72%, transparent);
          transform: scale(1.04);
        }

        .editorial-checkbox input:checked + .checkbox-box::after {
          content: "✓";
          color: var(--on-primary, #fff);
          font-size: 0.72rem;
          font-weight: bold;
        }

        .checkbox-text {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .checkbox-text strong {
          color: var(--wizard-text);
          font-size: 0.92rem;
        }

        .checkbox-text span {
          color: var(--wizard-muted);
          font-size: 0.8rem;
          line-height: 1.45;
        }

        .wizard-divider {
          border: 0;
          height: 1px;
          border-top: 1px solid var(--wizard-border);
          margin: 12px 0;
        }

        .wizard-dropzone {
          border: 1.5px dashed var(--wizard-border);
          background: var(--wizard-panel-subtle);
          border-radius: var(--mood-radius, 8px);
          padding: 32px;
          text-align: center;
          cursor: pointer;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 10px;
          transition:
            background 180ms var(--ease-out-quart),
            border-color 180ms var(--ease-out-quart),
            box-shadow 180ms var(--ease-out-quart),
            transform 180ms var(--ease-out-quart);
        }

        .wizard-dropzone:hover {
          border-color: var(--wizard-accent);
          background: var(--wizard-accent-soft);
          box-shadow: 0 10px 24px color-mix(in srgb, var(--wizard-accent) 8%, transparent);
          transform: translateY(-1px);
        }

        .wizard-upload-icon {
          font-size: 2rem;
          color: var(--wizard-accent);
        }

        .wizard-dropzone strong {
          color: var(--wizard-text);
          font-size: 0.95rem;
        }

        .wizard-dropzone span {
          color: var(--wizard-muted);
          font-size: 0.8rem;
        }

        .wizard-file-list {
          margin-top: 16px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .wizard-file-row {
          background: var(--wizard-panel-subtle);
          border: 1px solid var(--wizard-border);
          border-radius: var(--mood-radius, 8px);
          padding: 10px 14px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          animation: wizardItemIn 220ms var(--ease-out-quint) both;
        }

        .wizard-file-name {
          color: var(--wizard-text);
          font-size: 0.85rem;
        }

        .wizard-file-kind {
          min-width: 150px;
          border: 1px solid var(--wizard-border);
          border-radius: 7px;
          background: var(--input-bg, var(--wizard-panel));
          color: var(--wizard-text);
          padding: 7px 8px;
        }

        .wizard-file-remove {
          background: none;
          border: none;
          color: var(--wizard-muted);
          cursor: pointer;
          font-size: 0.85rem;
          transition: color 150ms var(--ease-out-quart), transform 150ms var(--ease-out-quart);
        }

        .wizard-file-remove:hover {
          color: #ff6b6b;
          transform: scale(1.08);
        }

        /* Textbook Dialogue Preview Chat Container */
        .wizard-transcript-container {
          background: var(--wizard-panel-subtle);
          border: 1px solid var(--wizard-border);
          border-radius: var(--mood-radius, 8px);
          overflow: hidden;
          display: flex;
          flex-direction: column;
          height: 250px;
        }

        .transcript-header {
          background: var(--wizard-accent-soft);
          padding: 10px 16px;
          font-size: 0.72rem;
          letter-spacing: 0.1em;
          color: var(--wizard-muted);
          border-bottom: 1px solid var(--wizard-border);
          font-weight: bold;
        }

        .transcript-body {
          flex: 1;
          padding: 18px;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .transcript-row {
          display: flex;
          flex-direction: column;
          gap: 4px;
          animation: messageFadeIn 260ms var(--ease-out-quint) forwards;
        }

        .speaker-label {
          font-size: 0.72rem;
          letter-spacing: 0.08em;
          color: var(--wizard-accent);
          font-weight: bold;
        }

        .transcript-row.student .speaker-label {
          color: var(--wizard-muted);
        }

        .message-content {
          font-family: Georgia, serif;
          font-size: 0.88rem;
          line-height: 1.5;
          color: var(--wizard-text);
          margin: 0;
          padding-left: 6px;
          border-left: 1px solid var(--wizard-border);
        }

        .transcript-row.student .message-content {
          color: var(--wizard-text);
          border-left-color: var(--wizard-accent);
        }

        .transcript-row.loading .message-content {
          color: var(--wizard-muted);
        }

        .italic {
          font-style: italic;
        }

        .transcript-input-bar {
          display: flex;
          border-top: 1px solid var(--wizard-border);
          background: var(--wizard-panel);
        }

        .transcript-input-bar input {
          flex: 1;
          background: transparent;
          border: none;
          padding: 12px 16px;
          color: var(--wizard-text);
          font-size: 0.88rem;
        }

        .transcript-input-bar input:focus {
          outline: none;
        }

        .transcript-input-bar button {
          background: var(--wizard-accent);
          color: var(--on-primary, #fff);
          border: none;
          padding: 0 20px;
          font-size: 0.82rem;
          font-weight: bold;
          cursor: pointer;
          transition:
            background 180ms var(--ease-out-quart),
            transform 150ms var(--ease-out-quart);
        }

        .transcript-input-bar button:hover {
          background: var(--wizard-accent-strong);
          transform: translateX(-1px);
        }

        /* Invite Card */
        .wizard-invite-card {
          background: var(--wizard-panel-subtle);
          border: 1px solid var(--wizard-border);
          border-radius: var(--mood-radius, 8px);
          padding: 20px;
          margin-top: 20px;
        }

        .wizard-invite-card h3 {
          font-family: Georgia, serif;
          color: var(--wizard-text);
          font-size: 1.1rem;
          margin: 0 0 6px;
        }

        .wizard-invite-card p {
          color: var(--wizard-muted);
          font-size: 0.8rem;
          margin: 0 0 14px;
        }

        .wizard-launch-review {
          display: grid;
          gap: 10px;
          margin-top: 18px;
        }

        .wizard-review-item {
          align-items: flex-start;
          background: var(--wizard-panel-subtle);
          border: 1px solid var(--wizard-border);
          border-radius: max(6px, calc(var(--mood-radius, 8px) - 2px));
          display: grid;
          gap: 12px;
          grid-template-columns: auto 1fr;
          padding: 13px 14px;
        }

        .wizard-review-item > span {
          align-items: center;
          background: var(--wizard-accent-soft);
          border: 1px solid var(--wizard-ring);
          border-radius: 999px;
          color: var(--wizard-accent);
          display: inline-flex;
          font-size: 0.72rem;
          font-weight: 900;
          height: 22px;
          justify-content: center;
          line-height: 1;
          width: 22px;
        }

        .wizard-review-item div {
          display: grid;
          gap: 2px;
          min-width: 0;
        }

        .wizard-review-item strong {
          color: var(--wizard-text);
          font-size: 0.9rem;
        }

        .wizard-review-item em {
          color: var(--wizard-muted);
          font-size: 0.8rem;
          font-style: normal;
          line-height: 1.35;
        }

        .wizard-invite-row {
          display: flex;
          gap: 12px;
          align-items: center;
        }

        .wizard-code-box {
          background: var(--input-bg, var(--wizard-panel));
          border: 1px solid var(--wizard-border);
          color: var(--wizard-text);
          font-family: monospace;
          font-size: 1.3rem;
          font-weight: bold;
          padding: 6px 18px;
          border-radius: 4px;
          letter-spacing: 0.05em;
        }

        .wizard-copy-status {
          color: var(--wizard-muted);
          font-size: 0.8rem;
          margin: 10px 0 0;
        }

        /* Buttons & Footer */
        .wizard-footer {
          margin-top: 36px;
          display: flex;
          justify-content: flex-end;
          gap: 12px;
          animation: wizardFooterIn 260ms var(--ease-out-quint) 60ms both;
        }

        .wizard-btn-primary {
          background: var(--wizard-accent);
          color: var(--on-primary, #fff);
          border: 1px solid var(--wizard-accent);
          border-radius: var(--mood-radius, 8px);
          padding: 12px 28px;
          font-size: 0.92rem;
          font-weight: bold;
          cursor: pointer;
          transition:
            background 180ms var(--ease-out-quart),
            border-color 180ms var(--ease-out-quart),
            box-shadow 180ms var(--ease-out-quart),
            transform 150ms var(--ease-out-quart);
        }

        .wizard-btn-primary:hover {
          background: var(--wizard-accent-strong);
          border-color: var(--wizard-accent-strong);
          transform: translateY(-1px);
          box-shadow: 0 0 0 3px var(--wizard-ring);
        }

        .wizard-btn-primary:active,
        .wizard-btn-secondary:active,
        .transcript-input-bar button:active {
          transform: translateY(0) scale(0.985);
        }

        .wizard-btn-primary.full-width {
          width: 100%;
          text-align: center;
        }

        .wizard-btn-secondary {
          background: transparent;
          color: var(--wizard-text);
          border: 1px solid var(--wizard-border);
          border-radius: var(--mood-radius, 8px);
          padding: 12px 28px;
          font-size: 0.92rem;
          font-weight: 500;
          cursor: pointer;
          transition:
            background 180ms var(--ease-out-quart),
            border-color 180ms var(--ease-out-quart),
            color 180ms var(--ease-out-quart),
            transform 150ms var(--ease-out-quart);
        }

        .wizard-btn-secondary:hover {
          background: var(--wizard-panel-subtle);
          border-color: var(--wizard-ring);
          color: var(--wizard-text);
          transform: translateY(-1px);
        }

        .wizard-btn-secondary.compact {
          padding: 8px 16px;
          font-size: 0.82rem;
        }

        .wizard-error {
          color: #ff6b6b;
          font-size: 0.85rem;
          margin-top: 10px;
          background: rgba(255, 107, 107, 0.05);
          border: 1px solid rgba(255, 107, 107, 0.15);
          padding: 10px 14px;
          border-radius: 6px;
        }

        .wizard-status {
          color: var(--wizard-text);
          font-size: 0.85rem;
          margin-top: 10px;
          background: var(--wizard-accent-soft);
          border: 1px solid var(--wizard-ring);
          padding: 10px 14px;
          border-radius: 6px;
        }

        .wizard-btn-primary:disabled,
        .wizard-btn-secondary:disabled {
          cursor: not-allowed;
          opacity: 0.55;
          transform: none;
        }

        .req {
          color: #ff6b6b;
        }

        .fade-in {
          animation: wizardStepForward 280ms var(--ease-out-expo) both;
        }

        .wizard-backdrop[data-motion-direction="backward"] .fade-in {
          animation-name: wizardStepBackward;
        }

        .fade-in > .wizard-header {
          animation: wizardHeaderIn 260ms var(--ease-out-quint) 45ms both;
        }

        .fade-in > .wizard-theme-panel,
        .fade-in > .wizard-form,
        .fade-in > .wizard-style-grid,
        .fade-in > .wizard-rules-container,
        .fade-in > .wizard-uploader-container,
        .fade-in > .wizard-launch-review,
        .fade-in > .wizard-transcript-container,
        .fade-in > .editorial-checkbox,
        .fade-in > .wizard-invite-card {
          animation: wizardContentIn 280ms var(--ease-out-quint) 80ms both;
        }

        @keyframes wizardStepForward {
          from {
            opacity: 0;
            filter: blur(4px);
            transform: translate3d(18px, 0, 0) scale(0.992);
          }
          to {
            opacity: 1;
            filter: blur(0);
            transform: translate3d(0, 0, 0) scale(1);
          }
        }

        @keyframes wizardStepBackward {
          from {
            opacity: 0;
            filter: blur(4px);
            transform: translate3d(-18px, 0, 0) scale(0.992);
          }
          to {
            opacity: 1;
            filter: blur(0);
            transform: translate3d(0, 0, 0) scale(1);
          }
        }

        @keyframes wizardHeaderIn {
          from {
            opacity: 0;
            transform: translate3d(0, 8px, 0);
          }
          to {
            opacity: 1;
            transform: translate3d(0, 0, 0);
          }
        }

        @keyframes wizardContentIn {
          from {
            opacity: 0;
            transform: translate3d(0, 10px, 0);
          }
          to {
            opacity: 1;
            transform: translate3d(0, 0, 0);
          }
        }

        @keyframes wizardFooterIn {
          from {
            opacity: 0;
            transform: translate3d(0, 6px, 0);
          }
          to {
            opacity: 1;
            transform: translate3d(0, 0, 0);
          }
        }

        @keyframes wizardItemIn {
          from {
            opacity: 0;
            transform: translate3d(0, 5px, 0);
          }
          to {
            opacity: 1;
            transform: translate3d(0, 0, 0);
          }
        }

        @keyframes messageFadeIn {
          from {
            opacity: 0;
            transform: translate3d(0, 4px, 0);
          }
          to {
            opacity: 1;
            transform: translate3d(0, 0, 0);
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .wizard-backdrop,
          .wizard-backdrop *,
          .wizard-backdrop *::before,
          .wizard-backdrop *::after {
            animation-duration: 0.01ms !important;
            animation-iteration-count: 1 !important;
            scroll-behavior: auto !important;
            transition-duration: 0.01ms !important;
          }
        }

        @media (max-width: 640px) {
          .wizard-backdrop {
            align-items: stretch;
            padding: 14px;
          }

          .wizard-dashboard-backdrop {
            padding: 10px;
          }

          .wizard-dashboard-shell {
            filter: blur(14px) saturate(0.9);
            grid-template-columns: 68px minmax(0, 1fr);
            height: calc(100vh - 20px);
            opacity: 0.82;
            transform: translate3d(calc(var(--wizard-dashboard-shift, 0) * 0.5), 0, 0) scale(1.06);
            width: calc(100vw - 20px);
          }

          .wizard-dashboard-sidebar {
            padding: 18px 12px;
          }

          .wizard-dashboard-sidebar .wizard-dashboard-logo,
          .wizard-dashboard-sidebar span:not(.wizard-dashboard-logo) {
            width: 42px;
          }

          .wizard-dashboard-main {
            gap: 14px;
            padding: 18px;
          }

          .wizard-dashboard-grid {
            grid-template-columns: 1fr;
            grid-template-rows: repeat(4, 130px);
          }

          .wizard-dashboard-panel.tall,
          .wizard-dashboard-panel.wide {
            grid-column: auto;
            grid-row: auto;
          }

          .wizard-container {
            max-height: calc(100vh - 28px);
          }

          .wizard-steps-header {
            gap: 6px;
            padding-inline: 18px;
          }

          .wizard-step-track {
            display: none;
          }

          .wizard-step-rail {
            left: 28px;
            right: 28px;
          }

          .wizard-flow-context {
            gap: 3px;
            grid-template-columns: 1fr;
            text-align: center;
          }

          .wizard-flow-count,
          .wizard-flow-context strong,
          .wizard-flow-context em {
            display: none;
          }

          .wizard-mobile-step-label {
            color: var(--wizard-text);
            display: block;
            font-size: 0.84rem;
            font-weight: 800;
          }

          .wizard-flow-context em {
            text-align: center;
          }

          .wizard-step {
            padding: 28px 20px;
          }

          .wizard-mood-choice {
            grid-template-columns: 72px minmax(0, 1fr);
          }

          .wizard-color-grid,
          .wizard-mood-grid,
          .settings-mood-pills {
            grid-template-columns: 1fr;
          }

          .wizard-file-row,
          .wizard-invite-row {
            align-items: stretch;
            flex-direction: column;
          }

          .wizard-file-kind {
            width: 100%;
          }
        }
      `}</style>
    </div>
  );
}

const wizardMaterialExtensions = [".pdf", ".txt", ".md", ".csv"];

function validateWizardMaterialFile(file: File) {
  const normalizedName = file.name.toLowerCase();
  const isSupported = wizardMaterialExtensions.some((extension) => normalizedName.endsWith(extension));

  if (!isSupported) {
    throw new Error("Only PDF, TXT, MD, and CSV files are supported.");
  }
}

function titleFromFileName(fileName: string) {
  return fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || fileName || "Class material";
}

function createWizardMaterialJobId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `job_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function createWizardMaterialId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `mat_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
