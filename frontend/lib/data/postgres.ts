import pg, { type PoolClient, type QueryResult, type QueryResultRow } from "pg";

const { Pool } = pg;
const defaultPoolMax = 5;

let pool: pg.Pool | null = null;

export class PostgresDataError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PostgresDataError";
  }
}

export type PostgresQueryClient = Pick<PoolClient, "query">;

export function getPostgresDatabaseUrl() {
  return (
    process.env.DATABASE_URL?.trim()
    || process.env.CLOUD_SQL_POSTGRES_URL?.trim()
    || process.env.CHANDRA_CLOUD_SQL_POSTGRES_URL?.trim()
    || ""
  );
}

export function isPostgresConfigured() {
  return Boolean(getPostgresDatabaseUrl());
}

export function assertPostgresConfigured() {
  if (!isPostgresConfigured()) {
    throw new PostgresDataError(
      "Postgres app data requires DATABASE_URL, CLOUD_SQL_POSTGRES_URL, or CHANDRA_CLOUD_SQL_POSTGRES_URL."
    );
  }
}

export function getPostgresPool() {
  if (pool) {
    return pool;
  }

  const connectionString = getPostgresDatabaseUrl();

  if (!connectionString) {
    throw new PostgresDataError(
      "Postgres app data requires DATABASE_URL, CLOUD_SQL_POSTGRES_URL, or CHANDRA_CLOUD_SQL_POSTGRES_URL."
    );
  }

  assertProductionPostgresTarget(connectionString);

  pool = new Pool({
    connectionString,
    max: readPositiveInteger(process.env.CLOUD_SQL_POSTGRES_POOL_MAX) ?? defaultPoolMax,
    ssl: readPostgresSslConfig(connectionString)
  });

  return pool;
}

export async function queryPostgres<Row extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = []
): Promise<QueryResult<Row>> {
  return getPostgresPool().query<Row>(text, values);
}

export async function runPostgresQuery<Row extends QueryResultRow = QueryResultRow>(
  client: PostgresQueryClient | undefined,
  text: string,
  values: unknown[] = []
): Promise<QueryResult<Row>> {
  return client ? client.query<Row>(text, values) : queryPostgres<Row>(text, values);
}

export async function withPostgresClient<Result>(
  callback: (client: PoolClient) => Promise<Result>
): Promise<Result> {
  const client = await getPostgresPool().connect();

  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

export async function withPostgresTransaction<Result>(
  callback: (client: PoolClient) => Promise<Result>
): Promise<Result> {
  return withPostgresClient(async (client) => {
    try {
      await client.query("BEGIN");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (caughtError) {
      await client.query("ROLLBACK").catch(() => {});
      throw caughtError;
    }
  });
}

export function compactRowData<T extends Record<string, unknown>>(data: T) {
  return Object.fromEntries(
    Object.entries(data).filter((entry): entry is [string, Exclude<T[keyof T], undefined>] => entry[1] !== undefined)
  );
}

export function readPostgresSslConfig(connectionString: string) {
  const sslMode = process.env.CLOUD_SQL_POSTGRES_SSL_MODE?.trim().toLowerCase() ?? "";

  if (sslMode === "disable" || connectionString.includes("sslmode=disable")) {
    return false;
  }

  if (sslMode === "require" || connectionString.includes("sslmode=require")) {
    return { rejectUnauthorized: false };
  }

  return undefined;
}

export function readPositiveInteger(value: string | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function shouldFallbackToFirestoreWhenPostgresFails() {
  const explicitFallback = process.env.POSTGRES_FIRESTORE_FALLBACK?.trim().toLowerCase();

  if (explicitFallback) {
    return explicitFallback === "1" || explicitFallback === "true" || explicitFallback === "yes";
  }

  return false;
}

function assertProductionPostgresTarget(connectionString: string) {
  if (process.env.NODE_ENV !== "production" || process.env.ALLOW_LOCAL_POSTGRES_IN_PRODUCTION === "1") {
    return;
  }

  let hostname = "";

  try {
    hostname = new URL(connectionString).hostname.toLowerCase();
  } catch {
    throw new PostgresDataError("Production Postgres connection string is not a valid URL.");
  }

  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    throw new PostgresDataError(
      "Production Postgres must not point at localhost. Use the Cloud SQL private IP, Cloud SQL Auth Proxy sidecar, or a Cloud SQL connector endpoint."
    );
  }
}
