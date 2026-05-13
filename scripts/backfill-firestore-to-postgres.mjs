#!/usr/bin/env node
import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import pg from "pg";

const { Pool } = pg;

const allowedSections = new Set([
  "accounts",
  "classes",
  "roster",
  "co-teachers",
  "materials",
  "conversations",
  "messages",
  "attachments",
  "feedback",
  "reviews",
  "support",
  "profiles",
  "logs"
]);

const args = parseArgs(process.argv.slice(2));
const dryRun = !args.write;
const selectedSections = args.sections.length ? args.sections : [...allowedSections];

for (const section of selectedSections) {
  if (!allowedSections.has(section)) {
    fail(`Unknown section "${section}". Allowed sections: ${[...allowedSections].join(", ")}`);
  }
}

if (!dryRun && !getDatabaseUrl()) {
  fail("DATABASE_URL, CLOUD_SQL_POSTGRES_URL, or CHANDRA_CLOUD_SQL_POSTGRES_URL is required.");
}

const db = getFirestore(initializeFirebaseAdmin());
const pool = dryRun && !getDatabaseUrl()
  ? null
  : new Pool({
    connectionString: getDatabaseUrl(),
    max: 4,
    ssl: readPostgresSslConfig()
  });

const counters = new Map();
const knownAccounts = new Set();
const accountIdsByEmail = new Map();
const accountAliases = new Map();
const classesById = new Map();
const rosterByClassAndStudent = new Map();
const knownConversations = new Set();
const knownMaterials = new Set();

try {
  if (pool) {
    await pool.query("select 1");
  }
  await backfill();
  printSummary();
} finally {
  await pool?.end().catch(() => {});
}

async function backfill() {
  await withTransaction(async (client) => {
    if (hasSection("accounts")) {
      await backfillAccounts(client);
    } else {
      await loadExistingAccountIds(client);
    }

    if (hasSection("classes")) {
      await backfillClasses(client);
    } else if (needsClassCache()) {
      await loadClassCacheFromFirestore();
    }

    if (hasSection("roster")) {
      await backfillRoster(client);
    }

    if (hasSection("co-teachers")) {
      await backfillCoTeachers(client);
    }

    if (hasSection("materials")) {
      await backfillMaterials(client);
    }

    if (hasSection("conversations") || hasSection("messages") || hasSection("attachments") || hasSection("reviews")) {
      await backfillConversationsMessagesAttachmentsReviews(client);
    }

    if (hasSection("feedback")) {
      await backfillStudentFeedback(client);
    }

    if (hasSection("support")) {
      await backfillStudentSupport(client);
    }

    if (hasSection("profiles")) {
      await backfillLearningProfiles(client);
    }

    if (hasSection("logs")) {
      await backfillOperationalLogs(client);
    }

    if (dryRun && client) {
      await client.query("ROLLBACK");
    }
  });
}

async function backfillAccounts(client) {
  const snapshot = await db.collection("users").get();
  for (const doc of snapshot.docs) {
    const data = doc.data();
    const email = lowerString(data.email) || legacyEmail(doc.id);
    const role = data.role === "teacher" || data.role === "student" ? data.role : "student";
    const displayName = stringValue(data.displayName) || stringValue(data.name) || email;
    await upsertAccount(client, {
      id: doc.id,
      firebaseUid: doc.id,
      email,
      displayName,
      username: lowerString(data.username) || email,
      role,
      legacyClassId: stringOrNull(data.classId),
      legacyClassIds: stringArray(data.classIds),
      profile: firestoreJson(data)
    });
    knownAccounts.add(doc.id);
    count("accounts");
  }
}

async function backfillClasses(client) {
  const snapshot = args.classId
    ? { docs: [await db.collection("classes").doc(args.classId).get()].filter((doc) => doc.exists) }
    : await db.collection("classes").get();

  for (const doc of snapshot.docs) {
    const data = doc.data();
    let teacherId = stringValue(data.teacherId) || stringValue(data.ownerId) || stringValue(data.createdBy) || "legacy-teacher";
    teacherId = await ensureAccount(client, teacherId, {
      role: "teacher",
      email: lowerString(data.teacherEmail) || legacyEmail(teacherId),
      displayName: stringValue(data.teacherName) || stringValue(data.ownerName) || "Legacy teacher"
    }) || teacherId;
    const classRecord = {
      id: doc.id,
      teacherId,
      teacherName: stringValue(data.teacherName) || stringValue(data.ownerName),
      name: stringValue(data.name) || stringValue(data.title) || "Untitled class",
      section: stringValue(data.section),
      joinCode: stringOrNull(data.joinCode) || stringOrNull(data.classCode),
      studentChatEnabled: booleanValue(data.studentChatEnabled, true),
      appearance: stringValue(data.appearance),
      themeColor: stringValue(data.themeColor),
      answerPolicy: objectValue(data.answerPolicy),
      modelSettings: objectValue(data.modelSettings),
      notificationSettings: objectValue(data.notificationSettings),
      privacySettings: objectValue(data.privacySettings),
      responseFormat: objectValue(data.responseFormat),
      sourceDefaults: objectValue(data.sourceDefaults),
      sourceUsage: objectValue(data.sourceUsage),
      tutorAccess: objectValue(data.tutorAccess),
      behaviorTitle: stringValue(data.behaviorTitle),
      behaviorInstructions: stringValue(data.behaviorInstructions),
      defaultAssignmentContext: stringValue(data.defaultAssignmentContext),
      openingMessage: stringValue(data.openingMessage),
      refusalStyle: stringValue(data.refusalStyle),
      studentFacingInstructions: stringValue(data.studentFacingInstructions),
      firestoreSnapshot: firestoreJson(data),
      createdAt: timestampValue(data.createdAt),
      updatedAt: timestampValue(data.updatedAt)
    };
    await upsertClass(client, classRecord);
    classesById.set(doc.id, { id: doc.id, teacherId, teacherName: classRecord.teacherName, name: classRecord.name });
    count("classes");
  }
}

async function backfillRoster(client) {
  await forEachClass(async (classDoc, classData) => {
    const rosterSnapshot = await classDoc.ref.collection("students").get();
    for (const studentDoc of rosterSnapshot.docs) {
      const data = studentDoc.data();
      let studentId = stringValue(data.uid) || stringValue(data.studentId) || (studentDoc.id.includes("@") ? "" : studentDoc.id);
      const email = lowerString(data.email) || lowerString(data.studentEmail) || (studentDoc.id.includes("@") ? lowerString(studentDoc.id) : "");
      const displayName = stringValue(data.displayName) || stringValue(data.name) || stringValue(data.studentName) || email || studentId || "Student";
      if (studentId) {
        studentId = await ensureAccount(client, studentId, {
          role: "student",
          email: email || legacyEmail(studentId),
          displayName
        }) || studentId;
      }
      await upsertEnrollment(client, {
        classId: classDoc.id,
        studentId: studentId || null,
        studentEmail: email,
        displayName,
        status: normalizeEnrollmentStatus(data.status),
        chatBlocked: booleanValue(data.chatBlocked, false),
        firestoreDocumentId: studentDoc.id,
        metadata: firestoreJson(data),
        createdAt: timestampValue(data.createdAt),
        updatedAt: timestampValue(data.updatedAt),
        removedAt: timestampValue(data.removedAt)
      });
      rememberRoster(classDoc.id, studentId || studentDoc.id, { studentId: studentId || null, studentEmail: email, displayName });
      count("class_enrollments");
    }
  });
}

