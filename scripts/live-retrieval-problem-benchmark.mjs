import { applicationDefault, cert, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { rankMaterialChunks } from "../lib/retrieval-ranking.ts";
import { createVertexEmbedding } from "../lib/vertex-embeddings.ts";

const classId = process.env.LIVE_RETRIEVAL_CLASS_ID;
const professorId = process.env.LIVE_RETRIEVAL_PROFESSOR_ID;

const cases = [
  { expectedPage: 28, query: "Is the problem asking me to plug 7-4x into f(x)=3-5x-2x^2 from the class homework?" },
  { expectedPage: 29, query: "I have to find roots of x^5 - 4x^4 - 32x^3. Is that in the uploaded textbook or homework?" },
  { expectedPage: 33, query: "Where is the trig equation with 8 tan(2x) - 5 = 3 over an interval? I think it is a homework problem." },
  { expectedPage: 40, query: "Tell me what section has the graphing problem x^2 - 4x + y^2 - 6y - 87 = 0." },
  { expectedPage: 49, query: "The problem says left limit at 3 is 0 and right limit at 3 is 4. Can you find that page?" },
  { expectedPage: 52, query: "Can you find the limit problem with (sqrt(z)-2)/(z-4), and tell me what topic it belongs to?" },
  { expectedPage: 56, query: "I need the notes or problem page for a limit at negative infinity involving ln(4 - 9t - t^3)." },
  { expectedPage: 72, query: "Which uploaded page helps with differentiating y=5x^6 - sec^-1(x)?" },
  { expectedPage: 95, query: "Find information to help a student with the box optimization problem using 45 square meters and no top." },
  { expectedPage: 99, query: "Where does the homework ask students to estimate e^0.1 with a linear approximation?" },
  { expectedPage: 107, query: "Can you locate the substitution problem with integral 90x^2 sin(2+6x^3) dx?" },
  { expectedPage: 109, query: "Is there a problem like sec^2(2t)(9+7tan(2t)-tan^2(2t)) in the class material?" },
  { expectedPage: 113, query: "Find the definite integral page for integral from 1 to 6 of 12x^3 - 9x^2 + 2." },
  { expectedPage: 115, query: "Tell me where to look for the definite u-substitution integral from 0 to pi of sin(z)cos^3(z)." },
  { expectedPage: 127, query: "Help me find the integration by parts problem with e^(2z) cos(z/4)." },
  { expectedPage: 128, query: "What part of the textbook explains the sec^6(3y) tan^2(3y) integral problem?" },
  { expectedPage: 129, query: "Can you find the trig substitution problem with 1 over sqrt(9x^2 - 36x + 37)?" },
  { expectedPage: 130, query: "Is this partial fractions integral in the uploaded homework: (z^2+2z+3)/((z-6)(z^2+4))?" },
  { expectedPage: 134, query: "Find the improper integral problem from minus infinity to infinity with 6w^3/(w^4+1)^2." },
  { expectedPage: 135, query: "Which page has the comparison test problem for integral from 4 to infinity e^-y divided by y?" },
  { expectedPage: 163, query: "Where is the series problem that gives partial sums sn=(5+8n^2)/(2-7n^2)?" },
  { expectedPage: 166, query: "Tell me about the series convergence problem with n^2 over n^3 minus 3." },
  { expectedPage: 167, query: "Can you find the alternating series test example with (-1)^(n-1)/(7+2n)?" },
  { expectedPage: 169, query: "Is the ratio test problem with e^(4n)/(n-2)! in these materials?" },
  { expectedPage: 175, query: "Find the Taylor series problem for ln(3+4x) about x=0 and give me the source page." },
  { expectedPage: 176, query: "What page helps with the Taylor series for the integral of (e^x - 1)/x?" },
  { expectedPage: 190, query: "Where can I find a vector function derivative problem with r(t)=<ln(t^2+1), t e^-t, 4>?" },
  { expectedPage: 192, query: "Find the arc length problem for r(t)=<1/3 t^3, 4t, sqrt(2)t^2> on 0 to 2." },
  { expectedPage: 193, query: "Tell me where the curvature problem for <cos(2t), -sin(2t), 4t> is in the PDF." },
  { expectedPage: 195, query: "Can you find the cylindrical coordinates problem for the point (4, -5, 2)?" }
];

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
const rows = [];

for (const benchmarkCase of cases) {
  const queryEmbedding = await createVertexEmbedding({
    taskType: "RETRIEVAL_QUERY",
    text: benchmarkCase.query
  });
  const vectorSnapshot = await db
    .collectionGroup("chunks")
    .where("professorId", "==", professorId)
    .where("classId", "==", classId)
    .findNearest({
      distanceMeasure: "COSINE",
      distanceResultField: "vectorDistance",
      limit: 16,
      queryVector: queryEmbedding.values,
      vectorField: "embedding"
    })
    .get();
  const ranked = rankMaterialChunks({
    candidates: await chunkDocsToCandidates(vectorSnapshot.docs),
    limit: 5,
    query: benchmarkCase.query,
    queryVector: queryEmbedding.values
  });
  const expectedRank = ranked.hits.findIndex((hit) => hit.chunk.pageNumber === benchmarkCase.expectedPage) + 1;
  const topHit = ranked.hits[0];
  const secondHit = ranked.hits[1];
  const scoreMargin = topHit && secondHit ? (topHit.score / secondHit.score - 1) * 100 : undefined;

  rows.push({
    confidence: ranked.confidence,
    expectedPage: benchmarkCase.expectedPage,
    expectedRank: expectedRank || "",
    marginPct: scoreMargin === undefined ? "" : scoreMargin.toFixed(2),
    query: benchmarkCase.query,
    top1: expectedRank === 1,
    top3: expectedRank >= 1 && expectedRank <= 3,
    topPage: topHit?.chunk.pageNumber ?? "",
    topScore: topHit?.score.toFixed(3) ?? "",
    vectorCandidates: vectorSnapshot.size
  });
}

const top1Accuracy = rows.filter((row) => row.top1).length / rows.length;
const top3Accuracy = rows.filter((row) => row.top3).length / rows.length;
const meanRank =
  rows.reduce((sum, row) => sum + (typeof row.expectedRank === "number" ? row.expectedRank : 6), 0) / rows.length;
const lowButCorrect = rows.filter((row) => row.top1 && row.confidence === "low").length;

console.table(
  rows.map((row, index) => ({
    n: index + 1,
    confidence: row.confidence,
    expectedPage: row.expectedPage,
    expectedRank: row.expectedRank,
    marginPct: row.marginPct,
    topPage: row.topPage,
    topScore: row.topScore
  }))
);

console.log(
  JSON.stringify(
    {
      cases: rows.length,
      lowButCorrect,
      meanExpectedRank: meanRank.toFixed(2),
      top1Accuracy: formatPercent(top1Accuracy),
      top3Accuracy: formatPercent(top3Accuracy),
      vectorCandidatesPerQuery: [...new Set(rows.map((row) => row.vectorCandidates))]
    },
    null,
    2
  )
);

const misses = rows.filter((row) => !row.top1);
if (misses.length) {
  console.log("\nMisses:");
  for (const miss of misses) {
    console.log(
      `expected page ${miss.expectedPage}, got ${miss.topPage}, expected rank ${miss.expectedRank || "not in top 5"}: ${
        miss.query
      }`
    );
  }
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

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}
