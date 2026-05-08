"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import { useAuth } from "@/components/AuthProvider";
import { RequireAuth } from "@/components/RequireAuth";
import { apiUrl } from "@/lib/api-client";
import { signOutCurrentUser, updateUserThemePreference } from "@/lib/auth";
import {
  askChandraTutorArgsSchema,
  buildRealtimeKnownContext,
  sanitizeRealtimeKnownContext,
  type RealtimeKnownContext,
  type RealtimeVoiceProgressEvent
} from "@/lib/realtime-tutor";
import {
  defaultTeacherClassAppearance,
  defaultTeacherClassThemeColor,
  normalizeTeacherClassAppearance,
  normalizeTeacherClassThemeColor,
  teacherClassThemeColorOptions
} from "@/lib/class-theme";
import { normalizeOpeningMessage, normalizeStudentFacingInstructions } from "@/lib/class-settings";
import { subscribeToClass, type TeacherClass } from "@/lib/classes";
import type { ChatMessage, StudentConversationSummary, TutorApiResponse } from "@/lib/types";

type ChatProgress = {
  message: string;
  searches: ChatProgressSearch[];
};

type ChatProgressSearch = {
  description: string;
  query: string;
  searchNumber?: number;
};

type ChatStreamEvent =
  | { message: string; stage: string; type: "step" }
  | { description?: string; message: string; query: string; searchNumber: number; stage: string; type: "search" }
  | {
      message: string;
      queries: string[];
      searches?: ChatProgressSearch[];
      searchNumbers?: number[];
      stage: string;
      type: "search_batch";
    }
  | { errorCode?: string; errorId?: string; message: string; stage: string; type: "error" }
  | { payload: TutorApiResponse; type: "final" };

type VoiceModeStatus = "off" | "connecting" | "listening" | "tutor_thinking" | "speaking" | "error";

type VoiceDialogueTurn = {
  id: string;
  speaker: "student" | "chandra";
  text: string;
};

type RealtimeSessionResponse = {
  clientSecret?: {
    expiresAt?: number;
    value?: string;
  };
  knownContext?: RealtimeKnownContext;
  realtimeApi?: {
    webrtcEndpoint?: string;
  };
};

type RealtimeTutorToolStreamEvent =
  | {
      progressEvent: Record<string, unknown>;
      type: "progress";
      voiceProgressEvent?: RealtimeVoiceProgressEvent;
    }
  | {
      payload: RealtimeTutorToolResult;
      type: "final";
    }
  | {
      error?: string;
      type: "error";
    };

type RealtimeTutorToolResult = {
  progressEvents: Array<Record<string, unknown>>;
  realtimeFunctionOutput: Record<string, unknown>;
  uiResponse: TutorApiResponse;
  voiceProgressEvents: RealtimeVoiceProgressEvent[];
};

type RealtimeFunctionCall = {
  argumentsText: string;
  callId: string;
  name: string;
};

const studentComposerTextareaMaxHeight = 156;
const studentAppearanceOptions = ["light", "dark"] as const;
const markdownRemarkPlugins = [remarkMath];
const markdownRehypePlugins = [rehypeKatex];
const realtimeAddressedResponseInstructions = [
  "Decide whether the latest user audio was meant for Chandra.",
  "Respond or call ask_chandra_tutor only when the user says Chandra, asks an academic tutoring question, or clearly answers Chandra's last tutor question.",
  "If the user is talking to another person, the audio is background conversation, or you are unsure who it was for, do not call tools and produce no spoken output."
].join(" ");

const welcomeMessageId = "welcome";

function isProblemReferenceVoiceRequest(text: string) {
  const normalized = text.toLowerCase();
  const hasReference =
    /\b(problem|exercise|question|page|passage|section)\s*[a-z]?\s*\d+(?:\.\d+)?\b/.test(normalized) ||
    /\b\d+\.\d+\b/.test(normalized);
  const asksForLookup =
    /\b(help on|help with|look up|pull up|show|read|find|what does|what is|can i have help on|can you get)\b/.test(
      normalized
    );
  const asksForSolving =
    /\b(solve|walk me through|prove it|do it|answer it|check my work|my work|i tried|am i right)\b/.test(
      normalized
    );

  return hasReference && asksForLookup && !asksForSolving;
}

function recentVoiceDialogueTurns(turns: VoiceDialogueTurn[]) {
  const latestBySpeaker = new Map<VoiceDialogueTurn["speaker"], VoiceDialogueTurn>();

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (!latestBySpeaker.has(turn.speaker)) {
      latestBySpeaker.set(turn.speaker, turn);
    }
    if (latestBySpeaker.size === 2) {
      break;
    }
  }

  return Array.from(latestBySpeaker.values()).sort((first, second) => turns.indexOf(first) - turns.indexOf(second));
}

function readRealtimeVoiceReply(realtimeFunctionOutput: Record<string, unknown>) {
  return typeof realtimeFunctionOutput.voiceReply === "string" ? realtimeFunctionOutput.voiceReply.trim() : "";
}

export default function StudentPage() {
  return (
    <main className="student-workspace-page">
      <Suspense
        fallback={
          <section className="auth-state-panel">
            <h1>Preparing student chat.</h1>
          </section>
        }
      >
        <StudentWorkspace />
      </Suspense>
    </main>
  );
}

