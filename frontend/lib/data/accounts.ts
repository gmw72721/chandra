import { runPostgresQuery, type PostgresQueryClient } from "./postgres.ts";

export type AccountRole = "student" | "teacher" | "assistant" | "system";
export type AccountStatus = "active" | "disabled" | "deleted";

export type AccountRecord = {
  id: string;
  firebaseUid: string;
  email: string;
  displayName: string;
  username: string | null;
  role: AccountRole;
  status: AccountStatus;
  legacyClassId: string | null;
  legacyClassIds: string[];
  profile: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

export type AccountProfileShape = {
  uid: string;
  email: string;
  username: string;
  displayName: string;
  role: "student" | "teacher";
  appearance?: unknown;
  classId?: string;
  classIds?: string[];
  themeColor?: unknown;
  createdAt?: unknown;
};

type AccountRow = {
  id: string;
  firebase_uid: string;
  email: string;
  display_name: string;
  username: string | null;
  role: AccountRole;
  status: AccountStatus;
  legacy_class_id: string | null;
  legacy_class_ids: string[];
  profile: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
};

export type UpsertAccountInput = {
  id: string;
  email: string;
  role: AccountRole;
  displayName?: string;
  firebaseUid?: string;
  legacyClassId?: string | null;
  legacyClassIds?: string[];
  profile?: Record<string, unknown>;
  status?: AccountStatus;
  username?: string | null;
};

export async function upsertAccount(input: UpsertAccountInput, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<AccountRow>(
    client,
    `INSERT INTO accounts (
      id, firebase_uid, email, display_name, username, role, status,
      legacy_class_id, legacy_class_ids, profile
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10::jsonb
    )
    ON CONFLICT (id) DO UPDATE SET
      firebase_uid = EXCLUDED.firebase_uid,
      email = EXCLUDED.email,
      display_name = EXCLUDED.display_name,
      username = EXCLUDED.username,
      role = EXCLUDED.role,
      status = EXCLUDED.status,
      legacy_class_id = EXCLUDED.legacy_class_id,
      legacy_class_ids = EXCLUDED.legacy_class_ids,
      profile = accounts.profile || EXCLUDED.profile,
      deleted_at = CASE WHEN EXCLUDED.status = 'deleted' THEN accounts.deleted_at ELSE NULL END
    RETURNING *`,
    [
      input.id,
      input.firebaseUid ?? input.id,
      input.email.trim(),
      input.displayName?.trim() ?? "",
      input.username?.trim() || null,
      input.role,
      input.status ?? "active",
      input.legacyClassId ?? null,
      input.legacyClassIds ?? [],
      JSON.stringify(input.profile ?? {})
    ]
  );

  return rowToAccount(result.rows[0]);
}

export async function getAccountById(id: string, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<AccountRow>(client, "SELECT * FROM accounts WHERE id = $1", [id]);
  return result.rows[0] ? rowToAccount(result.rows[0]) : null;
}

export async function getAccountByEmail(email: string, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<AccountRow>(
    client,
    "SELECT * FROM accounts WHERE email_normalized = lower($1) LIMIT 1",
    [email.trim()]
  );
  return result.rows[0] ? rowToAccount(result.rows[0]) : null;
}

export async function getAccountByUsername(username: string, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<AccountRow>(
    client,
    "SELECT * FROM accounts WHERE lower(username) = lower($1) LIMIT 1",
    [username.trim()]
  );
  return result.rows[0] ? rowToAccount(result.rows[0]) : null;
}

export async function getAccountByLoginIdentifier(identifier: string, client?: PostgresQueryClient) {
  const cleanIdentifier = identifier.trim().toLowerCase();

  if (!cleanIdentifier) {
    return null;
  }

  const result = await runPostgresQuery<AccountRow>(
    client,
    `SELECT *
    FROM accounts
    WHERE status != 'deleted' AND (email_normalized = $1 OR lower(username) = $1)
    ORDER BY CASE WHEN email_normalized = $1 THEN 0 ELSE 1 END
    LIMIT 1`,
    [cleanIdentifier]
  );

  return result.rows[0] ? rowToAccount(result.rows[0]) : null;
}

export async function updateAccountProfile({
  id,
  profile
}: {
  id: string;
  profile: Record<string, unknown>;
}, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<AccountRow>(
    client,
    `UPDATE accounts
    SET profile = profile || $2::jsonb
    WHERE id = $1
    RETURNING *`,
    [id, JSON.stringify(profile)]
  );

  return result.rows[0] ? rowToAccount(result.rows[0]) : null;
}

export async function markAccountDeleted(id: string, client?: PostgresQueryClient) {
  const result = await runPostgresQuery<AccountRow>(
    client,
    `UPDATE accounts
    SET status = 'deleted', deleted_at = now()
    WHERE id = $1
    RETURNING *`,
    [id]
  );

  return result.rows[0] ? rowToAccount(result.rows[0]) : null;
}

function rowToAccount(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    firebaseUid: row.firebase_uid,
    email: row.email,
    displayName: row.display_name,
    username: row.username,
    role: row.role,
    status: row.status,
    legacyClassId: row.legacy_class_id,
    legacyClassIds: row.legacy_class_ids,
    profile: row.profile,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at
  };
}

export function accountToProfile(account: AccountRecord): AccountProfileShape | null {
  if (account.status === "deleted") {
    return null;
  }

  if (account.role !== "student" && account.role !== "teacher") {
    return null;
  }

  return {
    ...(account.profile as Partial<AccountProfileShape>),
    uid: account.id,
    email: account.email.trim().toLowerCase(),
    username: account.username || account.email.trim().toLowerCase(),
    displayName: account.displayName || account.email || "Chandra user",
    role: account.role,
    ...(account.legacyClassId ? { classId: account.legacyClassId } : {}),
    ...(account.legacyClassIds.length ? { classIds: account.legacyClassIds } : {})
  };
}

export function firestoreProfileToUpsertAccountInput(
  uid: string,
  data: Record<string, unknown>
): UpsertAccountInput | null {
  const role = data.role === "student" || data.role === "teacher" ? data.role : null;
  const email = String(data.email ?? "").trim().toLowerCase();

  if (!role || !email) {
    return null;
  }

  return {
    id: uid,
    firebaseUid: uid,
    email,
    role,
    displayName: String(data.displayName ?? email).trim() || email,
    legacyClassId: String(data.classId ?? "").trim() || null,
    legacyClassIds: Array.isArray(data.classIds)
      ? data.classIds.map(String).map((classId) => classId.trim()).filter(Boolean)
      : [],
    profile: data,
    username: String(data.username ?? email).trim().toLowerCase() || email
  };
}
