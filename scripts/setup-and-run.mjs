#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const envPath = join(root, ".env.local");
const envExamplePath = join(root, "config/env.example");
const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const autoYes = process.argv.includes("--yes") || process.env.CHANDRA_SETUP_YES === "1";
const checkOnly = process.argv.includes("--check-only") || process.argv.includes("--no-start");

const requiredFirebaseWebKeys = [
  "NEXT_PUBLIC_FIREBASE_API_KEY",
  "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
  "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
  "NEXT_PUBLIC_FIREBASE_APP_ID"
];

const optionalSecretPrompts = [
  {
    key: "OPENROUTER_API_KEY",
    label: "OpenRouter API key (blank keeps guided demo mode)"
  },
  {
    key: "GEMINI_API_KEY",
    label: "Gemini API key for embeddings/material retrieval (blank skips retrieval setup)"
  },
  {
    key: "FIREBASE_SERVICE_ACCOUNT_KEY",
    label:
      "Firebase service account JSON, minified single line (blank if using split FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY)"
  },
  {
    key: "FIREBASE_CLIENT_EMAIL",
    label: "Firebase client email (blank if service account JSON was provided)"
  },
  {
    key: "FIREBASE_PRIVATE_KEY",
    label: "Firebase private key with \\n escapes (blank if service account JSON was provided)"
  }
];

main().catch((error) => {
  console.error(`\n[setup] ${error.message}`);
  process.exit(1);
});