function StudentWorkspace() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { firebaseReady, profile, user } = useAuth();
  const [messages, setMessages] = useState<ChatMessage[]>(() => buildInitialStudentMessages(null));
  const [draft, setDraft] = useState("");
  const draftTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [chatProgress, setChatProgress] = useState<ChatProgress | null>(null);
  const [classLoadError, setClassLoadError] = useState<{ classId: string; message: string } | null>(null);
  const [loadedClassId, setLoadedClassId] = useState("");
  const [savedClass, setSavedClass] = useState<TeacherClass | null>(null);
  const [conversationLoadError, setConversationLoadError] = useState("");
  const [conversationMessagesError, setConversationMessagesError] = useState("");
  const [themePreferenceError, setThemePreferenceError] = useState("");
  const [isSavingThemePreference, setIsSavingThemePreference] = useState(false);
  const [conversationSummaries, setConversationSummaries] = useState<StudentConversationSummary[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [selectedConversationClassId, setSelectedConversationClassId] = useState("");
  const [voiceStatus, setVoiceStatus] = useState<VoiceModeStatus>("off");
  const [voiceError, setVoiceError] = useState("");
  const [voiceDialogueTurns, setVoiceDialogueTurns] = useState<VoiceDialogueTurn[]>([]);
  const [voiceProgressMessage, setVoiceProgressMessage] = useState("");
  const [isVoiceTutorProgressVisible, setIsVoiceTutorProgressVisible] = useState(false);
  const realtimePeerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const realtimeDataChannelRef = useRef<RTCDataChannel | null>(null);
  const realtimeMicStreamRef = useRef<MediaStream | null>(null);
  const realtimeAudioElementRef = useRef<HTMLAudioElement | null>(null);
  const realtimeKnownContextRef = useRef<RealtimeKnownContext>({});
  const realtimeProcessedCallIdsRef = useRef<Set<string>>(new Set());
  const realtimeProgressKeysRef = useRef<Set<string>>(new Set());
  const realtimeVoiceProgressKeysRef = useRef<Set<string>>(new Set());
  const realtimeResponseInProgressRef = useRef(false);
  const realtimeTutorToolInProgressRef = useRef(false);
  const activeCourseIdRef = useRef("");
  const activeConversationIdRef = useRef("");
  const isTeacherPreview = searchParams.get("preview") === "teacher";
  const queryClassId = searchParams.get("classId");
  const activeCourseId = isTeacherPreview ? queryClassId ?? "" : profile?.classId ?? "";
  const classLoadMessage = classLoadError?.classId === activeCourseId ? classLoadError.message : "";
  const isLoadingClass = Boolean(
    firebaseReady &&
      activeCourseId &&
      loadedClassId !== activeCourseId &&
      classLoadError?.classId !== activeCourseId
  );

  useEffect(() => {
    if (!firebaseReady || !activeCourseId) {
      return () => {};
    }

    return subscribeToClass(
      activeCourseId,
      (nextClass) => {
        setSavedClass(nextClass);
        setLoadedClassId(activeCourseId);
        setMessages((currentMessages) =>
          isOnlyWelcomeMessage(currentMessages) ? buildInitialStudentMessages(nextClass) : currentMessages
        );
      },
      (caughtError) => {
        setSavedClass(null);
        setClassLoadError(
          {
            classId: activeCourseId,
            message: caughtError.message.toLowerCase().includes("permission")
              ? "You do not have access to that class code yet."
              : caughtError.message
          }
        );
      }
    );
  }, [activeCourseId, firebaseReady]);

  useEffect(() => {
    if (!firebaseReady || !activeCourseId || !user || profile?.role !== "student" || isTeacherPreview) {
      return;
    }

    let isCancelled = false;

    user
      .getIdToken()
      .then((token) => fetchStudentConversationSummaries({ classId: activeCourseId, token }))
      .then((nextConversations) => {
        if (!isCancelled) {
          setConversationSummaries(nextConversations);
          setConversationLoadError("");
        }
      })
      .catch((caughtError) => {
        if (!isCancelled) {
          setConversationSummaries([]);
          setConversationLoadError(describeStudentConversationLoadError(caughtError));
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [activeCourseId, firebaseReady, isTeacherPreview, profile?.role, user]);

  const activeClass = savedClass?.id === activeCourseId ? savedClass : null;
  const activeAppearance = normalizeTeacherClassAppearance(
    profile?.appearance ?? activeClass?.appearance ?? defaultTeacherClassAppearance
  );
  const activeThemeColor = normalizeTeacherClassThemeColor(
    profile?.themeColor ?? activeClass?.themeColor ?? defaultTeacherClassThemeColor
  );
  const className = activeClass?.name ?? (activeCourseId ? "Saved class" : "Class needed");
  const classSection = activeClass?.section ?? (activeCourseId ? "Student chat" : "Enter your class code");
  const classSectionLabel = formatClassSectionLabel(classSection, Boolean(activeCourseId));
  const visibleClassCode = activeClass?.joinCode || activeClass?.id || activeCourseId;
  const pinnedTeacherInstructions = activeClass ? formatPinnedTeacherInstructions(activeClass) : "";
  const visibleConversationSummaries = conversationSummaries.filter(
    (conversation) => conversation.classId === activeCourseId && conversation.studentId === user?.uid
  );
  const activeSelectedConversationId = selectedConversationClassId === activeCourseId ? selectedConversationId : "";
  const selectedConversation =
    visibleConversationSummaries.find((conversation) => conversation.id === activeSelectedConversationId) ?? null;
  const conversationTitle = selectedConversation?.title ?? "";
  const conversationMessageCount = selectedConversation?.messageCount ?? 0;
  const accountName = profile?.displayName ?? user?.displayName ?? "Student";
  const accountEmail = profile?.email ?? user?.email ?? "";
  const shouldShowVoiceDialogue = voiceStatus !== "off" || voiceDialogueTurns.length > 0;

  activeCourseIdRef.current = activeCourseId;
  activeConversationIdRef.current = activeSelectedConversationId;

  useEffect(() => {
    resizeStudentComposerTextarea(draftTextareaRef.current);
  }, [draft]);

  useEffect(() => {
    realtimeKnownContextRef.current = {};
    cleanupVoiceSession();

    return () => {
      cleanupVoiceSession();
    };
  }, [activeCourseId]);

  useEffect(() => {
    if (!firebaseReady || !activeCourseId || !activeSelectedConversationId || !user) {
      return;
    }

    let isCancelled = false;

    user
      .getIdToken()
      .then((token) =>
        fetchStudentConversationMessages({
          classId: activeCourseId,
          conversationId: activeSelectedConversationId,
          token
        })
      )
      .then((savedMessages) => {
        if (!isCancelled) {
          setMessages(savedMessages.length ? savedMessages : buildInitialStudentMessages(activeClass));
          setConversationMessagesError("");
        }
      })
      .catch((caughtError) => {
        if (!isCancelled) {
          setConversationMessagesError(describeStudentConversationMessageError(caughtError));
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [activeClass, activeCourseId, activeSelectedConversationId, firebaseReady, user]);

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();

    if (!content || isSending) {
      return;
    }

    if (!user) {
      return;
    }

    const studentMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "student",
      content,
      createdAt: new Date().toISOString()
    };

    const nextMessages = [...messages, studentMessage];
    setMessages(nextMessages);
    setDraft("");
    setIsSending(true);
    setChatProgress({
      message: "Getting ready.",
      searches: []
    });

    try {
      const token = await user.getIdToken();
      const response = await fetch(apiUrl("/api/chat"), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          conversationId: activeSelectedConversationId || undefined,
          courseId: activeCourseId,
          messages: nextMessages,
          stream: true
        })
      });

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error ?? "Chat request failed");
      }

      const data = await readChatStream(response, (event) => {
        if (event.type === "step") {
          setChatProgress((current) => ({
            message: event.message,
            searches: current?.searches ?? []
          }));
        }

        if (event.type === "search") {
          setChatProgress((current) =>
            appendProgressSearches(current, event.message, [
              {
                description: coerceFiveWordSearchReason(event.description, event.query),
                query: event.query,
                searchNumber: event.searchNumber
              }
            ])
          );
        }

        if (event.type === "search_batch") {
          const searches =
            event.searches ??
            event.queries.map((query, index) => ({
              description: describeSearchQueryForUi(query),
              query,
              searchNumber: event.searchNumbers?.[index]
            }));

          setChatProgress((current) => appendProgressSearches(current, event.message, searches));
        }
      });

      if (data.conversationId && data.conversationId !== activeSelectedConversationId) {
        setSelectedConversationId(data.conversationId);
        setSelectedConversationClassId(activeCourseId);
      }

      try {
        setConversationSummaries(await fetchStudentConversationSummaries({ classId: activeCourseId, token }));
        setConversationLoadError("");
      } catch (caughtError) {
        setConversationLoadError(describeStudentConversationLoadError(caughtError));
      }

      setMessages((current) => [
        ...current,
        {
          id: data.assistantMessageId ?? crypto.randomUUID(),
          role: "assistant",
          content: data.message ?? data.content ?? "I could not generate a response.",
          createdAt: new Date().toISOString(),
          langGraphTrace: data.langGraphTrace,
          sources: data.sources ?? [],
          structuredOutput: data.structuredOutput
        }
      ]);
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "I could not reach the tutor service. Try again in a moment.";
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: message,
          createdAt: new Date().toISOString()
        }
      ]);
    } finally {
      setIsSending(false);
      setChatProgress(null);
    }
  }

  async function toggleVoiceMode() {
    if (voiceStatus !== "off" && voiceStatus !== "error") {
      cleanupVoiceSession();
      return;
    }

    await startVoiceSession();
  }

  async function startVoiceSession() {
    if (!user || !activeCourseId || voiceStatus === "connecting") {
      return;
    }

    setVoiceError("");
    setVoiceStatus("connecting");
    setVoiceDialogueTurns([]);
    setVoiceProgressMessage("Connecting voice mode.");

    try {
      await connectRealtimeVoiceSession(false);
    } catch (caughtError) {
      const message = describeVoiceError(caughtError);
      cleanupVoiceSession({ clearProgress: false, resetStatus: false });
      setVoiceStatus("error");
      setVoiceError(message);
      setVoiceProgressMessage(message);
    }
  }

  async function connectRealtimeVoiceSession(hasRetriedExpiredSecret: boolean) {
    if (!user) {
      throw new Error("Sign in again to use voice mode.");
    }

    const token = await user.getIdToken();
    const sessionResponse = await createRealtimeSession(token);
    const ephemeralKey = sessionResponse.clientSecret?.value;

    if (!ephemeralKey) {
      throw new Error("Voice mode could not get a Realtime client secret.");
    }

    realtimeKnownContextRef.current = sanitizeRealtimeKnownContext(
      sessionResponse.knownContext ?? realtimeKnownContextRef.current
    );

    const peerConnection = new RTCPeerConnection();
    const dataChannel = peerConnection.createDataChannel("oai-events");
    const audioElement = document.createElement("audio");
    audioElement.autoplay = true;

    realtimePeerConnectionRef.current = peerConnection;
    realtimeDataChannelRef.current = dataChannel;
    realtimeAudioElementRef.current = audioElement;
    realtimeProcessedCallIdsRef.current = new Set();
    realtimeProgressKeysRef.current = new Set();
    realtimeVoiceProgressKeysRef.current = new Set();
    realtimeResponseInProgressRef.current = false;
    realtimeTutorToolInProgressRef.current = false;

    peerConnection.ontrack = (event) => {
      audioElement.srcObject = event.streams[0] ?? null;
    };

    dataChannel.addEventListener("open", () => {
      setVoiceStatus("listening");
      setVoiceProgressMessage("Voice mode is listening.");
    });
    dataChannel.addEventListener("message", (event) => {
      void handleRealtimeServerEvent(event);
    });
    dataChannel.addEventListener("error", () => {
      setVoiceStatus("error");
      setVoiceError("Voice mode lost its event connection.");
      setVoiceProgressMessage("Voice mode lost its event connection.");
    });

    const microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    realtimeMicStreamRef.current = microphoneStream;
    const microphoneTrack = microphoneStream.getAudioTracks()[0] ?? microphoneStream.getTracks()[0];

    if (!microphoneTrack) {
      throw new Error("No microphone track was available.");
    }

    peerConnection.addTrack(microphoneTrack, microphoneStream);

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    const sdpResponse = await fetch(sessionResponse.realtimeApi?.webrtcEndpoint ?? "https://api.openai.com/v1/realtime/calls", {
      body: offer.sdp ?? "",
      headers: {
        Authorization: `Bearer ${ephemeralKey}`,
        "Content-Type": "application/sdp"
      },
      method: "POST"
    });

    if (!sdpResponse.ok) {
      if ((sdpResponse.status === 401 || sdpResponse.status === 403) && !hasRetriedExpiredSecret) {
        cleanupVoiceSession({ clearProgress: false, resetStatus: false });
        await connectRealtimeVoiceSession(true);
        return;
      }

      throw new Error("Realtime voice connection failed.");
    }

    await peerConnection.setRemoteDescription({
      sdp: await sdpResponse.text(),
      type: "answer"
    });
  }

  async function createRealtimeSession(token: string) {
    const response = await fetch(apiUrl("/api/realtime/session"), {
      body: JSON.stringify({
        conversationId: activeConversationIdRef.current || undefined,
        courseId: activeCourseIdRef.current,
        knownContext: realtimeKnownContextRef.current
      }),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      method: "POST"
    });
    const data = (await response.json()) as RealtimeSessionResponse & { error?: string };

    if (!response.ok) {
      throw new Error(data.error ?? "Voice mode could not start.");
    }

    return data;
  }

  function cleanupVoiceSession(options: { clearProgress?: boolean; resetStatus?: boolean } = {}) {
    const { clearProgress = true, resetStatus = true } = options;

    realtimeMicStreamRef.current?.getTracks().forEach((track) => track.stop());
    realtimeMicStreamRef.current = null;
    realtimeDataChannelRef.current?.close();
    realtimeDataChannelRef.current = null;
    realtimePeerConnectionRef.current?.close();
    realtimePeerConnectionRef.current = null;

    if (realtimeAudioElementRef.current) {
      realtimeAudioElementRef.current.srcObject = null;
      realtimeAudioElementRef.current.remove();
      realtimeAudioElementRef.current = null;
    }

    realtimeProcessedCallIdsRef.current = new Set();
    realtimeVoiceProgressKeysRef.current = new Set();
    realtimeResponseInProgressRef.current = false;
    realtimeTutorToolInProgressRef.current = false;
    setIsVoiceTutorProgressVisible(false);
    setVoiceProgressMessage("");

    if (resetStatus) {
      setVoiceStatus("off");
      setVoiceError("");
    }

    if (clearProgress) {
      setChatProgress(null);
    }
  }

  async function handleRealtimeServerEvent(event: MessageEvent) {
    let serverEvent: Record<string, unknown>;

    try {
      serverEvent = JSON.parse(String(event.data)) as Record<string, unknown>;
    } catch {
      return;
    }

    const eventType = typeof serverEvent.type === "string" ? serverEvent.type : "";

    if (eventType === "input_audio_buffer.speech_started") {
      if (realtimeResponseInProgressRef.current || realtimeTutorToolInProgressRef.current) {
        return;
      }

      setVoiceStatus("listening");
      setVoiceProgressMessage("Listening.");
      return;
    }

    if (eventType === "input_audio_buffer.speech_stopped") {
      if (realtimeResponseInProgressRef.current || realtimeTutorToolInProgressRef.current) {
        return;
      }

      setVoiceStatus("tutor_thinking");
      setVoiceProgressMessage("Checking if that was for Chandra.");
      requestRealtimeTutorResponseForLatestSpeech();
      return;
    }

    if (eventType === "response.created") {
      realtimeResponseInProgressRef.current = true;
      return;
    }

    if (
      eventType === "response.audio.delta" ||
      eventType === "response.output_audio.delta" ||
      eventType === "response.audio_transcript.delta" ||
      eventType === "response.output_audio_transcript.delta"
    ) {
      setVoiceStatus("speaking");
      setVoiceProgressMessage("Chandra is speaking.");
      return;
    }

    if (eventType === "response.done") {
      realtimeResponseInProgressRef.current = false;
      setVoiceStatus((current) => (current === "off" || current === "error" ? current : "listening"));
      setVoiceProgressMessage("Voice mode is listening.");
      return;
    }

    if (eventType === "error") {
      realtimeResponseInProgressRef.current = false;
      const message = readRealtimeErrorMessage(serverEvent);
      setVoiceStatus("error");
      setVoiceError(message);
      setVoiceProgressMessage(message);
      return;
    }

    const functionCall = extractRealtimeFunctionCall(serverEvent);

    if (functionCall) {
      await handleAskChandraTutorFunctionCall(functionCall);
    }
  }

  async function handleAskChandraTutorFunctionCall(functionCall: RealtimeFunctionCall) {
    if (functionCall.name !== "ask_chandra_tutor" || realtimeProcessedCallIdsRef.current.has(functionCall.callId)) {
      return;
    }

    realtimeProcessedCallIdsRef.current.add(functionCall.callId);
    realtimeTutorToolInProgressRef.current = true;
    setIsVoiceTutorProgressVisible(true);
    realtimeProgressKeysRef.current = new Set();
    setVoiceStatus("tutor_thinking");
    setVoiceProgressMessage("Preparing Chandra's voice reply.");
    setChatProgress({
      message: "Tutor thinking.",
      searches: []
    });

    try {
      if (!user) {
        throw new Error("Sign in again to use voice mode.");
      }

      const args = parseRealtimeTutorArgs(functionCall.argumentsText);
      appendVoiceDialogueTurn({
        id: `${functionCall.callId}-student`,
        speaker: "student",
        text: args.studentTranscript
      });
      const token = await user.getIdToken();
      const result = await streamRealtimeTutorTool(args, token);

      appendRealtimeTutorUiResponse(result.uiResponse, token);
      appendRealtimeTutorVoiceReply(functionCall.callId, result.realtimeFunctionOutput);
      sendRealtimeFunctionOutput(functionCall.callId, result.realtimeFunctionOutput);
      sendRealtimeResponseCreate();
      setVoiceStatus("speaking");
      setVoiceProgressMessage("Chandra is speaking.");
    } catch (caughtError) {
      const message = describeVoiceError(caughtError);
      setVoiceStatus("error");
      setVoiceError(message);
      setVoiceProgressMessage(message);
      sendRealtimeFunctionOutput(functionCall.callId, {
        currentStep: "",
        nextStep: "Try again in a moment.",
        searched: false,
        sectionsShown: [],
        sourceLabels: [],
        voiceReply: message
      });
      sendRealtimeResponseCreate();
    } finally {
      realtimeTutorToolInProgressRef.current = false;
      setIsVoiceTutorProgressVisible(false);
    }
  }

  function parseRealtimeTutorArgs(argumentsText: string) {
    let parsedArguments: unknown;

    try {
      parsedArguments = JSON.parse(argumentsText);
    } catch {
      throw new Error("Voice mode received invalid tutor request arguments.");
    }

    const rawArgs = parsedArguments && typeof parsedArguments === "object" ? (parsedArguments as Record<string, unknown>) : {};
    const rawKnownContext =
      rawArgs.knownContext && typeof rawArgs.knownContext === "object"
        ? (rawArgs.knownContext as Record<string, unknown>)
        : {};
    const shouldForceSourceLookup = isProblemReferenceVoiceRequest(
      typeof rawArgs.studentTranscript === "string" ? rawArgs.studentTranscript : ""
    );
    const normalizedRawArgs = {
      ...rawArgs,
      conversationId: activeConversationIdRef.current || rawArgs.conversationId,
      courseId: activeCourseIdRef.current,
      preferredSections: shouldForceSourceLookup ? ["answer", "sources"] : rawArgs.preferredSections,
      responseBudget: shouldForceSourceLookup ? "ui_full" : rawArgs.responseBudget,
      retrievalMode: shouldForceSourceLookup ? "force_search" : rawArgs.retrievalMode,
      voiceIntent: shouldForceSourceLookup ? "find_source" : rawArgs.voiceIntent,
      knownContext: sanitizeRealtimeKnownContext({
        ...realtimeKnownContextRef.current,
        ...rawKnownContext
      })
    };
    const args = askChandraTutorArgsSchema.safeParse(normalizedRawArgs);

    if (!args.success) {
      throw new Error("Voice mode received unsafe tutor request arguments.");
    }

    return args.data;
  }

  async function streamRealtimeTutorTool(args: ReturnType<typeof parseRealtimeTutorArgs>, token: string) {
    const response = await fetch(apiUrl("/api/realtime/tutor-tool"), {
      body: JSON.stringify({
        ...args,
        stream: true
      }),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      method: "POST"
    });

    if (!response.ok) {
      const data = (await response.json()) as { error?: string };
      throw new Error(data.error ?? "Chandra could not answer this voice request.");
    }

    return readRealtimeTutorToolStream(response, (streamEvent) => {
      if (streamEvent.type !== "progress") {
        return;
      }

      const progressKey = realtimeProgressEventKey(streamEvent.progressEvent);

      if (realtimeProgressKeysRef.current.has(progressKey)) {
        return;
      }

      realtimeProgressKeysRef.current.add(progressKey);
      updateChatProgressFromRealtimeEvent(streamEvent.progressEvent);
      trackRealtimeVoiceProgressEvent(streamEvent.voiceProgressEvent);
    });
  }

  async function readRealtimeTutorToolStream(
    response: Response,
    onEvent: (event: RealtimeTutorToolStreamEvent) => void
  ) {
    const reader = response.body?.getReader();

    if (!reader) {
      throw new Error("The voice tutor service did not return a stream.");
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let finalPayload: RealtimeTutorToolResult | null = null;

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        const streamEvent = JSON.parse(line) as RealtimeTutorToolStreamEvent;

        if (streamEvent.type === "error") {
          throw new Error(streamEvent.error ?? "Chandra could not answer this voice request.");
        }

        if (streamEvent.type === "final") {
          finalPayload = streamEvent.payload;
        } else {
          onEvent(streamEvent);
        }
      }
    }

    if (!finalPayload) {
      throw new Error("The voice tutor service ended before sending an answer.");
    }

    return finalPayload;
  }

  function updateChatProgressFromRealtimeEvent(progressEvent: Record<string, unknown>) {
    const message = typeof progressEvent.message === "string" ? progressEvent.message : "Tutor thinking.";
    const eventType = typeof progressEvent.type === "string" ? progressEvent.type : "";

    const query = typeof progressEvent.query === "string" ? progressEvent.query : "";
    const description = typeof progressEvent.description === "string" ? progressEvent.description : undefined;

    if (eventType === "search" && query) {
      setChatProgress((current) =>
        appendProgressSearches(current, message, [
          {
            description: coerceFiveWordSearchReason(description, query),
            query,
            searchNumber:
              typeof progressEvent.searchNumber === "number" ? progressEvent.searchNumber : undefined
          }
        ])
      );
      return;
    }

    if (eventType === "search_batch" && Array.isArray(progressEvent.queries)) {
      const searchNumbers = Array.isArray(progressEvent.searchNumbers) ? progressEvent.searchNumbers : [];
      const searches = progressEvent.queries
        .filter((query): query is string => typeof query === "string")
        .map((query, index) => ({
          description: describeSearchQueryForUi(query),
          query,
          searchNumber: typeof searchNumbers[index] === "number" ? searchNumbers[index] : undefined
        }));

      setChatProgress((current) => appendProgressSearches(current, message, searches));
      return;
    }

    setChatProgress((current) => ({
      message,
      searches: current?.searches ?? []
    }));
  }

  function trackRealtimeVoiceProgressEvent(voiceProgressEvent: RealtimeVoiceProgressEvent | undefined) {
    if (!voiceProgressEvent) {
      return;
    }

    if (realtimeVoiceProgressKeysRef.current.has(voiceProgressEvent.dedupeKey)) {
      return;
    }

    realtimeVoiceProgressKeysRef.current.add(voiceProgressEvent.dedupeKey);
  }

  function appendRealtimeTutorUiResponse(uiResponse: TutorApiResponse, token: string) {
    realtimeKnownContextRef.current = buildRealtimeKnownContext(uiResponse);

    if (uiResponse.conversationId && uiResponse.conversationId !== activeConversationIdRef.current) {
      setSelectedConversationId(uiResponse.conversationId);
      setSelectedConversationClassId(activeCourseIdRef.current);
    }

    setMessages((current) => [
      ...current,
      {
        id: uiResponse.assistantMessageId ?? crypto.randomUUID(),
        role: "assistant",
        content: uiResponse.message ?? uiResponse.content ?? "I could not generate a response.",
        createdAt: new Date().toISOString(),
        langGraphTrace: uiResponse.langGraphTrace,
        sources: uiResponse.sources ?? [],
        structuredOutput: uiResponse.structuredOutput
      }
    ]);

    fetchStudentConversationSummaries({ classId: activeCourseIdRef.current, token })
      .then((nextConversations) => {
        setConversationSummaries(nextConversations);
        setConversationLoadError("");
      })
      .catch((caughtError) => {
        setConversationLoadError(describeStudentConversationLoadError(caughtError));
      });
  }

  function appendRealtimeTutorVoiceReply(callId: string, realtimeFunctionOutput: Record<string, unknown>) {
    const voiceReply = readRealtimeVoiceReply(realtimeFunctionOutput);

    if (!voiceReply) {
      return;
    }

    appendVoiceDialogueTurn({
      id: `${callId}-chandra`,
      speaker: "chandra",
      text: voiceReply
    });
  }

  function sendRealtimeFunctionOutput(callId: string, realtimeFunctionOutput: Record<string, unknown>) {
    sendRealtimeEvent({
      item: {
        call_id: callId,
        output: JSON.stringify(realtimeFunctionOutput),
        type: "function_call_output"
      },
      type: "conversation.item.create"
    });
  }

  function sendRealtimeResponseCreate() {
    realtimeResponseInProgressRef.current = true;
    sendRealtimeEvent({
      type: "response.create"
    });
  }

  function requestRealtimeTutorResponseForLatestSpeech() {
    realtimeResponseInProgressRef.current = true;
    sendRealtimeEvent({
      response: {
        instructions: realtimeAddressedResponseInstructions,
        output_modalities: ["audio"],
        tool_choice: "auto"
      },
      type: "response.create"
    });
  }

  function sendRealtimeEvent(event: Record<string, unknown>) {
    const dataChannel = realtimeDataChannelRef.current;

    if (dataChannel?.readyState === "open") {
      dataChannel.send(JSON.stringify(event));
    }
  }

  function appendVoiceDialogueTurn(turn: VoiceDialogueTurn) {
    setVoiceDialogueTurns((current) => {
      const nextTurns = current.some((currentTurn) => currentTurn.id === turn.id)
        ? current.map((currentTurn) => (currentTurn.id === turn.id ? turn : currentTurn))
        : [...current, turn];

      return recentVoiceDialogueTurns(nextTurns);
    });
  }

  async function updatePersonalThemePreference(nextPreference: {
    appearance?: unknown;
    themeColor?: unknown;
  }) {
    if (!user) {
      return;
    }

    setThemePreferenceError("");
    setIsSavingThemePreference(true);

    try {
      await updateUserThemePreference({
        appearance: normalizeTeacherClassAppearance(nextPreference.appearance ?? activeAppearance),
        themeColor: normalizeTeacherClassThemeColor(nextPreference.themeColor ?? activeThemeColor),
        uid: user.uid
      });
    } catch (caughtError) {
      setThemePreferenceError(caughtError instanceof Error ? caughtError.message : "Theme preference failed.");
    } finally {
      setIsSavingThemePreference(false);
    }
  }

  function startNewConversation() {
    realtimeKnownContextRef.current = {};
    cleanupVoiceSession();
    setSelectedConversationId("");
    setSelectedConversationClassId(activeCourseId);
    setMessages(buildInitialStudentMessages(activeClass));
    setConversationMessagesError("");
  }

  async function handleSignOut() {
    await signOutCurrentUser();
    router.push("/auth");
  }

  return (
    <RequireAuth role={isTeacherPreview ? ["student", "teacher"] : "student"}>
      <section
        className="student-workspace-shell"
        data-appearance={activeAppearance}
        data-theme-color={activeThemeColor}
      >
        <aside className="student-workspace-sidebar" aria-label="Student workspace navigation">
          <div className="student-sidebar-scroll">
            <Link className="student-brand" href="/">
              <span className="student-wordmark">Chandra</span>
            </Link>

            <section className="student-sidebar-card student-current-class-card" aria-label="Current class">
              <h2>
                <span>{className}</span>
                {classSectionLabel ? <span>{classSectionLabel}</span> : null}
              </h2>
              {isLoadingClass ? <p className="sidebar-note">Loading class.</p> : null}
              {classLoadMessage ? <p className="form-error">{classLoadMessage}</p> : null}
              {isTeacherPreview ? (
                <Link className="student-sidebar-action" href="/teacher">
                  Back to dashboard
                </Link>
              ) : null}

              {profile?.role === "student" && !isTeacherPreview ? (
                <div className="student-class-code-display" aria-label="Class code">
                  <span>Class code</span>
                  <strong>{visibleClassCode || "No class joined"}</strong>
                </div>
              ) : null}

              <div className="student-theme-preferences" aria-label="Theme preferences">
                <span className="field-label">Personal theme color</span>
                <div className="settings-theme-swatches" role="radiogroup" aria-label="Personal theme color">
                  {teacherClassThemeColorOptions.map((option) => (
                    <label className="settings-theme-swatch" key={option.id}>
                      <input
                        checked={activeThemeColor === option.id}
                        disabled={isSavingThemePreference}
                        name="studentThemeColor"
                        type="radio"
                        value={option.id}
                        onChange={() => updatePersonalThemePreference({ themeColor: option.id })}
                      />
                      <span>
                        <span
                          className="settings-theme-swatch-dot"
                          style={{ backgroundColor: option.color }}
                          aria-hidden="true"
                        />
                        {option.label}
                      </span>
                    </label>
                  ))}
                </div>

                <span className="field-label">Personal appearance</span>
                <div className="settings-appearance-pills" role="radiogroup" aria-label="Personal appearance">
                  {studentAppearanceOptions.map((appearance) => (
                    <label className="settings-choice-pill" key={appearance}>
                      <input
                        checked={activeAppearance === appearance}
                        disabled={isSavingThemePreference}
                        name="studentAppearance"
                        type="radio"
                        value={appearance}
                        onChange={() => updatePersonalThemePreference({ appearance })}
                      />
                      <span>{capitalizeLabel(appearance)}</span>
                    </label>
                  ))}
                </div>
                {themePreferenceError ? <p className="form-error">{themePreferenceError}</p> : null}
              </div>
            </section>

            {profile?.role === "student" && !isTeacherPreview ? (
              <section className="student-sidebar-card student-conversation-history" aria-label="Saved conversations">
                <div className="sidebar-section-heading">
                  <strong>Conversations</strong>
                  <button className="student-new-mini-button" type="button" onClick={startNewConversation}>
                    New
                  </button>
                </div>
                {conversationLoadError ? <p className="form-error">{conversationLoadError}</p> : null}
                <div className="student-conversation-list">
                  {visibleConversationSummaries.map((conversation) => (
                    <button
                      aria-pressed={conversation.id === activeSelectedConversationId}
                      className="student-conversation-row"
                      key={conversation.id}
                      type="button"
                      onClick={() => {
                        realtimeKnownContextRef.current = {};
                        cleanupVoiceSession();
                        setSelectedConversationId(conversation.id);
                        setSelectedConversationClassId(activeCourseId);
                      }}
                    >
                      <span className="student-conversation-icon" aria-hidden="true" />
                      <span className="student-conversation-copy">
                        <strong>{conversation.title}</strong>
                        <span>{formatConversationMeta(conversation)}</span>
                      </span>
                      <span className="student-row-chevron" aria-hidden="true">
                        ›
                      </span>
                    </button>
                  ))}
                  {!visibleConversationSummaries.length && !conversationLoadError ? (
                    <p className="sidebar-note">No saved conversations.</p>
                  ) : null}
                </div>
              </section>
            ) : null}
          </div>

          <section className="student-account-card" aria-label="Signed in account">
            <span className="student-avatar" aria-hidden="true">
              {getInitials(accountName, accountEmail)}
            </span>
            <span className="student-account-copy">
              <strong>{accountName}</strong>
              <span>{accountEmail}</span>
            </span>
            <button className="student-signout-button" type="button" onClick={handleSignOut}>
              Sign out
            </button>
          </section>
        </aside>

        <section className="student-workspace-main" aria-label="Student tutor chat">
          <header className="student-main-header">
            <div>
              <h1>
                <span>{className}</span>
                {classSectionLabel ? <span>{classSectionLabel}</span> : null}
              </h1>
            </div>
            <div className="student-status-actions" aria-label="Workspace status">
              <span className="student-status-pill">
                <span className="student-user-icon" aria-hidden="true" />
                Student
              </span>
              <span className="student-status-pill">
                <span className="student-connected-dot" aria-hidden="true" />
                Connected
              </span>
            </div>
          </header>

          {pinnedTeacherInstructions ? (
            <section className="student-teacher-instructions" aria-label="Class instructions">
              <div>
                <strong className="student-instructions-heading">Class instructions</strong>
                <p>{pinnedTeacherInstructions}</p>
              </div>
            </section>
          ) : null}

          {selectedConversation ? (
            <section className="student-conversation-header" aria-label="Current conversation">
              <div>
                <h2>{conversationTitle}</h2>
                <p>{formatMessageCount(conversationMessageCount)}</p>
              </div>
            </section>
          ) : null}

          {conversationMessagesError ? <p className="form-error chat-error">{conversationMessagesError}</p> : null}
          {shouldShowVoiceDialogue ? (
            <VoiceDialoguePanel
              progressMessage={voiceProgressMessage || voiceStatusLabel(voiceStatus, voiceError)}
              turns={voiceDialogueTurns}
            />
          ) : null}
          <div className="message-list student-message-list">
            {messages.map((message) => (
              <article className={`student-workspace-message ${message.role === "student" ? "student" : "assistant"}`} key={message.id}>
                {message.role === "student" ? (
                  <div className="student-message-stack">
                    <div className="message-meta">You</div>
                    <div className="student-message-bubble">
                      <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins}>
                        {normalizeMarkdownMath(message.content)}
                      </ReactMarkdown>
                    </div>
                  </div>
                ) : (
                  <>
                    <span className="chandra-message-avatar" aria-hidden="true">
                      C
                    </span>
                    <div className="assistant-message-stack">
                      <div className="message-meta">Chandra</div>
                      {assistantMessageAnswerContent(message) ? (
                        <div className="assistant-message-bubble">
                          <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins}>
                            {normalizeMarkdownMath(assistantMessageAnswerContent(message))}
                          </ReactMarkdown>
                        </div>
                      ) : null}
                      {assistantStructuredSections(message).map((section) => (
                        <div className={`assistant-structured-section ${section.kind}`} key={section.kind}>
                          <strong>{section.label}</strong>
                          <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins}>
                            {normalizeMarkdownMath(normalizeStructuredSectionMarkdown(section.content, section.kind))}
                          </ReactMarkdown>
                        </div>
                      ))}
                      {message.sources?.length ? (
                        <div className="message-sources" aria-label="Sources used">
                          <strong>Sources:</strong>
                          {condensedSourceLabels(message.sources).map((label, index) => (
                            <span key={`${label}-${index}`}>{label}</span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </>
                )}
              </article>
            ))}
            {(isSending || isVoiceTutorProgressVisible) && chatProgress ? <ChatProgressMessage progress={chatProgress} /> : null}
          </div>

          <form className="composer student-composer" onSubmit={sendMessage}>
            <button
              aria-label={voiceStatus === "off" || voiceStatus === "error" ? "Turn voice mode on" : "Turn voice mode off"}
              aria-pressed={voiceStatus !== "off" && voiceStatus !== "error"}
              className="student-voice-button"
              disabled={!activeCourseId || !user || voiceStatus === "connecting"}
              title={voiceStatusLabel(voiceStatus, voiceError)}
              type="button"
              onClick={toggleVoiceMode}
            >
              <span className="student-voice-icon" aria-hidden="true" />
              <span className="student-voice-button-label">{voiceButtonLabel(voiceStatus)}</span>
            </button>
            <textarea
              aria-label="Message Chandra"
              ref={draftTextareaRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={activeCourseId ? "Ask about a problem, step, or equation..." : "Join a class to start chatting."}
              rows={1}
            />
            <button className="student-send-button" type="submit" disabled={isSending || !draft.trim() || !activeCourseId}>
              {isSending ? "Sending" : "Send"}
            </button>
          </form>
        </section>
      </section>
    </RequireAuth>
  );
}

function resizeStudentComposerTextarea(textarea: HTMLTextAreaElement | null) {
  if (!textarea) {
    return;
  }

  textarea.style.height = "auto";
  const nextHeight = Math.min(textarea.scrollHeight, studentComposerTextareaMaxHeight);
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > studentComposerTextareaMaxHeight ? "auto" : "hidden";
}

function extractRealtimeFunctionCall(event: Record<string, unknown>): RealtimeFunctionCall | null {
  const eventType = typeof event.type === "string" ? event.type : "";

  if (eventType === "response.function_call_arguments.done") {
    const functionCall = {
      argumentsText: typeof event.arguments === "string" ? event.arguments : "",
      callId: typeof event.call_id === "string" ? event.call_id : "",
      name: typeof event.name === "string" ? event.name : ""
    };

    return functionCall.callId && functionCall.name ? functionCall : null;
  }

  if (eventType !== "response.output_item.done" || !event.item || typeof event.item !== "object") {
    return null;
  }

  const item = event.item as Record<string, unknown>;

  if (item.type !== "function_call") {
    return null;
  }

  const functionCall = {
    argumentsText: typeof item.arguments === "string" ? item.arguments : "",
    callId: typeof item.call_id === "string" ? item.call_id : "",
    name: typeof item.name === "string" ? item.name : ""
  };

  return functionCall.callId && functionCall.name ? functionCall : null;
}

function readRealtimeErrorMessage(event: Record<string, unknown>) {
  const error = event.error && typeof event.error === "object" ? (event.error as Record<string, unknown>) : {};
  const message = typeof error.message === "string" ? error.message : "";

  return message || "Voice mode hit an error.";
}

function describeVoiceError(caughtError: unknown) {
  if (caughtError instanceof DOMException && caughtError.name === "NotAllowedError") {
    return "Microphone permission was denied.";
  }

  return caughtError instanceof Error ? caughtError.message : "Voice mode hit an error.";
}

function voiceButtonLabel(status: VoiceModeStatus) {
  if (status === "off" || status === "error") {
    return "Voice";
  }

  if (status === "connecting") {
    return "Connecting";
  }

  return "Voice on";
}

function voiceStatusLabel(status: VoiceModeStatus, error: string) {
  if (status === "error") {
    return error || "Voice mode hit an error.";
  }

  if (status === "connecting") {
    return "Connecting voice mode.";
  }

  if (status === "listening") {
    return "Voice mode is listening.";
  }

  if (status === "tutor_thinking") {
    return "Tutor thinking.";
  }

  if (status === "speaking") {
    return "Chandra is speaking.";
  }

  return "Voice mode is off.";
}

function realtimeProgressEventKey(progressEvent: Record<string, unknown>) {
  return JSON.stringify({
    message: typeof progressEvent.message === "string" ? progressEvent.message : "",
    queries: Array.isArray(progressEvent.queries)
      ? progressEvent.queries.filter((query): query is string => typeof query === "string")
      : [],
    query: typeof progressEvent.query === "string" ? progressEvent.query : "",
    stage: typeof progressEvent.stage === "string" ? progressEvent.stage : "",
    type: typeof progressEvent.type === "string" ? progressEvent.type : ""
  });
}

function VoiceDialoguePanel({ progressMessage, turns }: { progressMessage: string; turns: VoiceDialogueTurn[] }) {
  return (
    <aside className="voice-dialogue-panel" aria-label="Realtime voice dialogue">
      <div className="voice-dialogue-heading">
        <strong>Voice dialogue</strong>
      </div>
      <div className="voice-dialogue-progress" aria-live="polite">
        <span className="thinking-dot" aria-hidden="true" />
        <p>{progressMessage}</p>
      </div>
      <div className="voice-dialogue-list">
        {turns.length ? (
          turns.map((turn) => (
            <div className={`voice-dialogue-turn ${turn.speaker}`} key={turn.id}>
              <span>{turn.speaker === "student" ? "You" : "Chandra"}</span>
              <p>{turn.text}</p>
            </div>
          ))
        ) : (
          <p className="voice-dialogue-empty">Realtime transcript will appear here.</p>
        )}
      </div>
    </aside>
  );
}

function ChatProgressMessage({ progress }: { progress: ChatProgress }) {
  return (
    <article className="student-workspace-message assistant progress-message" aria-live="polite">
      <span className="chandra-message-avatar" aria-hidden="true">
        C
      </span>
      <div className="assistant-message-stack">
        <div className="message-meta">Chandra</div>
        <div className="assistant-message-bubble">
          <div className="progress-row">
            <span className="thinking-dot" aria-hidden="true" />
            <p>{progress.message}</p>
          </div>
          {progress.searches.length ? (
            <ol className="progress-searches" aria-label="Searches Chandra has tried">
              {progress.searches.map((search, index) => (
                <li key={`${search.query}-${index}`}>
                  <strong>{search.description}</strong>
                  <span>{search.query}</span>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      </div>
    </article>
  );
}

async function readChatStream(response: Response, onEvent: (event: ChatStreamEvent) => void) {
  const reader = response.body?.getReader();

  if (!reader) {
    throw new Error("The tutor service did not return a stream.");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let finalPayload: TutorApiResponse | null = null;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      const event = JSON.parse(line) as ChatStreamEvent;

      if (event.type === "error") {
        throw new Error(event.message);
      }

      if (event.type === "final") {
        finalPayload = event.payload;
      } else {
        onEvent(event);
      }
    }
  }

  if (!finalPayload) {
    throw new Error("The tutor service ended before sending an answer.");
  }

  return finalPayload;
}

async function fetchStudentConversationSummaries({
  classId,
  token
}: {
  classId: string;
  token: string;
}) {
  const response = await fetch(apiUrl(`/api/student/conversations?courseId=${encodeURIComponent(classId)}`), {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  const data = (await response.json()) as { conversations?: StudentConversationSummary[]; error?: string };

  if (!response.ok) {
    throw new Error(data.error ?? "Saved conversations failed to load.");
  }

  return data.conversations ?? [];
}

async function fetchStudentConversationMessages({
  classId,
  conversationId,
  token
}: {
  classId: string;
  conversationId: string;
  token: string;
}) {
  const response = await fetch(
    apiUrl(
      `/api/student/conversations/${encodeURIComponent(conversationId)}/messages?courseId=${encodeURIComponent(
        classId
      )}`
    ),
    {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  );
  const data = (await response.json()) as { messages?: ChatMessage[]; error?: string };

  if (!response.ok) {
    throw new Error(data.error ?? "Conversation messages failed to load.");
  }

  return data.messages ?? [];
}

function describeStudentConversationLoadError(caughtError: unknown) {
  return caughtError instanceof Error ? caughtError.message : "Saved conversations failed to load.";
}

function describeStudentConversationMessageError(caughtError: unknown) {
  return caughtError instanceof Error ? caughtError.message : "Conversation messages failed to load.";
}

function appendProgressSearches(
  current: ChatProgress | null,
  message: string,
  searches: ChatProgressSearch[]
): ChatProgress {
  const existingSearches = current?.searches ?? [];
  const seenQueries = new Set(existingSearches.map((search) => normalizeSearchQuery(search.query)));
  const nextSearches = [...existingSearches];

  for (const search of searches) {
    const normalizedQuery = normalizeSearchQuery(search.query);

    if (!normalizedQuery || seenQueries.has(normalizedQuery)) {
      continue;
    }

    seenQueries.add(normalizedQuery);
    nextSearches.push(search);
  }

  return {
    message,
    searches: nextSearches
  };
}

function describeSearchQueryForUi(query: string) {
  const normalizedQuery = query.toLowerCase();

  if (/(problem|page|worksheet|section|chapter|exercise|quiz|exam|number)/.test(normalizedQuery)) {
    return "Checking exact problem and page";
  }

  if (/(method|formula|theorem|definition|rule|example|substitution|derivative|integral|solve)/.test(normalizedQuery)) {
    return "Finding method and example pages";
  }

  return "Searching class PDFs for support";
}

function coerceFiveWordSearchReason(reason: string | undefined, query: string) {
  const words = reason?.match(/[A-Za-z0-9']+/g) ?? [];

  if (words.length === 5) {
    return words.join(" ");
  }

  return describeSearchQueryForUi(query);
}

function normalizeSearchQuery(query: string) {
  return query.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function assistantMessageAnswerContent(message: ChatMessage) {
  return message.structuredOutput ? message.structuredOutput.sections.answer : message.content;
}

function assistantStructuredSections(message: ChatMessage) {
  const sections = message.structuredOutput?.sections;

  if (!sections) {
    return [];
  }

  return [
    { content: sections.hint, kind: "hint", label: "Hint" },
    { content: sections.explanation, kind: "explanation", label: "Why this works" },
    { content: sections.formula, kind: "formula", label: "Formula" },
    { content: sections.example, kind: "example", label: "Example" },
    { content: sections.checkWork, kind: "check-work", label: "Check your work" },
    {
      content: message.sources?.length || isGenericSourceNote(sections.sourceNote) ? undefined : sections.sourceNote,
      kind: "source-note",
      label: "Source"
    },
    { content: sections.nextStep, kind: "next-step", label: "Your next step" }
  ].filter((section): section is { content: string; kind: string; label: string } => Boolean(section.content));
}

function isGenericSourceNote(note: string | undefined) {
  return !note || /^based on the selected class material\.?$/i.test(note.trim());
}

function normalizeStructuredSectionMarkdown(content: string, kind: string) {
  const cleaned = content
    .trim()
    .replace(/^\*\*\s*/, "")
    .replace(/\s*\*\*$/, "");

  if (kind !== "formula") {
    return cleaned;
  }

  if (/^\$\$[\s\S]*\$\$$/.test(cleaned) || /^\\\[/.test(cleaned)) {
    return cleaned;
  }

  const formulas = cleaned
    .split(/\s*,\s*(?=(?:P|E|M|A|\\mu|μ|\$?\\?mu)\b)/)
    .map((formula) => formula.trim())
    .filter(Boolean);

  if (formulas.length <= 1) {
    return `$$\n${cleaned.replace(/^\$|\$$/g, "")}\n$$`;
  }

  return formulas.map((formula) => `$$\n${formula.replace(/^\$|\$$/g, "")}\n$$`).join("\n\n");
}

function formatSourceLabel(source: NonNullable<ChatMessage["sources"]>[number]) {
  return [
    source.title,
    source.problemNumber ? `problem ${source.problemNumber}` : "",
    source.pageNumber ? `p. ${source.pageNumber}` : ""
  ].filter(Boolean).join(" · ");
}

function condensedSourceLabels(sources: NonNullable<ChatMessage["sources"]>) {
  const groupedSources = new Map<string, { pages: Set<number>; source: NonNullable<ChatMessage["sources"]>[number] }>();

  for (const source of sources) {
    const key = [source.title, source.materialType, source.problemNumber ?? ""].join("|");
    const existing = groupedSources.get(key) ?? { pages: new Set<number>(), source };

    if (source.pageNumber) {
      existing.pages.add(source.pageNumber);
    }

    groupedSources.set(key, existing);
  }

  const labels = Array.from(groupedSources.values()).map(({ pages, source }) =>
    formatSourceLabel({
      ...source,
      pageNumber: undefined
    }) + formatPageRange(Array.from(pages))
  );
  const visibleLabels = labels.slice(0, 3);

  return labels.length > visibleLabels.length ? [...visibleLabels, `+${labels.length - visibleLabels.length} more`] : visibleLabels;
}

function formatPageRange(pages: number[]) {
  const sortedPages = [...new Set(pages)].sort((first, second) => first - second);

  if (!sortedPages.length) {
    return "";
  }

  const ranges: string[] = [];
  let rangeStart = sortedPages[0];
  let previousPage = sortedPages[0];

  for (const page of sortedPages.slice(1)) {
    if (page === previousPage + 1) {
      previousPage = page;
      continue;
    }

    ranges.push(rangeStart === previousPage ? `${rangeStart}` : `${rangeStart}-${previousPage}`);
    rangeStart = page;
    previousPage = page;
  }

  ranges.push(rangeStart === previousPage ? `${rangeStart}` : `${rangeStart}-${previousPage}`);

  return ` · ${ranges.length === 1 && !ranges[0].includes("-") ? "p." : "pp."} ${ranges.join(", ")}`;
}

function formatConversationMeta(conversation: StudentConversationSummary) {
  return [
    `${conversation.messageCount} messages`,
    formatConversationDate(conversation.lastMessageAt)
  ].filter(Boolean).join(" / ");
}

function capitalizeLabel(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatMessageCount(count: number) {
  return `${count} ${count === 1 ? "message" : "messages"}`;
}

function formatClassSectionLabel(classSection: string, hasClass: boolean) {
  if (!hasClass || !classSection || classSection === "Enter your class code" || classSection === "Student chat") {
    return "";
  }

  return `Section ${classSection}`;
}

function buildInitialStudentMessages(teacherClass: TeacherClass | null): ChatMessage[] {
  return [
    {
      id: welcomeMessageId,
      role: "assistant",
      content: normalizeOpeningMessage(teacherClass?.openingMessage, teacherClass ?? undefined),
      createdAt: new Date().toISOString()
    }
  ];
}

function isOnlyWelcomeMessage(messages: ChatMessage[]) {
  return messages.length === 1 && messages[0]?.id === welcomeMessageId && messages[0]?.role === "assistant";
}

function formatPinnedTeacherInstructions(teacherClass: TeacherClass) {
  const customInstructions = normalizeStudentFacingInstructions(
    teacherClass.studentFacingInstructions,
    teacherClass
  );

  return customInstructions;
}

function getInitials(name: string, email: string) {
  const source = name.trim() || email.trim();
  const parts = source
    .replace(/@.*/, "")
    .split(/\s+|[._-]+/)
    .filter(Boolean);

  return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : source.slice(0, 2)).toUpperCase();
}

function formatConversationDate(value: unknown) {
  const date = coerceDate(value);

  if (!date) {
    return "";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function coerceDate(value: unknown) {
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? null : new Date(timestamp);
  }

  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    return value.toDate() as Date;
  }

  return null;
}

function normalizeMarkdownMath(content: string) {
  return content
    .replace(/\\\[/g, "$$")
    .replace(/\\\]/g, "$$")
    .replace(/\\\(/g, "$")
    .replace(/\\\)/g, "$")
    .replace(/^\[\s*(\\(?:int|frac|sqrt|sum|lim|prod)[\s\S]*?)\s*\]$/gm, "$$$$\n$1\n$$$$");
}
