import { collection, getDocs } from "firebase/firestore";
import { serverDb } from "./firebase-server";
import { documents } from "./sample-data";
import type { RetrievalHit, SourceDocument } from "./types";

export async function retrieveCourseContext(courseId: string, query: string, limit = 3): Promise<RetrievalHit[]> {
  const terms = tokenize(query);
  const classDocuments = await getClassMaterialDocuments(courseId);

  return [...documents, ...classDocuments]
    .filter((document) => document.courseId === courseId && document.status === "ready")
    .flatMap((document) =>
      document.chunks.map((chunk) => ({
        document,
        chunk,
        score: scoreChunk(chunk.content, terms)
      }))
    )
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

async function getClassMaterialDocuments(classId: string): Promise<SourceDocument[]> {
  if (!serverDb) {
    return [];
  }

  try {
    const db = serverDb;
    const materialsSnapshot = await getDocs(collection(db, "classes", classId, "materials"));
    const materialDocuments = await Promise.all(
      materialsSnapshot.docs.map(async (materialDoc) => {
        const material = materialDoc.data();
        const chunksSnapshot = await getDocs(
          collection(db, "classes", classId, "materials", materialDoc.id, "chunks")
        );

        return {
          id: materialDoc.id,
          courseId: classId,
          title: String(material.title ?? "Uploaded material"),
          kind: normalizeMaterialKind(String(material.kind ?? "lecture-notes")),
          status: material.status === "ready" ? "ready" : "processing",
          uploadedAt: new Date().toISOString(),
          chunks: chunksSnapshot.docs
            .map((chunkDoc) => {
              const chunk = chunkDoc.data();

              return {
                id: chunkDoc.id,
                documentId: materialDoc.id,
                label: String(chunk.label ?? "Uploaded excerpt"),
                content: String(chunk.content ?? "")
              };
            })
            .filter((chunk) => chunk.content)
        } satisfies SourceDocument;
      })
    );

    return materialDocuments;
  } catch {
    return [];
  }
}

function normalizeMaterialKind(kind: string): SourceDocument["kind"] {
  const normalizedKind = kind.toLowerCase();

  if (normalizedKind === "assignment") {
    return "assignment";
  }

  if (normalizedKind === "example" || normalizedKind === "worked-example") {
    return "worked-example";
  }

  if (normalizedKind === "reading" || normalizedKind === "textbook") {
    return "textbook";
  }

  if (normalizedKind === "notes" || normalizedKind === "lecture-notes") {
    return "lecture-notes";
  }

  if (kind === "textbook" || kind === "worked-example" || kind === "assignment") {
    return kind;
  }

  return "lecture-notes";
}

function tokenize(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((term) => term.length > 2);
}

function scoreChunk(content: string, terms: string[]) {
  const normalized = content.toLowerCase();
  return terms.reduce((score, term) => score + (normalized.includes(term) ? 1 : 0), 0);
}