async function backfillCoTeachers(client) {
  await forEachClass(async (classDoc, classData) => {
    const entries = [];
    const coTeachers = classData.coTeachers;
    if (coTeachers && typeof coTeachers === "object" && !Array.isArray(coTeachers)) {
      for (const [uid, value] of Object.entries(coTeachers)) {
        entries.push({ uid, data: objectValue(value) });
      }
    }
    for (const uid of stringArray(classData.coTeacherIds)) {
      if (!entries.some((entry) => entry.uid === uid)) {
        entries.push({ uid, data: {} });
      }
    }

    for (const entry of entries) {
      let teacherId = stringValue(entry.data.uid) || entry.uid;
      if (!teacherId) {
        continue;
      }
      const email = lowerString(entry.data.email) || legacyEmail(teacherId);
      const displayName = stringValue(entry.data.displayName) || email;
      teacherId = await ensureAccount(client, teacherId, { role: "teacher", email, displayName }) || teacherId;
      await upsertCoTeacher(client, {
        classId: classDoc.id,
        teacherId,
        email,
        displayName,
        status: normalizeCoTeacherStatus(entry.data.status),
        invitedBy: stringOrNull(entry.data.invitedBy) || stringOrNull(classData.teacherId),
        permissions: {
          role: entry.data.role === "viewer" ? "viewer" : "co-teacher",
          firestore: firestoreJson(entry.data)
        },
        createdAt: timestampValue(entry.data.createdAt),
        updatedAt: timestampValue(entry.data.updatedAt),
        removedAt: timestampValue(entry.data.removedAt)
      });
      count("co_teachers");
    }
  });
}

async function backfillMaterials(client) {
  await forEachClass(async (classDoc, classData) => {
    const materialsSnapshot = await classDoc.ref.collection("materials").get();
    for (const materialDoc of materialsSnapshot.docs) {
      const data = materialDoc.data();
      let teacherId = stringValue(data.teacherId) || stringValue(classData.teacherId) || "legacy-teacher";
      teacherId = await ensureAccount(client, teacherId, {
        role: "teacher",
        email: lowerString(data.teacherEmail) || legacyEmail(teacherId),
        displayName: stringValue(classData.teacherName) || "Legacy teacher"
      }) || teacherId;
      await upsertMaterial(client, {
        id: materialDoc.id,
        classId: classDoc.id,
        teacherId,
        title: stringValue(data.title) || stringValue(data.fileName) || "Untitled material",
        kind: stringValue(data.kind) || stringValue(data.type) || "document",
        materialType: stringValue(data.materialType),
        sourceMode: stringValue(data.sourceMode) || (data.fileName || data.storagePath ? "file" : "pasted"),
        status: normalizeMaterialStatus(data.status),
        activeForStudents: booleanValue(data.activeForStudents, booleanValue(data.visibleToStudents, false)),
        citationsRequired: booleanValue(data.citationsRequired, false),
        teacherOnly: booleanValue(data.teacherOnly, false),
        priority: normalizePriority(data.priority),
        fileName: stringOrNull(data.fileName) || stringOrNull(data.name),
        contentType: stringOrNull(data.contentType) || stringOrNull(data.mimeType),
        fileSize: numberValue(data.fileSize) || numberValue(data.size),
        characterCount: numberValue(data.characterCount),
        chunkCount: numberValue(data.chunkCount),
        storageBucket: stringOrNull(data.storageBucket) || stringOrNull(data.bucket),
        storagePath: stringOrNull(data.storagePath) || stringOrNull(data.path),
        storageUri: stringOrNull(data.storageUri) || stringOrNull(data.gcsUri),
        fileUrl: stringOrNull(data.fileUrl) || stringOrNull(data.downloadUrl),
        searchMetadataSource: "firestore_backfill",
        metadata: firestoreJson(data),
        createdAt: timestampValue(data.createdAt) || timestampValue(data.addedAt),
        updatedAt: timestampValue(data.updatedAt),
        deletedAt: timestampValue(data.deletedAt)
      });
      knownMaterials.add(materialDoc.id);
      count("materials");
    }

    const jobsSnapshot = await classDoc.ref.collection("materialJobs").get();
    for (const jobDoc of jobsSnapshot.docs) {
      const data = jobDoc.data();
      await upsertMaterialJob(client, {
        id: jobDoc.id,
        classId: classDoc.id,
        materialId: knownMaterialId(stringOrNull(data.materialId)),
        step: stringValue(data.step) || stringValue(data.status) || "processing",
        status: normalizeJobStatus(data.status, data.step),
        percent: clampPercent(numberValue(data.percent) || numberValue(data.progress)),
        detail: stringValue(data.detail) || stringValue(data.message),
        error: stringOrNull(data.error),
        completedChunks: nullableNumber(data.completedChunks),
        totalChunks: nullableNumber(data.totalChunks),
        metadata: firestoreJson(data),
        createdAt: timestampValue(data.createdAt),
        updatedAt: timestampValue(data.updatedAt)
      });
      count("material_jobs");
    }
  });
}

async function backfillConversationsMessagesAttachmentsReviews(client) {
  await forEachClass(async (classDoc, classData) => {
    const conversationsSnapshot = await classDoc.ref.collection("conversations").get();
    for (const conversationDoc of conversationsSnapshot.docs) {
      const data = conversationDoc.data();
      const roster = resolveRoster(classDoc.id, data);
      let studentId = stringOrNull(data.studentId) || roster?.studentId || null;
      const studentEmail = lowerString(data.studentEmail) || roster?.studentEmail || "";
      const studentName = stringValue(data.studentName) || roster?.displayName || "";
      let teacherId = stringOrNull(data.teacherId) || stringOrNull(classData.teacherId) || null;
      if (studentId) {
        studentId = await ensureAccount(client, studentId, {
          role: "student",
          email: studentEmail || legacyEmail(studentId),
          displayName: studentName || "Student"
        }) || studentId;
      }
      if (teacherId) {
        teacherId = await ensureAccount(client, teacherId, {
          role: "teacher",
          email: legacyEmail(teacherId),
          displayName: stringValue(classData.teacherName) || "Legacy teacher"
        }) || teacherId;
      }

      if (hasSection("conversations")) {
        await upsertConversation(client, {
          id: conversationDoc.id,
          classId: classDoc.id,
          studentId,
          studentEmail,
          studentName,
          teacherId,
          teacherName: stringValue(data.teacherName) || stringValue(classData.teacherName),
          title: stringValue(data.title),
          assignment: stringValue(data.assignment),
          modelId: stringValue(data.modelId),
          messageCount: numberValue(data.messageCount),
          tags: stringArray(data.tags),
          metadata: firestoreJson(data),
          createdAt: timestampValue(data.createdAt),
          updatedAt: timestampValue(data.updatedAt),
          lastMessageAt: timestampValue(data.lastMessageAt),
          deletedAt: timestampValue(data.deletedAt)
        });
        knownConversations.add(conversationDoc.id);
        count("conversations");
      }

      if (hasSection("messages")) {
        const messagesSnapshot = await conversationDoc.ref.collection("messages").get();
        for (const messageDoc of messagesSnapshot.docs) {
          const message = messageDoc.data();
          await upsertMessage(client, {
            conversationId: conversationDoc.id,
            id: messageDoc.id,
            classId: classDoc.id,
            role: normalizeRole(message.role),
            content: stringValue(message.content) || stringValue(message.text),
            modelId: stringOrNull(message.modelId),
            attachments: arrayValue(message.attachments),
            retrievalConfidence: jsonOrNull(message.retrievalConfidence),
            sources: arrayValue(message.sources),
            structuredOutput: jsonOrNull(message.structuredOutput),
            debugInfo: jsonOrNull(message.debugInfo),
            langgraphTrace: jsonOrNull(message.langgraphTrace),
            learningStrategyTelemetry: jsonOrNull(message.learningStrategyTelemetry),
            metadata: firestoreJson(message),
            createdAt: timestampValue(message.createdAt),
            updatedAt: timestampValue(message.updatedAt)
          });
          count("messages");
        }
      }

      if (hasSection("attachments")) {
        await backfillAttachmentCollection(client, conversationDoc.ref.collection("attachments"), classDoc.id, conversationDoc.id, studentId);
      }

      if (hasSection("reviews")) {
        const reviewData = objectValue(data.review);
        const hasReview = Object.keys(reviewData).length > 0 || data.reviewStatus || data.teacherNote || data.privateNote;
        if (hasReview) {
          const status = normalizeReviewStatus(data.reviewStatus || reviewData.status);
          await upsertConversationReview(client, {
            classId: classDoc.id,
            conversationId: conversationDoc.id,
            status,
            teacherNote: stringValue(data.teacherNote) || stringValue(data.privateNote) || stringValue(reviewData.teacherNote),
            reviewedBy: stringOrNull(data.reviewedBy) || stringOrNull(reviewData.reviewedBy),
            reviewedAt: timestampValue(data.reviewedAt) || timestampValue(reviewData.reviewedAt),
            metadata: firestoreJson({ review: reviewData, legacyConversation: data })
          });
          count("conversation_reviews");
        }
      }
    }
  });
}

