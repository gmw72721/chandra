import type { Conversation, Course, ModelOption, SourceDocument, TutorPolicy } from "./types";
import { defaultModelOptions } from "./model-options";

export const modelOptions: ModelOption[] = defaultModelOptions;

export const courses: Course[] = [
  {
    id: "algebra-201",
    name: "Algebra II",
    section: "Period 3",
    activePolicyId: "policy-socratic",
    allowedModelIds: [
      "demo-guided",
      "openai/gpt-5.4-mini",
      "anthropic/claude-3.5-sonnet",
      "google/gemini-2.0-flash-001"
    ]
  }
];

export const tutorPolicies: TutorPolicy[] = [
  {
    id: "policy-socratic",
    courseId: "algebra-201",
    title: "Socratic problem-solving coach",
    visibleToStudent: false,
    instructions: [
      "Do not provide the final answer directly unless the student has already completed the main reasoning.",
      "Ask one focused question at a time.",
      "When the student is stuck, point them to the most relevant worked example before giving a hint.",
      "Use LaTeX for equations and keep explanations short enough for a chat interface."
    ],
    refusalStyle: "Redirect requests for direct answers into an attempt check, work review, or similar example.",
    retrievalGuidance: "Prefer course examples over generic explanations when a matching source is available."
  }
];

export const documents: SourceDocument[] = [
  {
    id: "doc-quadratics",
    courseId: "algebra-201",
    title: "Lecture 4: Factoring Quadratics",
    kind: "lecture-notes",
    status: "ready",
    uploadedAt: "2026-04-18T16:00:00.000Z",
    chunks: [
      {
        id: "chunk-zero-product",
        documentId: "doc-quadratics",
        label: "Zero product property",
        content:
          "If a product equals zero, at least one factor must equal zero. For example, from (x - 3)(x + 2) = 0, solve x - 3 = 0 or x + 2 = 0."
      },
      {
        id: "chunk-factor-pattern",
        documentId: "doc-quadratics",
        label: "Factoring pattern",
        content:
          "To factor x^2 + bx + c, find two numbers that multiply to c and add to b. Then write the expression as (x + m)(x + n)."
      }
    ]
  },
  {
    id: "doc-example-12",
    courseId: "algebra-201",
    title: "Textbook Example 12",
    kind: "worked-example",
    status: "ready",
    uploadedAt: "2026-04-22T16:00:00.000Z",
    chunks: [
      {
        id: "chunk-example-12",
        documentId: "doc-example-12",
        label: "Worked example",
        content:
          "Example 12 solves x^2 - x - 6 = 0 by factoring into (x - 3)(x + 2) = 0, then applying the zero product property."
      }
    ]
  }
];

export const conversations: Conversation[] = [
  {
    id: "conv-1",
    courseId: "algebra-201",
    studentName: "Maya R.",
    assignment: "Quadratics Practice Set",
    modelId: "openai/gpt-5.4-mini",
    tags: ["factoring", "needs-confidence"],
    lastActiveAt: "2026-05-04T21:20:00.000Z",
    messages: [
      {
        id: "m1",
        role: "student",
        content: "I do not know how to start x^2 - x - 6 = 0.",
        createdAt: "2026-05-04T21:16:00.000Z"
      },
      {
        id: "m2",
        role: "assistant",
        content:
          "Look at Textbook Example 12. What two numbers multiply to \\(-6\\) and add to \\(-1\\)?",
        createdAt: "2026-05-04T21:16:12.000Z"
      }
    ]
  }
];
