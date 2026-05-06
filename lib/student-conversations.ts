"use client";

import { collection, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { db, isFirebaseConfigured } from "./firebase";
import type { ChatMessage, StudentConversationSummary } from "./types";

export function subscribeToStudentConversations(
  {
    classId,
    studentId
  }: {
    classId: string;
    studentId: string;
  },
  callback: (conversations: StudentConversationSummary[]) => void,
  onError?: (error: Error) => void
) {
  assertFirestoreReady();

  const conversationsQuery = query(
    collection(db!, "classes", classId, "conversations"),
    where("studentId", "==", studentId)
  );

  return onSnapshot(
    conversationsQuery,
    (snapshot) => {
      const conversations = snapshot.docs
        .map((conversationDoc) => ({ id: conversationDoc.id, ...conversationDoc.data() }) as StudentConversationSummary)
        .sort((firstConversation, secondConversation) =>
          timestampMillis(secondConversation.lastMessageAt) - timestampMillis(firstConversation.lastMessageAt)
        );

      callback(conversations);
    },
    (error) => onError?.(error)
  );
}

export function subscribeToClassStudentConversations(
  {
    classId,
    studentEmail
  }: {
    classId: string;
    studentEmail: string;
  },
  callback: (conversations: StudentConversationSummary[]) => void,
  onError?: (error: Error) => void
) {
  assertFirestoreReady();

  const conversationsQuery = query(
    collection(db!, "classes", classId, "conversations"),
    where("studentEmail", "==", studentEmail.trim().toLowerCase())
  );

  return onSnapshot(
    conversationsQuery,
    (snapshot) => {
      const conversations = snapshot.docs
        .map((conversationDoc) => ({ id: conversationDoc.id, ...conversationDoc.data() }) as StudentConversationSummary)
        .sort((firstConversation, secondConversation) =>
          timestampMillis(secondConversation.lastMessageAt) - timestampMillis(firstConversation.lastMessageAt)
        );

      callback(conversations);
    },
    (error) => onError?.(error)
  );
}

export function subscribeToClassConversations(
  {
    classId
  }: {
    classId: string;
  },
  callback: (conversations: StudentConversationSummary[]) => void,
  onError?: (error: Error) => void
) {
  assertFirestoreReady();

  return onSnapshot(
    collection(db!, "classes", classId, "conversations"),
    (snapshot) => {
      const conversations = snapshot.docs
        .map((conversationDoc) => ({ id: conversationDoc.id, ...conversationDoc.data() }) as StudentConversationSummary)
        .sort((firstConversation, secondConversation) =>
          timestampMillis(secondConversation.lastMessageAt) - timestampMillis(firstConversation.lastMessageAt)
        );

      callback(conversations);
    },
    (error) => onError?.(error)
  );
}

export function subscribeToConversationMessages(
  {
    classId,
    conversationId
  }: {
    classId: string;
    conversationId: string;
  },
  callback: (messages: ChatMessage[]) => void,
  onError?: (error: Error) => void
) {
  assertFirestoreReady();

  const messagesQuery = query(
    collection(db!, "classes", classId, "conversations", conversationId, "messages"),
    orderBy("createdAt", "asc")
  );

  return onSnapshot(
    messagesQuery,
    (snapshot) => {
      callback(snapshot.docs.map((messageDoc) => ({ id: messageDoc.id, ...messageDoc.data() }) as ChatMessage));
    },
    (error) => onError?.(error)
  );
}

function assertFirestoreReady() {
  if (!isFirebaseConfigured || !db) {
    throw new Error("Firebase is not configured. Add NEXT_PUBLIC_FIREBASE_* values to .env.local.");
  }
}

function timestampMillis(value: unknown) {
  if (typeof value === "string") {
    return Date.parse(value) || 0;
  }

  if (value && typeof value === "object" && "toMillis" in value && typeof value.toMillis === "function") {
    return value.toMillis();
  }

  return 0;
}