async function backfillAttachmentCollection(client, collectionRef, classId, conversationId, fallbackStudentId) {
  const snapshot = await collectionRef.get();
  for (const doc of snapshot.docs) {
    const data = doc.data();
    const fileType = normalizeAttachmentFileType(data.fileType || data.type || data.mimeType);
    await upsertAttachment(client, {
      id: doc.id,
      conversationId,
      messageId: stringOrNull(data.messageId),
      classId,
      studentId: stringOrNull(data.studentId) || fallbackStudentId,
      fileName: stringValue(data.fileName) || stringValue(data.name) || "attachment",
      fileType,
      mimeType: stringValue(data.mimeType) || (fileType === "pdf" ? "application/pdf" : "image/*"),
      fileSize: numberValue(data.fileSize) || numberValue(data.size),
      storageKey: stringValue(data.storageKey) || stringValue(data.storagePath) || doc.id,
      storageBucket: stringOrNull(data.storageBucket),
      storagePath: stringOrNull(data.storagePath),
      uploadStatus: normalizeUploadStatus(data.uploadStatus || data.status),
      extractedText: stringOrNull(data.extractedText),
      pageCount: nullableNumber(data.pageCount),
      metadata: firestoreJson(data),
      createdAt: timestampValue(data.createdAt),
      updatedAt: timestampValue(data.updatedAt)
    });
    count("message_attachments");
  }
}

async function backfillStudentFeedback(client) {
  await forEachClass(async (classDoc) => {
    const snapshot = await classDoc.ref.collection("studentFeedback").get();
    for (const doc of snapshot.docs) {
      const data = doc.data();
      const roster = resolveRoster(classDoc.id, data);
      let studentId = stringOrNull(data.studentId) || roster?.studentId || null;
      const studentEmail = lowerString(data.studentEmail) || roster?.studentEmail || "";
      const studentName = stringValue(data.studentName) || roster?.displayName || "";
      if (studentId) {
        studentId = await ensureAccount(client, studentId, {
          role: "student",
          email: studentEmail || legacyEmail(studentId),
          displayName: studentName || "Student"
        }) || studentId;
      }
      await upsertStudentFeedback(client, {
        id: doc.id,
        classId: classDoc.id,
        conversationId: knownConversationId(stringOrNull(data.conversationId)),
        messageId: stringOrNull(data.messageId),
        studentId,
        studentEmail,
        studentName,
        kind: normalizeFeedbackKind(data.kind),
        promptReason: stringOrNull(data.promptReason),
        rating: stringOrNull(data.rating),
        comment: stringValue(data.comment) || stringValue(data.message),
        status: normalizeFeedbackStatus(data.status),
        teacherNote: stringValue(data.teacherNote),
        metadata: firestoreJson(data),
        createdAt: timestampValue(data.createdAt),
        updatedAt: timestampValue(data.updatedAt)
      });
      count("student_feedback");
    }
  });
}

async function backfillStudentSupport(client) {
  await forEachClass(async (classDoc) => {
    const snapshot = await classDoc.ref.collection("studentSupport").get();
    for (const doc of snapshot.docs) {
      const data = doc.data();
      const roster = resolveRoster(classDoc.id, data) || resolveRoster(classDoc.id, { studentId: doc.id });
      let studentId = stringOrNull(data.studentId) || roster?.studentId || (doc.id.includes("@") ? null : doc.id);
      const studentEmail = lowerString(data.studentEmail) || lowerString(data.email) || roster?.studentEmail || "";
      const displayName = stringValue(data.displayName) || stringValue(data.studentName) || roster?.displayName || "";
      if (studentId) {
        studentId = await ensureAccount(client, studentId, {
          role: "student",
          email: studentEmail || legacyEmail(studentId),
          displayName: displayName || "Student"
        }) || studentId;
      }
      await upsertStudentSupport(client, {
        id: `${classDoc.id}:${doc.id}`,
        classId: classDoc.id,
        studentId,
        studentEmail,
        displayName,
        chatBlocked: booleanValue(data.chatBlocked, false),
        supportNotes: stringValue(data.supportNotes) || stringValue(data.notes),
        metadata: firestoreJson(data),
        createdAt: timestampValue(data.createdAt),
        updatedAt: timestampValue(data.updatedAt)
      });
      count("student_support");
    }
  });
}

