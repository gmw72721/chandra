#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const ports = [3000, 8000];
const children = [];
const pidDirectory = ".chandra-dev";
const pidFile = `${pidDirectory}/dev-stack-pids.json`;
const defaultCloudSqlInstance = "chandra-f6e13:us-central1:chandra-postgres";
const cloudSqlProxyVersion = "v2.18.3";

loadDotEnvLocal();
process.env.CHANDRA_ENV_LOADED = "1";
stopPreviousStack();
writePidFile();

if (shouldStartCloudSqlProxy()) {
  startCloudSqlProxy();
}
applyPostgresMigrations();
start("frontend", "node_modules/.bin/next", ["dev", "frontend", "--hostname", "127.0.0.1", "--port", "3000"]);
start("backend", "python3", ["-m", "uvicorn", "backend.main:app", "--host", "127.0.0.1", "--port", "8000"]);

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => {
  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }
  removePidFile();
});

function loadDotEnvLocal() {
  if (!existsSync(".env.local")) {
    return;
  }

  const lines = readFileSync(".env.local", "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, "");

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function stopPreviousStack() {
  const stoppedKnownProcess = stopKnownProcesses();

  if (stoppedKnownProcess) {
    sleepSync(120);
  }

  stopExistingListeners();
}

function stopKnownProcesses() {
  if (!existsSync(pidFile)) {
    return false;
  }

  try {
    const pids = JSON.parse(readFileSync(pidFile, "utf8"));
    const knownPids = [pids.frontend, pids.backend, pids.cloudSqlProxy, pids.supervisor]
      .map((pid) => Number(pid))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);

    for (const pid of knownPids) {
      stopProcess(pid);
    }

    removePidFile();
    return knownPids.length > 0;
  } catch {
    removePidFile();
    return false;
  }
}

function shouldStartCloudSqlProxy() {
  if (process.env.CHANDRA_DEV_CLOUD_SQL_PROXY?.trim() === "0") {
    return false;
  }

  if (process.env.CHANDRA_DEV_CLOUD_SQL_PROXY?.trim() === "1") {
    return true;
  }

  const databaseUrl = process.env.DATABASE_URL || process.env.CLOUD_SQL_POSTGRES_URL || process.env.CHANDRA_CLOUD_SQL_POSTGRES_URL || "";

  try {
    const hostname = new URL(databaseUrl).hostname.toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

function startCloudSqlProxy() {
  const port = Number(process.env.CLOUD_SQL_PROXY_PORT || "5432");
  const instance = process.env.CLOUD_SQL_INSTANCE_CONNECTION_NAME || defaultCloudSqlInstance;

  if (isPortListening(port)) {
    console.log(`[cloud-sql-proxy] 127.0.0.1:${port} is already listening; reusing existing Postgres endpoint`);
    return;
  }

  const binary = ensureCloudSqlProxyBinary();
  start("cloud-sql-proxy", binary, ["--address", "127.0.0.1", "--port", String(port), instance]);
}

function applyPostgresMigrations() {
  if (process.env.CHANDRA_DEV_AUTO_MIGRATE_POSTGRES?.trim() === "0") {
    return;
  }

  const databaseUrl = process.env.DATABASE_URL || process.env.CLOUD_SQL_POSTGRES_URL || process.env.CHANDRA_CLOUD_SQL_POSTGRES_URL || "";

  if (!databaseUrl) {
    return;
  }

  console.log("[postgres-migrate] checking local Postgres schema");
  const result = spawnSync("node", ["scripts/apply-postgres-migrations.mjs"], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8"
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.status !== 0) {
    throw new Error("Postgres migrations failed. Start the local Postgres/Cloud SQL proxy, then rerun npm run dev:all.");
  }
}

function ensureCloudSqlProxyBinary() {
  if (process.env.CLOUD_SQL_PROXY_BIN && existsSync(process.env.CLOUD_SQL_PROXY_BIN)) {
    return process.env.CLOUD_SQL_PROXY_BIN;
  }

  const fromPath = spawnSync("which", ["cloud-sql-proxy"], { encoding: "utf8" }).stdout.trim();

  if (fromPath) {
    return fromPath;
  }

  const cachedBinary = `${pidDirectory}/bin/cloud-sql-proxy`;

  if (existsSync(cachedBinary)) {
    return cachedBinary;
  }

  const platform = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : "";
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : "";

  if (!platform || !arch) {
    throw new Error(`Unsupported Cloud SQL Auth Proxy platform: ${process.platform}/${process.arch}`);
  }

  mkdirSync(`${pidDirectory}/bin`, { recursive: true });

  const url = `https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/${cloudSqlProxyVersion}/cloud-sql-proxy.${platform}.${arch}`;
  console.log(`[cloud-sql-proxy] downloading ${basename(url)} to ${cachedBinary}`);
  const result = spawnSync("curl", ["-fsSL", "-o", cachedBinary, url], { encoding: "utf8", stdio: "inherit" });

  if (result.status !== 0) {
    throw new Error("Failed to download Cloud SQL Auth Proxy. Install cloud-sql-proxy or set CLOUD_SQL_PROXY_BIN.");
  }

  chmodSync(cachedBinary, 0o755);
  return cachedBinary;
}

function isPortListening(port) {
  const result = spawnSync("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf8"
  });

  return Boolean(result.stdout.trim());
}

function stopExistingListeners() {
  let stoppedListener = false;

  for (const port of ports) {
    const result = spawnSync("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8"
    });
    const pids = result.stdout
      .split(/\s+/)
      .map((pid) => pid.trim())
      .filter(Boolean);

    for (const pid of pids) {
      stopProcess(Number(pid), ` on port ${port}`);
      stoppedListener = true;
    }
  }

  if (stoppedListener) {
    waitForPortsToClose();
  }
}

function stopProcess(pid, context = "") {
  try {
    process.kill(pid, "SIGTERM");
    console.log(`[dev] stopped existing process ${pid}${context}`);
  } catch {
    // The process may already be gone.
  }
}

function waitForPortsToClose() {
  const deadline = Date.now() + 3000;

  while (Date.now() < deadline) {
    if (ports.every((port) => !isPortListening(port))) {
      return;
    }

    sleepSync(100);
  }

  for (const port of ports) {
    const result = spawnSync("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8"
    });
    const pids = result.stdout
      .split(/\s+/)
      .map((pid) => pid.trim())
      .filter(Boolean);

    for (const pid of pids) {
      try {
        process.kill(Number(pid), "SIGKILL");
        console.log(`[dev] force-stopped existing process ${pid} on port ${port}`);
      } catch {
        // The process may already be gone.
      }
    }
  }

  sleepSync(120);
}

