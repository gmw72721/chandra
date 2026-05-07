import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frontendNextDir = resolve(projectRoot, "frontend", ".next");
const rootNextDir = resolve(projectRoot, ".next");

rmSync(rootNextDir, { force: true, recursive: true });
cpSync(frontendNextDir, rootNextDir, { recursive: true });

const standaloneRoot = resolve(rootNextDir, "standalone");
const nestedStandaloneRoot = resolve(standaloneRoot, "frontend");

for (const entry of [".next", "server.js"]) {
  const source = resolve(nestedStandaloneRoot, entry);
  const target = resolve(standaloneRoot, entry);

  if (existsSync(source) && !existsSync(target)) {
    cpSync(source, target, { recursive: true });
  }
}