async function backfillLearningProfiles(client) {
  await forEachClass(async (classDoc) => {
    const snapshot = await classDoc.ref.collection("studentLearningProfiles").get();
    for (const doc of snapshot.docs) {
      const data = doc.data();
      const roster = resolveRoster(classDoc.id, data) || resolveRoster(classDoc.id, { studentId: doc.id });
      let studentId = stringOrNull(data.studentId) || roster?.studentId || (doc.id.includes("@") ? null : doc.id);
      const studentEmail = lowerString(data.studentEmail) || lowerString(data.email) || roster?.studentEmail || "";
      const studentName = stringValue(data.studentName) || stringValue(data.displayName) || roster?.displayName || "";
      if (studentId) {
        studentId = await ensureAccount(client, studentId, {
          role: "student",
          email: studentEmail || legacyEmail(studentId),
          displayName: studentName || "Student"
        }) || studentId;
      }
      const profileId = `${classDoc.id}:${doc.id}`;
      await upsertLearningProfile(client, {
        id: profileId,
        classId: classDoc.id,
        studentId,
        studentEmail,
        studentName,
        activeProfile: objectOrNull(data.activeProfile) || objectOrNull(data.profile),
        draftProfile: objectOrNull(data.draftProfile),
        confidence: normalizeConfidence(data.confidence),
        disabled: booleanValue(data.disabled, false),
        metadata: firestoreJson(data),
        approvedAt: timestampValue(data.approvedAt),
        createdAt: timestampValue(data.createdAt),
        updatedAt: timestampValue(data.updatedAt)
      });
      count("student_learning_profiles");

      const revisionsSnapshot = await doc.ref.collection("revisions").get();
      for (const revisionDoc of revisionsSnapshot.docs) {
        const revision = revisionDoc.data();
        await insertLearningProfileRevision(client, {
          profileId,
          classId: classDoc.id,
          studentId,
          revisionType: normalizeRevisionType(revision.revisionType || revision.type),
          previousProfile: objectOrNull(revision.previousProfile),
          nextProfile: objectOrNull(revision.nextProfile) || objectOrNull(revision.profile),
          confidence: nullableConfidence(revision.confidence),
          createdBy: stringOrNull(revision.createdBy),
          metadata: firestoreJson(revision),
          createdAt: timestampValue(revision.createdAt)
        });
        count("learning_profile_revisions");
      }
    }
  });
}

async function backfillOperationalLogs(client) {
  await backfillAuditLogs(client);
  await backfillSecurityEvents(client);
  await backfillChatErrorReferences(client);
}

async function backfillAuditLogs(client) {
  const snapshot = await db.collection("auditLogs").get();
  for (const doc of snapshot.docs) {
    const data = doc.data();
    let actorId = stringOrNull(data.actorId) || stringOrNull(data.uid);
    if (actorId) {
      actorId = await ensureAccount(client, actorId, {
        role: data.actorRole === "teacher" ? "teacher" : "student",
        email: legacyEmail(actorId),
        displayName: "Legacy account"
      }) || actorId;
    }
    await insertAuditLog(client, {
      actorId,
      actorRole: stringOrNull(data.actorRole),
      eventType: stringValue(data.eventType) || stringValue(data.type) || "legacy_event",
      resourceType: stringOrNull(data.resourceType),
      resourceId: stringOrNull(data.resourceId),
      route: stringOrNull(data.route),
      ipHash: stringOrNull(data.ipHash),
      userAgent: stringOrNull(data.userAgent),
      metadata: firestoreJson(data),
      createdAt: timestampValue(data.createdAt)
    });
    count("audit_logs");
  }
}

async function backfillSecurityEvents(client) {
  const snapshot = await db.collection("securityEvents").get();
  for (const doc of snapshot.docs) {
    const data = doc.data();
    let actorId = stringOrNull(data.actorId) || stringOrNull(data.uid);
    if (actorId) {
      actorId = await ensureAccount(client, actorId, {
        role: "student",
        email: legacyEmail(actorId),
        displayName: "Legacy account"
      }) || actorId;
    }
    await insertSecurityEvent(client, {
      actorId,
      eventType: stringValue(data.eventType) || stringValue(data.type) || "legacy_security_event",
      severity: normalizeSeverity(data.severity),
      route: stringOrNull(data.route),
      ipHash: stringOrNull(data.ipHash),
      userAgent: stringOrNull(data.userAgent),
      metadata: firestoreJson(data),
      createdAt: timestampValue(data.createdAt)
    });
    count("security_events");
  }
}

async function backfillChatErrorReferences(client) {
  const snapshot = await db.collection("chatErrorReferences").get();
  for (const doc of snapshot.docs) {
    const data = doc.data();
    await upsertChatErrorReference(client, {
      id: doc.id,
      classId: stringOrNull(data.classId),
      conversationId: stringOrNull(data.conversationId),
      messageId: stringOrNull(data.messageId),
      errorCode: stringValue(data.errorCode) || "legacy_error",
      errorMessage: stringOrNull(data.errorMessage),
      provider: stringOrNull(data.provider),
      modelId: stringOrNull(data.modelId),
      metadata: firestoreJson(data),
      createdAt: timestampValue(data.createdAt),
      updatedAt: timestampValue(data.updatedAt)
    });
    count("chat_error_references");
  }
}

async function loadExistingAccountIds(client) {
  if (!client) {
    return;
  }
  const result = await client.query("select id, email_normalized from accounts");
  for (const row of result.rows) {
    knownAccounts.add(row.id);
    if (row.email_normalized) {
      accountIdsByEmail.set(row.email_normalized, row.id);
    }
  }
}

async function loadClassCacheFromFirestore() {
  await forEachClass(async (classDoc, data) => {
    classesById.set(classDoc.id, {
      id: classDoc.id,
      teacherId: stringValue(data.teacherId),
      teacherName: stringValue(data.teacherName),
      name: stringValue(data.name)
    });
  });
}

async function forEachClass(callback) {
  if (classesById.size === 0) {
    const snapshot = args.classId
      ? { docs: [await db.collection("classes").doc(args.classId).get()].filter((doc) => doc.exists) }
      : await db.collection("classes").get();
    for (const doc of snapshot.docs) {
      const data = doc.data();
      classesById.set(doc.id, {
        id: doc.id,
        teacherId: stringValue(data.teacherId),
        teacherName: stringValue(data.teacherName),
        name: stringValue(data.name)
      });
    }
  }

  for (const classId of classesById.keys()) {
    const doc = await db.collection("classes").doc(classId).get();
    if (doc.exists) {
      await callback(doc, doc.data() || {});
    }
  }
}

function rememberRoster(classId, key, record) {
  if (!key) {
    return;
  }
  rosterByClassAndStudent.set(`${classId}:${key}`, record);
  if (record.studentEmail) {
    rosterByClassAndStudent.set(`${classId}:${record.studentEmail}`, record);
  }
}

function resolveRoster(classId, data) {
  const studentId = stringOrNull(data.studentId) || stringOrNull(data.uid);
  const email = lowerString(data.studentEmail) || lowerString(data.email);
  return rosterByClassAndStudent.get(`${classId}:${studentId}`) || rosterByClassAndStudent.get(`${classId}:${email}`) || null;
}

function knownConversationId(conversationId) {
  if (!conversationId) {
    return null;
  }
  return knownConversations.has(conversationId) ? conversationId : null;
}

function knownMaterialId(materialId) {
  if (!materialId) {
    return null;
  }
  if (!knownMaterials.has(materialId)) {
    count("material_jobs_missing_material");
    return null;
  }
  return materialId;
}

async function ensureAccount(client, id, fallback) {
  if (!id) {
    return null;
  }
  if (accountAliases.has(id)) {
    return accountAliases.get(id);
  }
  if (knownAccounts.has(id)) {
    return id;
  }
  return await upsertAccount(client, {
    id,
    firebaseUid: id,
    email: fallback.email || legacyEmail(id),
    displayName: fallback.displayName || fallback.email || "Legacy account",
    username: fallback.email || legacyEmail(id),
    role: fallback.role || "student",
    legacyClassId: null,
    legacyClassIds: [],
    profile: {
      legacyPlaceholder: true,
      backfilledFromFirestore: true
    },
    placeholder: true
  });
}

