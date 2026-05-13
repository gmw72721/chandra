#!/usr/bin/env node
import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import pg from "pg";

const { Pool } = pg;
const args = parseArgs(process.argv.slice(2));
const dryRun = !args.write;
const migrateFirestore = !args.postgresOnly;
const migratePostgres = !args.firestoreOnly && Boolean(getDatabaseUrl());
const counters = {
  firestoreChecked: 0,
  firestoreChanged: 0,
  postgresChecked: 0,
  postgresChanged: 0
};

if (args.postgresOnly && !getDatabaseUrl()) {
  fail("A Postgres database URL is required with --postgres-only.");
}

if (migrateFirestore) {
  await migrateFirestoreClasses();
}

if (migratePostgres) {
  await migratePostgresClasses();
} else if (!args.firestoreOnly && !getDatabaseUrl()) {
  console.log("Skipping Postgres migration because no database URL is configured.");
}

console.log(
  [
    dryRun ? "Dry run complete." : "Migration complete.",
    `Firestore: ${counters.firestoreChanged}/${counters.firestoreChecked} classes changed.`,
    `Postgres: ${counters.postgresChanged}/${counters.postgresChecked} classes changed.`
  ].join(" ")
);

async function migrateFirestoreClasses() {
  const db = getFirestore(initializeFirebaseAdmin());
  const snapshot = await db.collection("classes").get();
  const batchSize = 400;
  let batch = db.batch();
  let pendingWrites = 0;

  for (const doc of snapshot.docs) {
    counters.firestoreChecked += 1;
    const data = doc.data();
    const migrated = migrateClassSettings(data.modelSettings, data.responseFormat);

    if (!migrated.changed) {
      continue;
    }

    counters.firestoreChanged += 1;

    if (dryRun) {
      console.log(`[dry-run] Firestore class ${doc.id}: ${migrated.summary.join(", ")}`);
      continue;
    }

    batch.set(
      doc.ref,
      {
        modelSettings: migrated.modelSettings,
        responseFormat: migrated.responseFormat,
        updatedAt: new Date()
      },
      { merge: true }
    );
    pendingWrites += 1;

    if (pendingWrites >= batchSize) {
      await batch.commit();
      batch = db.batch();
      pendingWrites = 0;
    }
  }

  if (!dryRun && pendingWrites > 0) {
    await batch.commit();
  }
}

async function migratePostgresClasses() {
  const pool = new Pool({
    connectionString: getDatabaseUrl(),
    max: 4,
    ssl: readPostgresSslConfig()
  });

  try {
    const result = await pool.query("select id, model_settings, response_format from classes");

    for (const row of result.rows) {
      counters.postgresChecked += 1;
      const migrated = migrateClassSettings(row.model_settings, row.response_format);

      if (!migrated.changed) {
        continue;
      }

      counters.postgresChanged += 1;

      if (dryRun) {
        console.log(`[dry-run] Postgres class ${row.id}: ${migrated.summary.join(", ")}`);
        continue;
      }

      await pool.query(
        `update classes
         set model_settings = $2::jsonb,
             response_format = $3::jsonb,
             updated_at = now()
         where id = $1`,
        [row.id, JSON.stringify(migrated.modelSettings), JSON.stringify(migrated.responseFormat)]
      );
    }
  } finally {
    await pool.end();
  }
}

function migrateClassSettings(modelSettingsValue, responseFormatValue) {
  const modelSettings = isRecord(modelSettingsValue) ? { ...modelSettingsValue } : {};
  const responseFormat = isRecord(responseFormatValue) ? { ...responseFormatValue } : {};
  const summary = [];

  if (!("verbose" in modelSettings)) {
    modelSettings.verbose = verboseFromLegacy(modelSettings.responseLength);
    summary.push(`responseLength -> verbose:${modelSettings.verbose}`);
  }

  if ("responseLength" in modelSettings) {
    delete modelSettings.responseLength;
    summary.push("removed responseLength");
  }

  if (!("simpleWording" in responseFormat)) {
    responseFormat.simpleWording = responseFormat.readingLevel === "simple";
    summary.push(`readingLevel -> simpleWording:${responseFormat.simpleWording}`);
  }

  if (!("exampleFrequency" in responseFormat)) {
    responseFormat.exampleFrequency = "whenHelpful";
    summary.push("added exampleFrequency:whenHelpful");
  }

  if ("readingLevel" in responseFormat) {
    delete responseFormat.readingLevel;
    summary.push("removed readingLevel");
  }

  return {
    changed: summary.length > 0,
    modelSettings,
    responseFormat,
    summary
  };
}

function verboseFromLegacy(value) {
  if (value === "brief" || value === "standard" || value === "detailed" || value === "veryDetailed") {
    return value;
  }

  if (value === "short") {
    return "brief";
  }

  if (value === "long") {
    return "detailed";
  }

  if (value === "extended") {
    return "veryDetailed";
  }

  return "standard";
}

function initializeFirebaseAdmin() {
  if (getApps().length) {
    return getApps()[0];
  }

  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (projectId && clientEmail && privateKey) {
    return initializeApp({
      credential: cert({ clientEmail, privateKey, projectId })
    });
  }

  return initializeApp({
    credential: applicationDefault(),
    projectId
  });
}

function getDatabaseUrl() {
  return process.env.DATABASE_URL || process.env.CLOUD_SQL_POSTGRES_URL || process.env.CHANDRA_CLOUD_SQL_POSTGRES_URL || "";
}

function readPostgresSslConfig() {
  if (process.env.POSTGRES_SSL === "false") {
    return undefined;
  }

  if (process.env.NODE_ENV === "production" || process.env.POSTGRES_SSL === "true") {
    return { rejectUnauthorized: process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED !== "false" };
  }

  return undefined;
}

function parseArgs(rawArgs) {
  return {
    firestoreOnly: rawArgs.includes("--firestore-only"),
    postgresOnly: rawArgs.includes("--postgres-only"),
    write: rawArgs.includes("--write")
  };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
