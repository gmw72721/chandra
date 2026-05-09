import { cpSync, existsSync, lstatSync, readdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
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

repairStandaloneNextModuleAliases(standaloneRoot);

function repairStandaloneNextModuleAliases(root) {
  const aliasModulesDir = resolve(root, ".next", "node_modules");
  const standaloneModulesDir = resolve(root, "node_modules");

  if (!existsSync(aliasModulesDir)) {
    return;
  }

  for (const aliasName of readdirSync(aliasModulesDir)) {
    const aliasPath = resolve(aliasModulesDir, aliasName);

    if (!existsSync(aliasPath) && !lstatExists(aliasPath)) {
      continue;
    }

    const stat = lstatSync(aliasPath);

    if (!stat.isSymbolicLink()) {
      continue;
    }

    const linkTarget = readlinkSync(aliasPath);
    const packagePath = packagePathFromNodeModulesLink(linkTarget);

    if (!packagePath) {
      continue;
    }

    const portableTargetPath = resolve(standaloneModulesDir, packagePath);

    if (!existsSync(portableTargetPath)) {
      continue;
    }

    const portableTarget = relative(aliasModulesDir, portableTargetPath);
    unlinkSync(aliasPath);
    symlinkSync(portableTarget, aliasPath, "dir");
  }
}

function lstatExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function packagePathFromNodeModulesLink(linkTarget) {
  const normalizedTarget = (isAbsolute(linkTarget) ? linkTarget : resolve(linkTarget)).split(sep).join("/");
  const marker = "/node_modules/";
  const markerIndex = normalizedTarget.lastIndexOf(marker);

  if (markerIndex === -1) {
    return "";
  }

  return normalizedTarget.slice(markerIndex + marker.length);
}