async function upsertAccount(client, input) {
  const normalizedEmail = lowerString(input.email);
  const existingAccountIdForEmail = normalizedEmail ? accountIdsByEmail.get(normalizedEmail) : null;
  if (existingAccountIdForEmail && existingAccountIdForEmail !== input.id) {
    knownAccounts.add(input.id);
    accountAliases.set(input.id, existingAccountIdForEmail);
    count(input.placeholder ? "accounts_placeholder_alias" : "accounts_alias");
    return existingAccountIdForEmail;
  }

  if (dryRun) {
    knownAccounts.add(input.id);
    if (normalizedEmail) {
      accountIdsByEmail.set(normalizedEmail, input.id);
    }
    if (input.placeholder) {
      count("accounts_placeholder");
    }
    return input.id;
  }
  await client.query(
    `insert into accounts (
      id, firebase_uid, email, display_name, username, role, status,
      legacy_class_id, legacy_class_ids, profile, created_at, updated_at
    ) values (
      $1, $2, $3, $4, $5, $6, 'active',
      $7, $8, $9::jsonb, coalesce($10, now()), coalesce($11, now())
    )
    on conflict (id) do update set
      firebase_uid = excluded.firebase_uid,
      email = excluded.email,
      display_name = excluded.display_name,
      username = excluded.username,
      role = excluded.role,
      legacy_class_id = excluded.legacy_class_id,
      legacy_class_ids = excluded.legacy_class_ids,
      profile = accounts.profile || excluded.profile`,
    [
      input.id,
      input.firebaseUid,
      input.email,
      input.displayName,
      input.username,
      input.role,
      input.legacyClassId,
      input.legacyClassIds,
      JSON.stringify(input.profile || {}),
      input.createdAt,
      input.updatedAt
    ]
  );
  knownAccounts.add(input.id);
  if (normalizedEmail) {
    accountIdsByEmail.set(normalizedEmail, input.id);
  }
  if (input.placeholder) {
    count("accounts_placeholder");
  }
  return input.id;
}

async function upsertClass(client, input) {
  if (dryRun) {
    return;
  }
  await client.query(
    `insert into classes (
      id, teacher_id, teacher_name, name, section, join_code, student_chat_enabled,
      appearance, theme_color, answer_policy, model_settings, notification_settings,
      privacy_settings, response_format, source_defaults, source_usage, tutor_access,
      behavior_title, behavior_instructions, default_assignment_context, opening_message,
      refusal_style, student_facing_instructions, firestore_snapshot, created_at, updated_at
    ) values (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10::jsonb, $11::jsonb, $12::jsonb,
      $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb,
      $18, $19, $20, $21,
      $22, $23, $24::jsonb, coalesce($25, now()), coalesce($26, now())
    )
    on conflict (id) do update set
      teacher_id = excluded.teacher_id,
      teacher_name = excluded.teacher_name,
      name = excluded.name,
      section = excluded.section,
      join_code = excluded.join_code,
      student_chat_enabled = excluded.student_chat_enabled,
      appearance = excluded.appearance,
      theme_color = excluded.theme_color,
      answer_policy = classes.answer_policy || excluded.answer_policy,
      model_settings = classes.model_settings || excluded.model_settings,
      notification_settings = classes.notification_settings || excluded.notification_settings,
      privacy_settings = classes.privacy_settings || excluded.privacy_settings,
      response_format = classes.response_format || excluded.response_format,
      source_defaults = classes.source_defaults || excluded.source_defaults,
      source_usage = classes.source_usage || excluded.source_usage,
      tutor_access = classes.tutor_access || excluded.tutor_access,
      behavior_title = excluded.behavior_title,
      behavior_instructions = excluded.behavior_instructions,
      default_assignment_context = excluded.default_assignment_context,
      opening_message = excluded.opening_message,
      refusal_style = excluded.refusal_style,
      student_facing_instructions = excluded.student_facing_instructions,
      firestore_snapshot = classes.firestore_snapshot || excluded.firestore_snapshot`,
    [
      input.id,
      input.teacherId,
      input.teacherName,
      input.name,
      input.section,
      input.joinCode,
      input.studentChatEnabled,
      input.appearance,
      input.themeColor,
      JSON.stringify(input.answerPolicy),
      JSON.stringify(input.modelSettings),
      JSON.stringify(input.notificationSettings),
      JSON.stringify(input.privacySettings),
      JSON.stringify(input.responseFormat),
      JSON.stringify(input.sourceDefaults),
      JSON.stringify(input.sourceUsage),
      JSON.stringify(input.tutorAccess),
      input.behaviorTitle,
      input.behaviorInstructions,
      input.defaultAssignmentContext,
      input.openingMessage,
      input.refusalStyle,
      input.studentFacingInstructions,
      JSON.stringify(input.firestoreSnapshot),
      input.createdAt,
      input.updatedAt
    ]
  );
}

async function upsertEnrollment(client, input) {
  if (dryRun) {
    return;
  }
  if (!input.studentId) {
    await client.query(
      `insert into class_enrollments (
        class_id, student_id, student_email, display_name, status, chat_blocked,
        firestore_document_id, metadata, created_at, updated_at, removed_at
      ) values (
        $1, NULL, $2, $3, $4, $5,
        $6, $7::jsonb, coalesce($8, now()), coalesce($9, now()), $10
      )
      on conflict (class_id, student_email_normalized) where (student_email <> '') do update set
        display_name = excluded.display_name,
        status = excluded.status,
        chat_blocked = excluded.chat_blocked,
        firestore_document_id = excluded.firestore_document_id,
        metadata = class_enrollments.metadata || excluded.metadata,
        removed_at = excluded.removed_at`,
      [
        input.classId,
        input.studentEmail,
        input.displayName,
        input.status,
        input.chatBlocked,
        input.firestoreDocumentId,
        JSON.stringify(input.metadata),
        input.createdAt,
        input.updatedAt,
        input.removedAt
      ]
    );
    return;
  }

  await client.query(
    `insert into class_enrollments (
      class_id, student_id, student_email, display_name, status, chat_blocked,
      firestore_document_id, metadata, created_at, updated_at, removed_at
    ) values (
      $1, $2, $3, $4, $5, $6,
      $7, $8::jsonb, coalesce($9, now()), coalesce($10, now()), $11
    )
    on conflict (class_id, student_id) where (student_id is not null) do update set
      student_email = excluded.student_email,
      display_name = excluded.display_name,
      status = excluded.status,
      chat_blocked = excluded.chat_blocked,
      firestore_document_id = excluded.firestore_document_id,
      metadata = class_enrollments.metadata || excluded.metadata,
      removed_at = excluded.removed_at`,
    [
      input.classId,
      input.studentId,
      input.studentEmail,
      input.displayName,
      input.status,
      input.chatBlocked,
      input.firestoreDocumentId,
      JSON.stringify(input.metadata),
      input.createdAt,
      input.updatedAt,
      input.removedAt
    ]
  );
}

async function upsertCoTeacher(client, input) {
  if (dryRun) {
    return;
  }
  await client.query(
    `insert into co_teachers (
      class_id, teacher_id, email, display_name, status, invited_by, permissions,
      created_at, updated_at, removed_at
    ) values (
      $1, $2, $3, $4, $5, $6, $7::jsonb,
      coalesce($8, now()), coalesce($9, now()), $10
    )
    on conflict (class_id, teacher_id) do update set
      email = excluded.email,
      display_name = excluded.display_name,
      status = excluded.status,
      invited_by = excluded.invited_by,
      permissions = co_teachers.permissions || excluded.permissions,
      removed_at = excluded.removed_at`,
    [
      input.classId,
      input.teacherId,
      input.email,
      input.displayName,
      input.status,
      input.invitedBy,
      JSON.stringify(input.permissions),
      input.createdAt,
      input.updatedAt,
      input.removedAt
    ]
  );
}

