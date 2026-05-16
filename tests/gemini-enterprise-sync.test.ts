import assert from "node:assert/strict";
import test from "node:test";
import {
  agentSearchImportJsonl,
  importAgentSearchDocuments,
  importDocumentsUrl,
  missingGeminiEnterpriseSyncConfig,
  pdfPageToAgentSearchDocument,
  syncPdfPagesToAgentSearch
} from "../frontend/lib/gemini-enterprise-sync.ts";

test("pdf page rows transform into Gemini Enterprise searchable documents with Chandra metadata", () => {
  const record = pdfPageToAgentSearchDocument({
    id: 42,
    class_id: "class-1",
    professor_id: "teacher-1",
    teacher_id: "teacher-1",
    material_id: "material-1",
    material_type: "lecture-notes",
    ocr_text: "Definition. A basis is a linearly independent spanning set.",
    page_asset_mime_type: "application/pdf",
    page_asset_sha256: "abc123",
    page_asset_size: 12345,
    page_asset_uri: "gs://chandra-pdf-assets/classes/class-1/materials/material-1/page-assets/page-5.pdf",
    page_number: 5,
    problem_numbers: "2.1, 2.2",
    title: "Linear Algebra Notes"
  });

  assert.ok(record);
  assert.equal(record.sourceTable, "pdf_pages");
  assert.equal(record.chunkType, "definition");
  assert.equal(record.pageNumber, 5);
  assert.equal(record.document.structData.class_id, "class-1");
  assert.equal(record.document.structData.teacher_id, "teacher-1");
  assert.equal(record.document.structData.professor_id, "teacher-1");
  assert.equal(record.document.structData.active_for_students, true);
  assert.equal(record.document.structData.teacher_only, false);
  assert.deepEqual(record.document.structData.problem_numbers, ["2.1", "2.2"]);

  const jsonl = agentSearchImportJsonl([record]);
  assert.match(jsonl, /"mimeType":"application\/pdf"/);
  assert.match(jsonl, /gs:\/\/chandra-pdf-assets\/classes\/class-1\/materials\/material-1\/page-assets\/page-5\.pdf/);
});

test("pdf page transform falls back to OCR text when no per-page PDF asset is available", () => {
  const record = pdfPageToAgentSearchDocument({
    id: 43,
    class_id: "class-1",
    professor_id: "teacher-1",
    material_id: "material-1",
    ocr_text: "Example 3. Row-reduce the matrix.",
    page_number: 6,
    title: "Linear Algebra Notes"
  });

  assert.ok(record);
  assert.deepEqual(record.document.content, {
    mimeType: "text/plain",
    rawBytes: Buffer.from("Example 3. Row-reduce the matrix.", "utf8").toString("base64")
  });
});

test("Gemini Enterprise import uses the Discovery Engine documents import endpoint", async () => {
  const requests: Array<{ body: unknown; headers: HeadersInit; url: string }> = [];
  const result = await importAgentSearchDocuments({
    accessToken: "token-1",
    config: {
      collectionId: "default_collection",
      dataStoreId: "store-1",
      location: "global",
      projectId: "project-1"
    },
    documents: [
      {
        id: "doc-1",
        structData: { class_id: "class-1" },
        content: {
          mimeType: "application/pdf",
          uri: "gs://bucket/page-1.pdf"
        }
      }
    ],
    fetchImpl: (async (url, init) => {
      requests.push({
        body: JSON.parse(String(init?.body ?? "{}")),
        headers: init?.headers ?? {},
        url: String(url)
      });

      return new Response(JSON.stringify({ name: "operations/import-1" }), { status: 200 });
    }) as typeof fetch
  });

  assert.equal(result.name, "operations/import-1");
  assert.equal(
    requests[0].url,
    importDocumentsUrl({
      collectionId: "default_collection",
      dataStoreId: "store-1",
      location: "global",
      projectId: "project-1"
    })
  );
  assert.deepEqual(requests[0].body, {
    inlineSource: {
      documents: [
        {
          id: "doc-1",
          structData: { class_id: "class-1" },
          content: {
            mimeType: "application/pdf",
            uri: "gs://bucket/page-1.pdf"
          }
        }
      ]
    },
    reconciliationMode: "INCREMENTAL"
  });
  assert.equal((requests[0].headers as Record<string, string>).Authorization, "Bearer token-1");
});

test("Gemini Enterprise sync config reports missing required env values", () => {
  assert.deepEqual(
    missingGeminiEnterpriseSyncConfig({
      collectionId: "default_collection",
      dataStoreId: "",
      location: "global",
      projectId: ""
    }),
    ["dataStoreId", "projectId"]
  );
});

test("PDF upload Agent Search sync is a no-op when disabled", async () => {
  const previous = process.env.GEMINI_ENTERPRISE_SEARCH_ENABLED;
  process.env.GEMINI_ENTERPRISE_SEARCH_ENABLED = "false";

  try {
    const summary = await syncPdfPagesToAgentSearch({
      pages: [
        {
          id: 44,
          class_id: "class-1",
          professor_id: "teacher-1",
          material_id: "material-1",
          page_asset_uri: "gs://bucket/page-1.pdf",
          page_number: 1
        }
      ]
    });

    assert.deepEqual(summary, {
      importedCount: 0,
      operationNames: [],
      skippedReason: "GEMINI_ENTERPRISE_SEARCH_ENABLED is false",
      status: "disabled"
    });
  } finally {
    if (previous === undefined) {
      delete process.env.GEMINI_ENTERPRISE_SEARCH_ENABLED;
    } else {
      process.env.GEMINI_ENTERPRISE_SEARCH_ENABLED = previous;
    }
  }
});
