"use client";

import { useState, useRef, type FormEvent } from "react";
import {
  createTeacherClass,
  updateTeacherClassSettings,
  ensureClassJoinCode
} from "@/lib/classes";
import { useAuth } from "./AuthProvider";
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

interface PreDashboardWizardProps {
  onComplete: (newClassId: string) => void;
}

export function PreDashboardWizard({ onComplete }: PreDashboardWizardProps) {
  const { user, profile } = useAuth();
  const [step, setStep] = useState(1);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  // Class Info
  const [className, setClassName] = useState("");
  const [classSection, setClassSection] = useState("");

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

  // Materials Skip/Upload Info
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Join Code Info
  const [joinCode, setJoinCode] = useState("");

  // Preview Student Chat State
  const [previewMessages, setPreviewMessages] = useState<
    Array<{ role: "student" | "assistant"; content: string }>
  >([
    {
      role: "assistant",
      content: "Hello! I am Chandra, your AI tutor. Ask me any question, and let us solve it together step-by-step."
    }
  ]);
  const [previewInput, setPreviewInput] = useState("");
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);

  // Active Class Cache
  const [createdClassId, setCreatedClassId] = useState("");

  const totalSteps = 5;

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

  async function handleNext() {
    setError("");
    if (step === 1) {
      if (!className.trim()) {
        setError("Class name is required.");
        return;
      }
      setStep(2);
    } else if (step === 2) {
      setStep(3);
    } else if (step === 3) {
      setIsLoading(true);
      try {
        if (!user || !profile) {
          throw new Error("You must be signed in to set up a class.");
        }

        // 1. Create Class
        const newClass = await createTeacherClass({
          name: className.trim(),
          section: classSection.trim() || "Period 1",
          teacherId: user.uid,
          teacherName: profile.displayName || user.email || "Teacher"
        });

        setCreatedClassId(newClass.id);

        // 2. Map Tutor Style to Behavior Title & Instructions
        let styleTitle: TutorBehavior = "Guided problem solving";
        if (tutorStyle === "socratic") styleTitle = "Socratic";
        else if (tutorStyle === "check") styleTitle = "Check my work";
        else if (tutorStyle === "review") styleTitle = "Exam review";
        else if (tutorStyle === "helper") styleTitle = "Reading helper";

        // 3. Save Settings with fully typed models
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
          enabled: true
        });

        await updateTeacherClassSettings({
          classId: newClass.id,
          name: className.trim(),
          section: classSection.trim() || "Period 1",
          appearance: "light",
          themeColor: "teal",
          behaviorTitle: normalizeTutorBehavior(styleTitle),
          behaviorInstructions: `Adopt a teaching style of ${styleTitle}.\n${studentInstructions}`,
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

        const code = await ensureClassJoinCode(newClass.id);
        setJoinCode(code);

        setStep(4);
      } catch (err: any) {
        setError(err?.message || "Failed to set up class settings. Please try again.");
      } finally {
        setIsLoading(false);
      }
    } else if (step === 4) {
      setStep(5);
    }
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    if (event.target.files) {
      const filesArray = Array.from(event.target.files);
      setUploadedFiles((prev) => [...prev, ...filesArray]);
    }
  }

  function handleRemoveFile(idx: number) {
    setUploadedFiles((prev) => prev.filter((_, i) => i !== idx));
  }

  function handleSendPreviewMessage(e: FormEvent) {
    e.preventDefault();
    if (!previewInput.trim() || isPreviewLoading) return;

    const userText = previewInput.trim();
    setPreviewMessages((prev) => [...prev, { role: "student", content: userText }]);
    setPreviewInput("");
    setIsPreviewLoading(true);

    setTimeout(() => {
      let aiResponse = "";
      const lower = userText.toLowerCase();

      if (lower.includes("answer") || lower.includes("solve") || lower.includes("give me")) {
        aiResponse = "I cannot give you the direct answer, but let us work it out together. What do you think is the first step we should take to set up this problem?";
      } else if (tutorStyle === "socratic") {
        aiResponse = "That is an interesting question. What does your intuition say about why that happens? What formula or concept applies here?";
      } else if (tutorStyle === "check") {
        aiResponse = "I would love to check your work. Can you explain the steps you have taken so far? I will pinpoint exactly where they look correct.";
      } else if (tutorStyle === "helper") {
        aiResponse = "Excellent question. Based on our class material, the core concept hinges on the relationship between variables. What page or textbook chapter are you looking at right now?";
      } else {
        aiResponse = "Let us break this down together. To start, what are the known values or key concepts you have identified in the question?";
      }

      setPreviewMessages((prev) => [...prev, { role: "assistant", content: aiResponse }]);
      setIsPreviewLoading(false);
    }, 950);
  }

  function handleFinish() {
    if (createdClassId) {
      onComplete(createdClassId);
    }
  }

  return (
    <div className="wizard-backdrop">
      <div className="wizard-container">
        {/* Editorial Minimalist Steps Header */}
        <div className="wizard-steps-header">
          {Array.from({ length: totalSteps }).map((_, i) => {
            const stepNum = i + 1;
            const romanNumerals = ["I", "II", "III", "IV", "V"];
            return (
              <span
                key={i}
                className={`wizard-step-indicator ${
                  step === stepNum
                    ? "active"
                    : step > stepNum
                    ? "completed"
                    : ""
                }`}
              >
                {romanNumerals[i]}
              </span>
            );
          })}
        </div>

        {/* Step 1: Welcome & Create Class */}
        {step === 1 && (
          <div className="wizard-step fade-in">
            <header className="wizard-header">
              <span className="wizard-badge">Academic Onboarding</span>
              <h2>Set up your first AI tutor for a class</h2>
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

              {error && <div className="wizard-error">{error}</div>}

              <div className="wizard-footer">
                <button type="submit" className="wizard-btn-primary">
                  Continue
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Step 2: Choose Tutor Style */}
        {step === 2 && (
          <div className="wizard-step fade-in">
            <header className="wizard-header">
              <span className="wizard-badge">Tutor Persona</span>
              <h2>Choose your AI Tutor Style</h2>
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
              <button type="button" onClick={() => setStep(1)} className="wizard-btn-secondary">
                Back
              </button>
              <button type="button" onClick={handleNext} className="wizard-btn-primary">
                Continue
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Set Answer Rules */}
        {step === 3 && (
          <div className="wizard-step fade-in">
            <header className="wizard-header">
              <span className="wizard-badge">Pedagogical Guardrails</span>
              <h2>Set Answer Rules & Instructions</h2>
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

              <hr className="wizard-divider" />

              <div className="wizard-input-group">
                <label>Opening message students see</label>
                <input
                  type="text"
                  value={openingMessage}
                  onChange={(e) => setOpeningMessage(e.target.value)}
                />
              </div>

              <div className="wizard-input-group">
                <label>Student Instructions (One per line)</label>
                <textarea
                  rows={3}
                  value={studentInstructions}
                  onChange={(e) => setStudentInstructions(e.target.value)}
                />
              </div>
            </div>

            {error && <div className="wizard-error">{error}</div>}

            <div className="wizard-footer">
              <button
                type="button"
                onClick={() => setStep(2)}
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
                {isLoading ? "Configuring class..." : "Create Class"}
              </button>
            </div>
          </div>
        )}

        {/* Step 4: Add Class Materials */}
        {step === 4 && (
          <div className="wizard-step fade-in">
            <header className="wizard-header">
              <span className="wizard-badge">Tutor Knowledge</span>
              <h2>Add Class Materials</h2>
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
                <span>Supports PDF, DOCX, TXT (Max 10MB)</span>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".pdf,.docx,.txt"
                  style={{ display: "none" }}
                  onChange={handleFileChange}
                />
              </div>

              {uploadedFiles.length > 0 && (
                <div className="wizard-file-list">
                  {uploadedFiles.map((file, i) => (
                    <div key={i} className="wizard-file-row">
                      <span className="wizard-file-name">📄 {file.name}</span>
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

            <div className="wizard-footer">
              <button
                type="button"
                onClick={handleNext}
                className="wizard-btn-secondary"
              >
                Skip for now
              </button>
              <button
                type="button"
                onClick={handleNext}
                className="wizard-btn-primary"
              >
                Upload & Continue
              </button>
            </div>
          </div>
        )}

        {/* Step 5: Preview & Invite */}
        {step === 5 && (
          <div className="wizard-step fade-in">
            <header className="wizard-header">
              <span className="wizard-badge">Scholarly Test</span>
              <h2>Preview Student Chat</h2>
              <p>Test how Chandra responds as a student. Note how it redirects to guiding hints, never giving final answers.</p>
            </header>

            {/* Textbook Dialogue Style Transcript */}
            <div className="wizard-transcript-container">
              <div className="transcript-header">
                <span>ACADEMIC DIALOGUE TRANSCRIPT</span>
              </div>
              <div className="transcript-body">
                {previewMessages.map((msg, i) => (
                  <div key={i} className={`transcript-row ${msg.role}`}>
                    <span className="speaker-label">
                      {msg.role === "student" ? "STUDENT" : "CHANDRA"}
                    </span>
                    <p className="message-content">"{msg.content}"</p>
                  </div>
                ))}
                {isPreviewLoading && (
                  <div className="transcript-row assistant loading">
                    <span className="speaker-label">CHANDRA</span>
                    <p className="message-content italic">"Thinking..."</p>
                  </div>
                )}
              </div>
              <form onSubmit={handleSendPreviewMessage} className="transcript-input-bar">
                <input
                  type="text"
                  placeholder="Ask a question (e.g., 'What is gravity?')..."
                  value={previewInput}
                  onChange={(e) => setPreviewInput(e.target.value)}
                  disabled={isPreviewLoading}
                />
                <button type="submit" disabled={isPreviewLoading}>Send</button>
              </form>
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
                  onClick={() => {
                    navigator.clipboard.writeText(joinCode);
                    alert("Invite code copied to clipboard!");
                  }}
                >
                  Copy Code
                </button>
              </div>
            </div>

            <div className="wizard-footer">
              <button
                type="button"
                onClick={handleFinish}
                className="wizard-btn-primary full-width"
              >
                Finish & Go to Dashboard
              </button>
            </div>
          </div>
        )}
      </div>

      <style jsx global>{`
        .wizard-backdrop {
          position: fixed;
          inset: 0;
          background: #020d0f;
          z-index: 10000;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          overflow-y: auto;
          font-family: 'Lexend', system-ui, -apple-system, sans-serif;
        }

        .wizard-container {
          background: rgba(12, 36, 40, 0.7);
          backdrop-filter: blur(16px);
          border: 1px solid rgba(15, 220, 210, 0.15);
          border-radius: 16px;
          width: min(100%, 650px);
          box-shadow: 0 30px 60px rgba(0, 0, 0, 0.4), 
                      0 0 50px rgba(15, 220, 210, 0.03);
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }

        /* Roman Numeral Steps Indicator */
        .wizard-steps-header {
          display: flex;
          justify-content: center;
          gap: 24px;
          padding: 24px 0 12px;
          border-bottom: 1px dashed rgba(15, 220, 210, 0.12);
          background: rgba(15, 220, 210, 0.02);
        }

        .wizard-step-indicator {
          font-family: 'Libre Baskerville', serif;
          font-size: 0.95rem;
          font-weight: bold;
          color: rgba(253, 251, 247, 0.25);
          position: relative;
          transition: all 0.3s ease;
        }

        .wizard-step-indicator.active {
          color: #0fdcd2;
          text-shadow: 0 0 8px rgba(15, 220, 210, 0.3);
        }

        .wizard-step-indicator.completed {
          color: rgba(253, 251, 247, 0.75);
        }

        .wizard-step-indicator.completed::after {
          content: "";
          position: absolute;
          bottom: -4px;
          left: 50%;
          transform: translateX(-50%);
          width: 4px;
          height: 4px;
          background: rgba(253, 251, 247, 0.6);
          border-radius: 50%;
        }

        .wizard-step {
          padding: 40px;
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
          color: #0fdcd2;
          background: rgba(15, 220, 210, 0.08);
          border: 1px solid rgba(15, 220, 210, 0.25);
          padding: 4px 12px;
          border-radius: 4px;
          margin-bottom: 14px;
          font-weight: 600;
        }

        .wizard-header h2 {
          font-family: 'Libre Baskerville', Georgia, serif;
          font-size: 2.1rem;
          color: #fdfbf7;
          margin: 0 0 12px;
          letter-spacing: -0.01em;
          line-height: 1.25;
        }

        .wizard-header p {
          color: rgba(253, 251, 247, 0.75);
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
          color: rgba(253, 251, 247, 0.85);
          font-size: 0.85rem;
          font-weight: 500;
          letter-spacing: 0.02em;
        }

        .wizard-input-group input,
        .wizard-input-group textarea {
          background: transparent;
          border: none;
          border-bottom: 1px solid rgba(253, 251, 247, 0.15);
          border-radius: 0;
          padding: 10px 0;
          color: #fdfbf7;
          font-size: 0.98rem;
          transition: all 0.25s ease;
        }

        .wizard-input-group input:focus,
        .wizard-input-group textarea:focus {
          outline: none;
          border-bottom-color: #0fdcd2;
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
          background: rgba(253, 251, 247, 0.02);
          border: 1px solid rgba(253, 251, 247, 0.06);
          border-radius: 8px;
          padding: 16px;
          display: flex;
          align-items: center;
          gap: 20px;
          text-align: left;
          cursor: pointer;
          transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        }

        .wizard-style-card:hover {
          background: rgba(253, 251, 247, 0.04);
          border-color: rgba(253, 251, 247, 0.15);
        }

        .wizard-style-card.selected {
          background: rgba(15, 220, 210, 0.06);
          border-color: rgba(15, 220, 210, 0.4);
        }

        .wizard-style-num {
          font-family: 'Libre Baskerville', serif;
          font-size: 1.2rem;
          color: #0fdcd2;
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
          color: #fdfbf7;
          font-size: 0.95rem;
        }

        .wizard-style-content span {
          color: rgba(253, 251, 247, 0.6);
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

        /* Editorial Custom Checkbox */
        .editorial-checkbox {
          display: flex;
          align-items: flex-start;
          gap: 14px;
          padding: 14px 16px;
          background: rgba(253, 251, 247, 0.02);
          border: 1px solid rgba(253, 251, 247, 0.05);
          border-radius: 8px;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .editorial-checkbox:hover {
          background: rgba(253, 251, 247, 0.04);
          border-color: rgba(253, 251, 247, 0.1);
        }

        .editorial-checkbox input {
          display: none;
        }

        .checkbox-box {
          width: 18px;
          height: 18px;
          border: 1px solid rgba(253, 251, 247, 0.25);
          border-radius: 4px;
          background: transparent;
          flex-shrink: 0;
          margin-top: 2px;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.2s ease;
        }

        .editorial-checkbox input:checked + .checkbox-box {
          background: #0fdcd2;
          border-color: #0fdcd2;
        }

        .editorial-checkbox input:checked + .checkbox-box::after {
          content: "✓";
          color: #020d0f;
          font-size: 0.72rem;
          font-weight: bold;
        }

        .checkbox-text {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .checkbox-text strong {
          color: #fdfbf7;
          font-size: 0.92rem;
        }

        .checkbox-text span {
          color: rgba(253, 251, 247, 0.6);
          font-size: 0.8rem;
          line-height: 1.45;
        }

        .wizard-divider {
          border: 0;
          height: 1px;
          border-top: 1px dashed rgba(15, 220, 210, 0.12);
          margin: 12px 0;
        }

        .wizard-dropzone {
          border: 1.5px dashed rgba(253, 251, 247, 0.25);
          background: rgba(253, 251, 247, 0.01);
          border-radius: 8px;
          padding: 32px;
          text-align: center;
          cursor: pointer;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 10px;
          transition: all 0.2s ease;
        }

        .wizard-dropzone:hover {
          border-color: #0fdcd2;
          background: rgba(15, 220, 210, 0.02);
        }

        .wizard-upload-icon {
          font-size: 2rem;
          color: #0fdcd2;
        }

        .wizard-dropzone strong {
          color: #fdfbf7;
          font-size: 0.95rem;
        }

        .wizard-dropzone span {
          color: rgba(253, 251, 247, 0.5);
          font-size: 0.8rem;
        }

        .wizard-file-list {
          margin-top: 16px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .wizard-file-row {
          background: rgba(253, 251, 247, 0.03);
          border: 1px solid rgba(253, 251, 247, 0.06);
          border-radius: 6px;
          padding: 10px 14px;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .wizard-file-name {
          color: rgba(253, 251, 247, 0.85);
          font-size: 0.85rem;
        }

        .wizard-file-remove {
          background: none;
          border: none;
          color: rgba(253, 251, 247, 0.4);
          cursor: pointer;
          font-size: 0.85rem;
          transition: color 0.15s;
        }

        .wizard-file-remove:hover {
          color: #ff6b6b;
        }

        /* Textbook Dialogue Preview Chat Container */
        .wizard-transcript-container {
          background: rgba(12, 36, 40, 0.6);
          border: 1px solid rgba(15, 220, 210, 0.15);
          border-radius: 8px;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          height: 250px;
        }

        .transcript-header {
          background: rgba(253, 251, 247, 0.04);
          padding: 10px 16px;
          font-size: 0.72rem;
          letter-spacing: 0.1em;
          color: rgba(253, 251, 247, 0.45);
          border-bottom: 1px dashed rgba(15, 220, 210, 0.08);
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
          animation: messageFadeIn 0.3s ease forwards;
        }

        .speaker-label {
          font-size: 0.72rem;
          letter-spacing: 0.08em;
          color: #0fdcd2;
          font-weight: bold;
        }

        .transcript-row.student .speaker-label {
          color: rgba(253, 251, 247, 0.45);
        }

        .message-content {
          font-family: 'Libre Baskerville', Georgia, serif;
          font-size: 0.88rem;
          line-height: 1.5;
          color: rgba(253, 251, 247, 0.85);
          margin: 0;
          padding-left: 6px;
          border-left: 1px solid rgba(253, 251, 247, 0.1);
        }

        .transcript-row.student .message-content {
          color: #fdfbf7;
          border-left-color: rgba(253, 251, 247, 0.25);
        }

        .transcript-row.loading .message-content {
          color: rgba(253, 251, 247, 0.4);
        }

        .italic {
          font-style: italic;
        }

        .transcript-input-bar {
          display: flex;
          border-top: 1px dashed rgba(15, 220, 210, 0.1);
          background: rgba(253, 251, 247, 0.01);
        }

        .transcript-input-bar input {
          flex: 1;
          background: transparent;
          border: none;
          padding: 12px 16px;
          color: #fdfbf7;
          font-size: 0.88rem;
        }

        .transcript-input-bar input:focus {
          outline: none;
        }

        .transcript-input-bar button {
          background: #0fdcd2;
          color: #020d0f;
          border: none;
          padding: 0 20px;
          font-size: 0.82rem;
          font-weight: bold;
          cursor: pointer;
          transition: background 0.2s;
        }

        .transcript-input-bar button:hover {
          background: #0dbfb7;
        }

        /* Invite Card */
        .wizard-invite-card {
          background: rgba(253, 251, 247, 0.01);
          border: 1px dashed rgba(15, 220, 210, 0.15);
          border-radius: 8px;
          padding: 20px;
          margin-top: 20px;
        }

        .wizard-invite-card h3 {
          font-family: 'Libre Baskerville', serif;
          color: #fdfbf7;
          font-size: 1.1rem;
          margin: 0 0 6px;
        }

        .wizard-invite-card p {
          color: rgba(253, 251, 247, 0.6);
          font-size: 0.8rem;
          margin: 0 0 14px;
        }

        .wizard-invite-row {
          display: flex;
          gap: 12px;
          align-items: center;
        }

        .wizard-code-box {
          background: rgba(12, 36, 40, 0.8);
          border: 1px solid rgba(15, 220, 210, 0.2);
          color: #fdfbf7;
          font-family: monospace;
          font-size: 1.3rem;
          font-weight: bold;
          padding: 6px 18px;
          border-radius: 4px;
          letter-spacing: 0.05em;
        }

        /* Buttons & Footer */
        .wizard-footer {
          margin-top: 36px;
          display: flex;
          justify-content: flex-end;
          gap: 12px;
        }

        .wizard-btn-primary {
          background: #0fdcd2;
          color: #020d0f;
          border: 1px solid #0fdcd2;
          border-radius: 6px;
          padding: 12px 28px;
          font-size: 0.92rem;
          font-weight: bold;
          cursor: pointer;
          transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        }

        .wizard-btn-primary:hover {
          background: #0dbfb7;
          border-color: #0dbfb7;
          transform: translateY(-1px);
          box-shadow: 0 0 16px rgba(15, 220, 210, 0.35);
        }

        .wizard-btn-primary.full-width {
          width: 100%;
          text-align: center;
        }

        .wizard-btn-secondary {
          background: transparent;
          color: rgba(253, 251, 247, 0.8);
          border: 1px solid rgba(253, 251, 247, 0.15);
          border-radius: 6px;
          padding: 12px 28px;
          font-size: 0.92rem;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .wizard-btn-secondary:hover {
          background: rgba(253, 251, 247, 0.03);
          border-color: rgba(253, 251, 247, 0.25);
          color: #fdfbf7;
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

        .req {
          color: #ff6b6b;
        }

        .fade-in {
          animation: wizardFadeIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }

        @keyframes wizardFadeIn {
          from {
            opacity: 0;
            transform: translateY(8px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @keyframes messageFadeIn {
          from {
            opacity: 0;
            transform: translateY(4px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </div>
  );
}