async function upsertMaterial(client, input) {
  if (dryRun) {
    return;
  }
  await client.query(
    `insert into materials (
      id, class_id, teacher_id, title, kind, material_type, source_mode, status,
      active_for_students, citations_required, teacher_only, priority,
      file_name, content_type, file_size, character_count, chunk_count,
      storage_bucket, storage_path, storage_uri, file_url, search_metadata_source,
      metadata, created_at, updated_at, deleted_at
    ) values (
      $1, $2, $3, $4, $5, $6, $7, $8,
      $9, $10, $11, $12,
      $13, $14, $15, $16, $17,
      $18, $19, $20, $21, $22,
      $23::jsonb, coalesce($24, now()), coalesce($25, now()), $26
    )
    on conflict (id) do update set
      class_id = excluded.class_id,
      teacher_id = excluded.teacher_id,
      title = excluded.title,
      kind = excluded.kind,
      material_type = excluded.material_type,
      source_mode = excluded.source_mode,
      status = excluded.status,
      active_for_students = excluded.active_for_students,
      citations_required = excluded.citations_required,
      teacher_only = excluded.teacher_only,
      priority = excluded.priority,
      file_name = excluded.file_name,
      content_type = excluded.content_type,
      file_size = excluded.file_size,
      character_count = excluded.character_count,
      chunk_count = excluded.chunk_count,
      storage_bucket = excluded.storage_bucket,
      storage_path = excluded.storage_path,
      storage_uri = excluded.storage_uri,
      file_url = excluded.file_url,
      search_metadata_source = excluded.search_metadata_source,
      metadata = materials.metadata || excluded.metadata,
      deleted_at = excluded.deleted_at`,
    [
      input.id,
      input.classId,
      input.teacherId,
      input.title,
      input.kind,
      input.materialType,
      input.sourceMode,
      input.status,
      input.activeForStudents,
      input.citationsRequired,
      input.teacherOnly,
      input.priority,
      input.fileName,
      input.contentType,
      input.fileSize,
      input.characterCount,
      input.chunkCount,
      input.storageBucket,
      input.storagePath,
      input.storageUri,
      input.fileUrl,
      input.searchMetadataSource,
      JSON.stringify(input.metadata),
      input.createdAt,
      input.updatedAt,
      input.deletedAt
    ]
  );
}

async function upsertMaterialJob(client, input) {
  if (dryRun) {
    return;
  }
  await client.query(
    `insert into material_jobs (
      id, class_id, material_id, step, status, percent, detail, error,
      completed_chunks, total_chunks, metadata, created_at, updated_at
    ) values (
      $1, $2, $3, $4, $5, $6, $7, $8,
      $9, $10, $11::jsonb, coalesce($12, now()), coalesce($13, now())
    )
    on conflict (id) do update set
      class_id = excluded.class_id,
      material_id = excluded.material_id,
      step = excluded.step,
      status = excluded.status,
      percent = excluded.percent,
      detail = excluded.detail,
      error = excluded.error,
      completed_chunks = excluded.completed_chunks,
      total_chunks = excluded.total_chunks,
      metadata = material_jobs.metadata || excluded.metadata`,
    [
      input.id,
      input.classId,
      input.materialId,
      input.step,
      input.status,
      input.percent,
      input.detail,
      input.error,
      input.completedChunks,
      input.totalChunks,
      JSON.stringify(input.metadata),
      input.createdAt,
      input.updatedAt
    ]
  );
}

async function upsertConversation(client, input) {
  if (dryRun) {
    return;
  }
  await client.query(
    `insert into conversations (
      id, class_id, student_id, student_email, student_name, teacher_id, teacher_name,
      title, assignment, model_id, message_count, tags, metadata,
      created_at, updated_at, last_message_at, deleted_at
    ) values (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11, $12, $13::jsonb,
      coalesce($14, now()), coalesce($15, now()), $16, $17
    )
    on conflict (id) do update set
      class_id = excluded.class_id,
      student_id = excluded.student_id,
      student_email = excluded.student_email,
      student_name = excluded.student_name,
      teacher_id = excluded.teacher_id,
      teacher_name = excluded.teacher_name,
      title = excluded.title,
      assignment = excluded.assignment,
      model_id = excluded.model_id,
      message_count = excluded.message_count,
      tags = excluded.tags,
      metadata = conversations.metadata || excluded.metadata,
      last_message_at = excluded.last_message_at,
      deleted_at = excluded.deleted_at`,
    [
      input.id,
      input.classId,
      input.studentId,
      input.studentEmail,
      input.studentName,
      input.teacherId,
      input.teacherName,
      input.title,
      input.assignment,
      input.modelId,
      input.messageCount,
      input.tags,
      JSON.stringify(input.metadata),
      input.createdAt,
      input.updatedAt,
      input.lastMessageAt,
      input.deletedAt
    ]
  );
}

async function upsertMessage(client, input) {
  if (dryRun) {
    return;
  }
  await client.query(
    `insert into messages (
      conversation_id, id, class_id, role, content, model_id, attachments,
      retrieval_confidence, sources, structured_output, debug_info, langgraph_trace,
      learning_strategy_telemetry, metadata, created_at, updated_at
    ) values (
      $1, $2, $3, $4, $5, $6, $7::jsonb,
      $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb,
      $13::jsonb, $14::jsonb, coalesce($15, now()), coalesce($16, now())
    )
    on conflict (conversation_id, id) do update set
      role = excluded.role,
      content = excluded.content,
      model_id = excluded.model_id,
      attachments = excluded.attachments,
      retrieval_confidence = excluded.retrieval_confidence,
      sources = excluded.sources,
      structured_output = excluded.structured_output,
      debug_info = excluded.debug_info,
      langgraph_trace = excluded.langgraph_trace,
      learning_strategy_telemetry = excluded.learning_strategy_telemetry,
      metadata = messages.metadata || excluded.metadata`,
    [
      input.conversationId,
      input.id,
      input.classId,
      input.role,
      input.content,
      input.modelId,
      JSON.stringify(input.attachments),
      JSON.stringify(input.retrievalConfidence),
      JSON.stringify(input.sources),
      JSON.stringify(input.structuredOutput),
      JSON.stringify(input.debugInfo),
      JSON.stringify(input.langgraphTrace),
      JSON.stringify(input.learningStrategyTelemetry),
      JSON.stringify(input.metadata),
      input.createdAt,
      input.updatedAt
    ]
  );
}