async function main() {
  console.log("[setup] Preparing Chandra for first local run.");

  ensureNodeVersion();
  const python = ensurePythonEnvironment();
  ensureEnvFile();
  await configureEnv();
  installNodeDependencies();
  installPythonDependencies(python);
  verifyBackendImport(python);
  printEnvWarnings();

  if (checkOnly) {
    console.log("\n[setup] Check-only mode complete. Run npm run setup:run to start the app.");
    return;
  }

  console.log("\n[setup] Starting the full local stack.");
  console.log("[setup] Frontend: http://127.0.0.1:3000");
  console.log("[setup] Backend:  http://127.0.0.1:8000");
  console.log("[setup] Press Ctrl+C to stop both processes.\n");

  const venvBin = dirname(python);
  const child = spawn("npm", ["run", "dev:all"], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${venvBin}:${process.env.PATH ?? ""}`,
      PYTHONDONTWRITEBYTECODE: "1",
      VIRTUAL_ENV: dirname(venvBin)
    },
    stdio: "inherit"
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

function ensureNodeVersion() {
  const version = process.versions.node.split(".").map(Number);

  if ((version[0] ?? 0) < 20) {
    throw new Error(`Node.js 20+ is required. Current Node is ${process.versions.node}.`);
  }

  if (!commandExists("npm")) {
    throw new Error("npm is required but was not found on PATH.");
  }
}

function ensurePythonEnvironment() {
  const existingVenvs = [join(root, ".venv", "bin", "python"), join(root, ".venv313", "bin", "python")];

  for (const candidate of existingVenvs) {
    if (existsSync(candidate) && pythonVersionOk(candidate)) {
      console.log(`[setup] Using existing Python virtualenv: ${candidate}`);
      return candidate;
    }
  }

  const basePython = findBasePython();

  if (!basePython) {
    throw new Error(
      "Python 3.11+ is required. Install Python 3.11, 3.12, or 3.13, then rerun this script."
    );
  }

  const venvPath = join(root, ".venv");
  console.log(`[setup] Creating Python virtualenv at ${venvPath}`);
  run(basePython, ["-m", "venv", venvPath], {
    fixHint: "Install Python's venv module, then rerun this script."
  });

  const venvPython = join(venvPath, "bin", "python");

  if (!pythonVersionOk(venvPython)) {
    throw new Error("The created virtualenv does not provide Python 3.11+.");
  }

  return venvPython;
}

function findBasePython() {
  for (const command of ["python3.13", "python3.12", "python3.11", "python3"]) {
    if (commandExists(command) && pythonVersionOk(command)) {
      return command;
    }
  }

  return null;
}

function pythonVersionOk(command) {
  const result = spawnSync(command, ["-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"], {
    encoding: "utf8"
  });

  if (result.status !== 0) {
    return false;
  }

  const [major, minor] = result.stdout.trim().split(".").map(Number);
  return major > 3 || (major === 3 && minor >= 11);
}

function ensureEnvFile() {
  if (!existsSync(envPath)) {
    if (!existsSync(envExamplePath)) {
      throw new Error("config/env.example is missing; cannot create .env.local.");
    }

    copyFileSync(envExamplePath, envPath);
    chmodSync(envPath, 0o600);
    console.log("[setup] Created .env.local from config/env.example.");
  }

  let envText = readFileSync(envPath, "utf8");
  const env = parseEnv(envText);

  const defaults = {
    OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
    DEFAULT_MODEL: "openai/gpt-5.4-mini",
    OPENROUTER_HTTP_REFERER: "http://localhost:3000",
    OPENROUTER_APP_TITLE: "Chandra",
    BACKEND_API_BASE_URL: "http://127.0.0.1:8000",
    BACKEND_CORS_ORIGINS: "http://localhost:3000,http://127.0.0.1:3000",
    CHANDRA_ENV: "development",
    GOOGLE_CLOUD_LOCATION: "us",
    VERTEX_EMBEDDING_MODEL: "gemini-embedding-2",
    VERTEX_EMBEDDING_DIMENSIONS: "1536"
  };

  for (const [key, value] of Object.entries(defaults)) {
    if (!env[key]) {
      envText = setEnvValue(envText, key, value);
      env[key] = value;
    }
  }

  for (const key of ["BACKEND_SHARED_SECRET", "LEARNING_PROFILE_UPDATE_SECRET"]) {
    if (!env[key]) {
      const value = randomBytes(32).toString("base64url");
      envText = setEnvValue(envText, key, value);
      env[key] = value;
      console.log(`[setup] Generated ${key}.`);
    }
  }

  const projectId = env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || env.FIREBASE_PROJECT_ID;
  const storageBucket = env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || env.FIREBASE_STORAGE_BUCKET;

  if (projectId && !env.FIREBASE_PROJECT_ID) {
    envText = setEnvValue(envText, "FIREBASE_PROJECT_ID", projectId);
  }

  if (storageBucket && !env.FIREBASE_STORAGE_BUCKET) {
    envText = setEnvValue(envText, "FIREBASE_STORAGE_BUCKET", storageBucket);
  }

  writeFileSync(envPath, envText);
}

async function configureEnv() {
  let envText = readFileSync(envPath, "utf8");
  const env = parseEnv(envText);

  if (!isInteractive || autoYes) {
    console.log("[setup] Non-interactive mode: leaving missing API keys blank.");
    return;
  }

  for (const key of requiredFirebaseWebKeys) {
    if (env[key]) {
      continue;
    }

    const answer = await ask(`${key}: `);
    if (answer) {
      envText = setEnvValue(envText, key, answer.trim());
      env[key] = answer.trim();
    }
  }

  if (env.NEXT_PUBLIC_FIREBASE_PROJECT_ID && !env.FIREBASE_PROJECT_ID) {
    envText = setEnvValue(envText, "FIREBASE_PROJECT_ID", env.NEXT_PUBLIC_FIREBASE_PROJECT_ID);
    env.FIREBASE_PROJECT_ID = env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  }

  if (env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET && !env.FIREBASE_STORAGE_BUCKET) {
    envText = setEnvValue(envText, "FIREBASE_STORAGE_BUCKET", env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET);
    env.FIREBASE_STORAGE_BUCKET = env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
  }

  for (const prompt of optionalSecretPrompts) {
    if (env[prompt.key]) {
      continue;
    }

    const answer = await askHidden(`${prompt.label}: `);
    if (answer) {
      envText = setEnvValue(envText, prompt.key, answer.trim());
      env[prompt.key] = answer.trim();
    }
  }

  writeFileSync(envPath, envText);
}

function installNodeDependencies() {
  const packageLock = join(root, "package-lock.json");
  const packageJson = join(root, "package.json");
  const nodeModules = join(root, "node_modules");
  const needsInstall =
    !existsSync(nodeModules) ||
    (existsSync(packageLock) && statSync(packageLock).mtimeMs > statSync(nodeModules).mtimeMs) ||
    (existsSync(packageJson) && statSync(packageJson).mtimeMs > statSync(nodeModules).mtimeMs);

  if (!needsInstall) {
    console.log("[setup] Node dependencies already installed.");
    return;
  }

  console.log("[setup] Installing Node dependencies with npm install.");
  run("npm", ["install"]);
}

function installPythonDependencies(python) {
  console.log("[setup] Installing Python dependencies.");
  run(python, ["-m", "pip", "--version"]);
  run(python, ["-m", "pip", "install", "-r", "backend/requirements.txt"]);
}

function verifyBackendImport(python) {
  console.log("[setup] Verifying backend imports.");
  run(python, ["-c", "import backend.main; print('backend import ok')"], {
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONPATH: root
    }
  });
}

function printEnvWarnings() {
  const env = parseEnv(readFileSync(envPath, "utf8"));
  const missingFirebaseWeb = requiredFirebaseWebKeys.filter((key) => !env[key]);
  const hasFirebaseAdmin =
    Boolean(env.FIREBASE_SERVICE_ACCOUNT_KEY) ||
    Boolean(env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY && (env.FIREBASE_PROJECT_ID || env.NEXT_PUBLIC_FIREBASE_PROJECT_ID));

  if (missingFirebaseWeb.length) {
    console.warn(`\n[setup] Firebase web config is incomplete: ${missingFirebaseWeb.join(", ")}`);
    console.warn("[setup] The server can start, but auth-backed screens will fail until these are filled in.");
  }

  if (!hasFirebaseAdmin) {
    console.warn("\n[setup] Firebase Admin credentials are missing.");
    console.warn("[setup] Teacher/admin APIs that read or write Firestore/Storage will fail until service account env is added.");
  }

  if (!env.OPENROUTER_API_KEY) {
    console.warn("\n[setup] OPENROUTER_API_KEY is blank, so live model calls use demo/fallback behavior where supported.");
  }

  if (!env.GEMINI_API_KEY && !env.GOOGLE_APPLICATION_CREDENTIALS && !env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
    console.warn("[setup] Embedding/material retrieval calls need GEMINI_API_KEY or Google Cloud credentials.");
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: options.env ?? process.env,
    stdio: "inherit"
  });

  if (result.status !== 0) {
    const hint = options.fixHint ? ` ${options.fixHint}` : "";
    throw new Error(`Command failed: ${command} ${args.join(" ")}.${hint}`);
  }
}

function commandExists(command) {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    stdio: "ignore"
  });

  return result.status === 0;
}

function parseEnv(text) {
  const env = {};

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    env[key] = value;
  }

  return env;
}

function setEnvValue(text, key, value) {
  const normalizedValue = String(value).replace(/\r?\n/g, "\\n");
  const line = `${key}=${normalizedValue}`;
  const pattern = new RegExp(`^${escapeRegExp(key)}=.*$`, "m");

  if (pattern.test(text)) {
    return text.replace(pattern, line);
  }

  const prefix = text.endsWith("\n") || text.length === 0 ? "" : "\n";
  return `${text}${prefix}${line}\n`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ask(question) {
  return new Promise((resolveAnswer) => {
    process.stdout.write(question);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (data) => {
      resolveAnswer(data.toString().trim());
    });
  });
}

function askHidden(question) {
  if (!process.stdin.isTTY) {
    return ask(question);
  }

  return new Promise((resolveAnswer) => {
    let value = "";

    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const onData = (chunk) => {
      const input = chunk.toString("utf8");

      for (const char of input) {
        if (char === "\u0003") {
          process.stdout.write("\n");
          process.exit(130);
        }

        if (char === "\r" || char === "\n" || char === "\u0004") {
          process.stdin.setRawMode(false);
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          resolveAnswer(value.trim());
          return;
        }

        if (char === "\u007f") {
          value = value.slice(0, -1);
          continue;
        }

        value += char;
      }
    };

    process.stdin.on("data", onData);
  });
}
