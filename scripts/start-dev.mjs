#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const ports = [3000, 8000];
const children = [];
const pidDirectory = ".chandra-dev";
const pidFile = `${pidDirectory}/dev-stack-pids.json`;

loadDotEnvLocal();
process.env.CHANDRA_ENV_LOADED = "1";
stopPreviousStack();
writePidFile();

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
    return;
  }

  stopExistingListeners();
}

function stopKnownProcesses() {
  if (!existsSync(pidFile)) {
    return false;
  }

  try {
    const pids = JSON.parse(readFileSync(pidFile, "utf8"));
    const knownPids = [pids.frontend, pids.backend, pids.supervisor]
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

function stopExistingListeners() {
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
    }
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

function start(name, command, args) {
  const child = spawn(command, args, {
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
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