async function upsertAttachment(client, input) {
  if (dryRun) {
    return;
  }
  await client.query(
    `insert into message_attachments (
      id, conversation_id, message_id, class_id, student_id, file_name, file_type,
      mime_type, file_size, storage_key, storage_bucket, storage_path, upload_status,
      extracted_text, page_count, metadata, created_at, updated_at
    ) values (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11, $12, $13,
      $14, $15, $16::jsonb, coalesce($17, now()), coalesce($18, now())
    )
    on conflict (id) do update set
      conversation_id = excluded.conversation_id,
      message_id = excluded.message_id,
      class_id = excluded.class_id,
      student_id = excluded.student_id,
      file_name = excluded.file_name,
      file_type = excluded.file_type,
      mime_type = excluded.mime_type,
      file_size = excluded.file_size,
      storage_key = excluded.storage_key,
      storage_bucket = excluded.storage_bucket,
      storage_path = excluded.storage_path,
      upload_status = excluded.upload_status,
      extracted_text = excluded.extracted_text,
      page_count = excluded.page_count,
      metadata = message_attachments.metadata || excluded.metadata`,
    [
      input.id,
      input.conversationId,
      input.messageId,
      input.classId,
      input.studentId,
      input.fileName,
      input.fileType,
      input.mimeType,
      input.fileSize,
      input.storageKey,
      input.storageBucket,
      input.storagePath,
      input.uploadStatus,
      input.extractedText,
      input.pageCount,
      JSON.stringify(input.metadata),
      input.createdAt,
      input.updatedAt
    ]
  );
}

async function upsertStudentFeedback(client, input) {
  if (dryRun) {
    return;
  }
  await client.query(
    `insert into student_feedback (
      id, class_id, conversation_id, message_id, student_id, student_email, student_name,
      kind, prompt_reason, rating, comment, status, teacher_note, metadata,
      created_at, updated_at
    ) values (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11, $12, $13, $14::jsonb,
      coalesce($15, now()), coalesce($16, now())
    )
    on conflict (id) do update set
      conversation_id = excluded.conversation_id,
      message_id = excluded.message_id,
      student_id = excluded.student_id,
      student_email = excluded.student_email,
      student_name = excluded.student_name,
      kind = excluded.kind,
      prompt_reason = excluded.prompt_reason,
      rating = excluded.rating,
      comment = excluded.comment,
      status = excluded.status,
      teacher_note = excluded.teacher_note,
      metadata = student_feedback.metadata || excluded.metadata`,
    [
      input.id,
      input.classId,
      input.conversationId,
      input.messageId,
      input.studentId,
      input.studentEmail,
      input.studentName,
      input.kind,
      input.promptReason,
      input.rating,
      input.comment,
      input.status,
      input.teacherNote,
      JSON.stringify(input.metadata),
      input.createdAt,
      input.updatedAt
    ]
  );
}

async function upsertConversationReview(client, input) {
  if (dryRun) {
    return;
  }
  await client.query(
    `insert into conversation_reviews (
      class_id, conversation_id, status, teacher_note, reviewed_by, reviewed_at,
      metadata, created_at, updated_at
    ) values (
      $1, $2, $3, $4, $5, $6,
      $7::jsonb, now(), now()
    )
    on conflict (class_id, conversation_id) do update set
      status = excluded.status,
      teacher_note = excluded.teacher_note,
      reviewed_by = excluded.reviewed_by,
      reviewed_at = excluded.reviewed_at,
      metadata = conversation_reviews.metadata || excluded.metadata`,
    [
      input.classId,
      input.conversationId,
      input.status,
      input.teacherNote,
      input.reviewedBy,
      input.reviewedAt,
      JSON.stringify(input.metadata)
    ]
  );
}

async function upsertStudentSupport(client, input) {
  if (dryRun) {
    return;
  }
  await client.query(
    `insert into student_support (
      id, class_id, student_id, student_email, display_name, chat_blocked,
      support_notes, metadata, created_at, updated_at
    ) values (
      $1, $2, $3, $4, $5, $6,
      $7, $8::jsonb, coalesce($9, now()), coalesce($10, now())
    )
    on conflict (id) do update set
      student_id = coalesce(excluded.student_id, student_support.student_id),
      student_email = excluded.student_email,
      display_name = excluded.display_name,
      chat_blocked = excluded.chat_blocked,
      support_notes = excluded.support_notes,
      metadata = student_support.metadata || excluded.metadata`,
    [
      input.id,
      input.classId,
      input.studentId,
      input.studentEmail,
      input.displayName,
      input.chatBlocked,
      input.supportNotes,
      JSON.stringify(input.metadata),
      input.createdAt,
      input.updatedAt
    ]
  );
}

async function upsertLearningProfile(client, input) {
  if (dryRun) {
    return;
  }
  await client.query(
    `insert into student_learning_profiles (
      id, class_id, student_id, student_email, student_name, active_profile,
      draft_profile, confidence, disabled, metadata, approved_at, created_at, updated_at
    ) values (
      $1, $2, $3, $4, $5, $6::jsonb,
      $7::jsonb, $8, $9, $10::jsonb, $11, coalesce($12, now()), coalesce($13, now())
    )
    on conflict (id) do update set
      student_id = coalesce(excluded.student_id, student_learning_profiles.student_id),
      student_email = coalesce(nullif(excluded.student_email, ''), student_learning_profiles.student_email),
      student_name = coalesce(nullif(excluded.student_name, ''), student_learning_profiles.student_name),
      active_profile = excluded.active_profile,
      draft_profile = excluded.draft_profile,
      confidence = excluded.confidence,
      disabled = excluded.disabled,
      metadata = student_learning_profiles.metadata || excluded.metadata,
      approved_at = coalesce(excluded.approved_at, student_learning_profiles.approved_at)`,
    [
      input.id,
      input.classId,
      input.studentId,
      input.studentEmail,
      input.studentName,
      JSON.stringify(input.activeProfile),
      JSON.stringify(input.draftProfile),
      input.confidence,
      input.disabled,
      JSON.stringify(input.metadata),
      input.approvedAt,
      input.createdAt,
      input.updatedAt
    ]
  );
}

async function insertLearningProfileRevision(client, input) {
  if (dryRun) {
    return;
  }
  await client.query(
    `insert into learning_profile_revisions (
      profile_id, class_id, student_id, revision_type, previous_profile, next_profile,
      confidence, created_by, metadata, created_at
    ) values (
      $1, $2, $3, $4, $5::jsonb, $6::jsonb,
      $7, $8, $9::jsonb, coalesce($10, now())
    )`,
    [
      input.profileId,
      input.classId,
      input.studentId,
      input.revisionType,
      JSON.stringify(input.previousProfile),
      JSON.stringify(input.nextProfile),
      input.confidence,
      input.createdBy,
      JSON.stringify(input.metadata),
      input.createdAt
    ]
  );
}

async function insertAuditLog(client, input) {
  if (dryRun) {
    return;
  }
  await client.query(
    `insert into audit_logs (
      actor_id, actor_role, event_type, resource_type, resource_id, route,
      ip_hash, user_agent, metadata, created_at
    ) values (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9::jsonb, coalesce($10, now())
    )`,
    [
      input.actorId,
      input.actorRole,
      input.eventType,
      input.resourceType,
      input.resourceId,
      input.route,
      input.ipHash,
      input.userAgent,
      JSON.stringify(input.metadata),
      input.createdAt
    ]
  );
}

async function insertSecurityEvent(client, input) {
  if (dryRun) {
    return;
  }
  await client.query(
    `insert into security_events (
      actor_id, event_type, severity, route, ip_hash, user_agent, metadata, created_at
    ) values (
      $1, $2, $3, $4, $5, $6, $7::jsonb, coalesce($8, now())
    )`,
    [
      input.actorId,
      input.eventType,
      input.severity,
      input.route,
      input.ipHash,
      input.userAgent,
      JSON.stringify(input.metadata),
      input.createdAt
    ]
  );
}