function start(name, command, args) {
  const child = spawn(command, args, {
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.chandraName = name;
  children.push(child);
  writePidFile();

  child.stdout.on("data", (chunk) => writePrefixed(name, chunk));
  child.stderr.on("data", (chunk) => writePrefixed(name, chunk));
  child.on("exit", (code, signal) => {
    console.log(`[${name}] exited ${signal ?? code}`);

    if (!shuttingDown) {
      shutdown();
    }
  });
}

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }

  removePidFile();
  setTimeout(() => process.exit(0), 300).unref();
}

function writePidFile() {
  mkdirSync(pidDirectory, { recursive: true });
  writeFileSync(
    pidFile,
    JSON.stringify(
      {
        backend: children.find((child) => child.spawnargs.includes("uvicorn"))?.pid,
        cloudSqlProxy: children.find((child) => child.chandraName === "cloud-sql-proxy")?.pid,
        frontend: children.find((child) => child.spawnargs.includes("next"))?.pid,
        supervisor: process.pid
      },
      null,
      2
    )
  );
}

function removePidFile() {
  rmSync(pidFile, { force: true });
}

function sleepSync(durationMs) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, durationMs);
}

function writePrefixed(name, chunk) {
  const lines = chunk.toString().split(/\r?\n/);

  for (const line of lines) {
    if (line) {
      console.log(`[${name}] ${line}`);
    }
  }
}
