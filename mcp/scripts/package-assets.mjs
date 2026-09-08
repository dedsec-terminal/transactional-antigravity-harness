import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundleRoot = path.join(packageRoot, "bundle");
const sourceSkills = path.resolve(packageRoot, "..", "skills");
const bundledSkills = path.join(bundleRoot, "skills");
const action = process.argv[2];

if (action === "prepare") {
  await rm(bundleRoot, { recursive: true, force: true });
  await mkdir(bundleRoot, { recursive: true });
  await cp(sourceSkills, bundledSkills, { recursive: true, force: true });
} else if (action === "clean") {
  await rm(bundleRoot, { recursive: true, force: true });
} else {
  throw new Error("Expected package-assets action: prepare or clean");
}