async function upsertChatErrorReference(client, input) {
  if (dryRun) {
    return;
  }
  await client.query(
    `insert into chat_error_references (
      id, class_id, conversation_id, message_id, error_code, error_message,
      provider, model_id, metadata, created_at, updated_at
    ) values (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9::jsonb, coalesce($10, now()), coalesce($11, now())
    )
    on conflict (id) do update set
      class_id = excluded.class_id,
      conversation_id = excluded.conversation_id,
      message_id = excluded.message_id,
      error_code = excluded.error_code,
      error_message = excluded.error_message,
      provider = excluded.provider,
      model_id = excluded.model_id,
      metadata = chat_error_references.metadata || excluded.metadata`,
    [
      input.id,
      input.classId,
      input.conversationId,
      input.messageId,
      input.errorCode,
      input.errorMessage,
      input.provider,
      input.modelId,
      JSON.stringify(input.metadata),
      input.createdAt,
      input.updatedAt
    ]
  );
}

async function withTransaction(callback) {
  if (!pool) {
    await callback(null);
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await callback(client);
    if (!dryRun) {
      await client.query("COMMIT");
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function initializeFirebaseAdmin() {
  if (getApps().length) {
    return getApps()[0];
  }

  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || "chandra-f6e13";
  const storageBucket = process.env.FIREBASE_STORAGE_BUCKET || "chandra-f6e13.firebasestorage.app";
  const credential = getFirebaseCredential();

  return initializeApp({
    credential,
    projectId,
    storageBucket
  });
}

function getFirebaseCredential() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    const parsed = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    return cert({
      clientEmail: parsed.clientEmail || parsed.client_email,
      privateKey: String(parsed.privateKey || parsed.private_key || "").replace(/\\n/g, "\n"),
      projectId: parsed.projectId || parsed.project_id
    });
  }

  if (process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    return cert({
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      projectId: process.env.FIREBASE_PROJECT_ID || "chandra-f6e13"
    });
  }

  return applicationDefault();
}

function hasSection(section) {
  return selectedSections.includes(section);
}

function needsClassCache() {
  return selectedSections.some((section) => [
    "roster",
    "co-teachers",
    "materials",
    "conversations",
    "messages",
    "attachments",
    "feedback",
    "reviews",
    "support",
    "profiles"
  ].includes(section));
}

function count(name, amount = 1) {
  counters.set(name, (counters.get(name) || 0) + amount);
}

function printSummary() {
  console.log(`Firestore to Postgres backfill ${dryRun ? "dry run" : "write"} complete.`);
  for (const [name, value] of [...counters.entries()].sort()) {
    console.log(`${name}: ${value}`);
  }
}

function parseArgs(argv) {
  const parsed = {
    classId: "",
    sections: [],
    write: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") {
      parsed.write = true;
    } else if (arg === "--dry-run") {
      parsed.write = false;
    } else if (arg === "--class-id") {
      parsed.classId = argv[++index] || "";
    } else if (arg.startsWith("--class-id=")) {
      parsed.classId = arg.slice("--class-id=".length);
    } else if (arg === "--section") {
      parsed.sections.push(...splitCsv(argv[++index] || ""));
    } else if (arg.startsWith("--section=")) {
      parsed.sections.push(...splitCsv(arg.slice("--section=".length)));
    } else if (arg === "--all") {
      parsed.sections = [];
    } else {
      fail(`Unknown argument "${arg}".`);
    }
  }

  return parsed;
}

function splitCsv(value) {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function readPostgresSslConfig() {
  const connectionString = getDatabaseUrl();
  const sslMode = process.env.CLOUD_SQL_POSTGRES_SSL_MODE?.trim().toLowerCase() || "";
  if (sslMode === "disable" || connectionString.includes("sslmode=disable")) {
    return false;
  }
  if (sslMode === "require" || connectionString.includes("sslmode=require")) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

function getDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL || process.env.CLOUD_SQL_POSTGRES_URL || process.env.CHANDRA_CLOUD_SQL_POSTGRES_URL || "";
  if (process.env.CLOUD_SQL_POSTGRES_SSL_MODE?.trim().toLowerCase() !== "disable" || !databaseUrl) {
    return databaseUrl;
  }

  const url = new URL(databaseUrl);
  url.searchParams.set("sslmode", "disable");
  return url.toString();
}

function firestoreJson(value) {
  return normalizeJson(value);
}

function normalizeJson(value) {
  if (value === undefined) {
    return null;
  }
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(normalizeJson);
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .map(([key, entryValue]) => [key, normalizeJson(entryValue)])
    );
  }
  return String(value);
}

function timestampValue(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (typeof value.toDate === "function") {
    return value.toDate();
  }
  if (typeof value === "object" && Number.isFinite(value.seconds)) {
    return new Date(value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1000000));
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function stringOrNull(value) {
  const clean = stringValue(value);
  return clean || null;
}

function lowerString(value) {
  return stringValue(value).toLowerCase();
}

function stringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => String(entry).trim()).filter(Boolean);
}

function arrayValue(value) {
  return Array.isArray(value) ? firestoreJson(value) : [];
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function objectOrNull(value) {
  const object = objectValue(value);
  return Object.keys(object).length ? firestoreJson(object) : null;
}

function jsonOrNull(value) {
  return value === undefined ? null : firestoreJson(value);
}

function booleanValue(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 0)));
}

function legacyEmail(id) {
  const cleanId = String(id || "unknown").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
  return `${cleanId}@legacy.invalid`;
}

function normalizeRole(value) {
  return value === "teacher" || value === "assistant" || value === "system" ? value : "student";
}

function normalizeEnrollmentStatus(value) {
  return value === "invited" || value === "removed" ? value : "active";
}

function normalizeCoTeacherStatus(value) {
  return value === "invited" || value === "removed" ? value : "active";
}

function normalizeMaterialStatus(value) {
  return value === "processing" || value === "ready" || value === "failed" || value === "deleted" ? value : "uploaded";
}

function normalizeJobStatus(status, step) {
  const value = status || step;
  return value === "queued" || value === "ready" || value === "failed" ? value : "processing";
}

function normalizePriority(value) {
  return value === "primary" || value === "low" ? value : "normal";
}

function normalizeAttachmentFileType(value) {
  const clean = String(value || "").toLowerCase();
  return clean.includes("pdf") ? "pdf" : "image";
}

function normalizeUploadStatus(value) {
  return value === "uploading" || value === "failed" ? value : "ready";
}

function normalizeFeedbackKind(value) {
  return value === "prompted" || value === "usage_request" ? value : "general";
}

function normalizeFeedbackStatus(value) {
  return value === "reviewed" || value === "resolved" ? value : "new";
}

function normalizeReviewStatus(value) {
  return value === "reviewed" || value === "needs_follow_up" || value === "resolved" ? value : "new";
}

function normalizeConfidence(value) {
  return value === "medium" || value === "high" ? value : "low";
}

function nullableConfidence(value) {
  return value === "low" || value === "medium" || value === "high" ? value : null;
}

function normalizeRevisionType(value) {
  return value === "draft_saved" || value === "approved" || value === "disabled" || value === "cleared"
    ? value
    : "draft_generated";
}

function normalizeSeverity(value) {
  return value === "warning" || value === "error" || value === "critical" ? value : "info";
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
