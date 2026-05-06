import { applicationDefault, cert, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createSourceMetadata, rankMaterialChunks } from "../lib/retrieval-ranking.ts";
import { createVertexEmbedding } from "../lib/vertex-embeddings.ts";

const classId = process.env.LIVE_RETRIEVAL_CLASS_ID;
const professorId = process.env.LIVE_RETRIEVAL_PROFESSOR_ID;
const queries = (
  process.env.LIVE_RETRIEVAL_QUERIES ??
  [
    "integration by parts practice problem",
    "improper integrals convergence",
    "partial fractions integration",
    "trigonometric substitution integral",
    "series convergence ratio test",
    "Taylor series approximation"
  ].join("\n")
)
  .split(/\n+/)
  .map((query) => query.trim())
  .filter(Boolean);

if (!classId || !professorId) {
  throw new Error("Set LIVE_RETRIEVAL_CLASS_ID and LIVE_RETRIEVAL_PROFESSOR_ID.");
}

initializeApp({
  credential: getCredential(),
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET
});

const db = getFirestore();
const materialCache = new Map();

const classSnapshot = await db.collection("classes").doc(classId).get();
if (!classSnapshot.exists) {
  throw new Error(`Class not found: ${classId}`);
}

const materialsSnapshot = await db.collection("classes").doc(classId).collection("materials").get();
const materialSummary = [];

for (const materialDoc of materialsSnapshot.docs) {
  const material = materialDoc.data();
  const chunksSnapshot = await materialDoc.ref.collection("chunks").get();

  materialSummary.push({
    embeddedChunks: chunksSnapshot.docs.filter((doc) => Boolean(doc.data().embedding)).length,
    materialId: materialDoc.id,
    status: material.status ?? "",
    title: material.title ?? "Uploaded material",
    totalChunks: chunksSnapshot.size
  });
}

console.log(
  JSON.stringify(
    {
      classId,
      classTitle: classSnapshot.data()?.title ?? classSnapshot.data()?.name ?? "",
      materialSummary,
      professorId,
      queryCount: queries.length
    },
    null,
    2
  )
);

for (const query of queries) {
  const queryEmbedding = await createVertexEmbedding({
    taskType: "RETRIEVAL_QUERY",
    text: query
  });
  const { candidates, error, vectorCandidateCount } = await getVectorCandidates(queryEmbedding.values);

  if (!candidates.length && error) {
    candidates.push(...(await getAllReadyChunkCandidates()));
  }

  const ranked = rankMaterialChunks({
    candidates,
    limit: 5,
    query,
    queryVector: queryEmbedding.values
  });

  console.log(`\nQUERY: ${query}`);
  if (error) {
    console.log(`Vector index unavailable; fallback used. ${error}`);
  }
  console.table(
    ranked.hits.map((hit, index) => ({
      content: hit.chunk.content.slice(0, 90),
      distance: hit.chunk.vectorDistance?.toFixed(4) ?? "",
      label: hit.chunk.label,
      page: hit.chunk.pageNumber ?? "",
      rank: index + 1,
      score: hit.score.toFixed(3),
      title: hit.document.title
    }))
  );
  console.log(
    JSON.stringify(
      {
        confidence: ranked.confidence,
        sources: createSourceMetadata(ranked.hits),
        vectorCandidates: vectorCandidateCount
      },
      null,
      2
    )
  );
}

async function getVectorCandidates(queryVector) {
  try {
    const snapshot = await db
      .collectionGroup("chunks")
      .where("professorId", "==", professorId)
      .where("classId", "==", classId)
      .findNearest({
        distanceMeasure: "COSINE",
        distanceResultField: "vectorDistance",
        limit: 16,
        queryVector,
        vectorField: "embedding"
      })
      .get();

    return {
      candidates: await chunkDocsToCandidates(snapshot.docs),
      error: "",
      vectorCandidateCount: snapshot.size
    };
  } catch (caughtError) {
    const message = caughtError instanceof Error ? caughtError.message : String(caughtError);

    return {
      candidates: [],
      error: message.split("\n")[0],
      vectorCandidateCount: 0
    };
  }
}

async function getAllReadyChunkCandidates() {
  const candidates = [];
  const materialsSnapshot = await db.collection("classes").doc(classId).collection("materials").get();

  for (const materialDoc of materialsSnapshot.docs) {
    const material = materialDoc.data();

    if (material.status !== "ready" || String(material.teacherId ?? material.professorId ?? "") !== professorId) {
      continue;
    }

    const chunksSnapshot = await materialDoc.ref.collection("chunks").get();
    candidates.push(...(await chunkDocsToCandidates(chunksSnapshot.docs)));
  }

  return candidates;
}

async function chunkDocsToCandidates(chunkDocs) {
  const candidates = [];

  for (const chunkDoc of chunkDocs) {
    const materialRef = chunkDoc.ref.parent.parent;

    if (!materialRef || materialRef.parent.parent?.id !== classId) {
      continue;
    }

    const material = await getMaterial(materialRef);

    if (!material || material.status !== "ready") {
      continue;
    }

    const chunkData = chunkDoc.data();
    const materialType = String(material.materialType ?? material.kind ?? "assignment");
    const title = String(material.title ?? "Uploaded material");

    candidates.push({
      chunk: {
        classId,
        content: String(chunkData.content ?? chunkData.chunk_text ?? ""),
        documentId: materialRef.id,
        id: chunkDoc.id,
        label: String(chunkData.label ?? chunkData.sectionHeading ?? "Uploaded excerpt"),
        materialId: materialRef.id,
        materialType,
        pageNumber: readPositiveNumber(chunkData.pageNumber ?? chunkData.pageStart ?? chunkData.page_start),
        problemNumbers: Array.isArray(chunkData.problemNumbers) ? chunkData.problemNumbers.map(String) : [],
        professorId: String(chunkData.professorId ?? chunkData.teacherId ?? ""),
        teacherId: String(chunkData.teacherId ?? chunkData.professorId ?? ""),
        title,
        vector: readVector(chunkData.embedding),
        vectorDistance: readPositiveNumber(chunkData.vectorDistance)
      },
      document: {
        chunks: [],
        classId,
        courseId: classId,
        id: materialRef.id,
        kind: materialType === "practice-solutions" ? "worked-example" : "assignment",
        materialType,
        professorId: String(material.professorId ?? material.teacherId ?? ""),
        status: "ready",
        teacherId: String(material.teacherId ?? material.professorId ?? ""),
        title,
        uploadedAt: new Date().toISOString()
      }
    });
  }

  return candidates;
}

async function getMaterial(materialRef) {
  const cached = materialCache.get(materialRef.path);

  if (cached) {
    return cached;
  }

  const materialPromise = materialRef.get().then((snapshot) => (snapshot.exists ? snapshot.data() : null));
  materialCache.set(materialRef.path, materialPromise);
  return materialPromise;
}

function getCredential() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    return cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY));
  }

  if (process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    return cert({
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      projectId: process.env.FIREBASE_PROJECT_ID
    });
  }

  return applicationDefault();
}

function readPositiveNumber(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : undefined;
}

function readVector(value) {
  if (Array.isArray(value)) {
    return value.map(Number).filter(Number.isFinite);
  }

  if (value && typeof value === "object" && typeof value.toArray === "function") {
    return value.toArray().map(Number).filter(Number.isFinite);
  }

  return undefined;
}
