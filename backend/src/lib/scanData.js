import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

export const DATA_DIR = process.env.DATA_DIR || path.join(REPO_ROOT, "data");
const CURVE_DIR = path.join(DATA_DIR, "curves");
const PRESET_DIR = path.join(DATA_DIR, "presets");

const CURVE_EXTENSIONS = new Set([".csv", ".txt", ".tsv", ".frd", ".dat"]);

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function sortByName(entries) {
  return entries.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readManifest(dir) {
  try {
    const raw = await fs.readFile(path.join(dir, "manifest.json"), "utf8");
    const data = JSON.parse(stripBom(raw));
    return Array.isArray(data) ? data : data.files || data.entries || [];
  } catch {
    return null;
  }
}

async function listFiles(dir, accept) {
  if (!(await exists(dir))) return [];
  const names = await fs.readdir(dir);
  return names.filter((name) => accept.test(name)).sort();
}

function toEntry(dirLabel, fileName, displayName, text) {
  return {
    name: displayName,
    path: `${dirLabel}/${fileName}`,
    text: stripBom(text)
  };
}

export async function readCurves() {
  const manifest = await readManifest(CURVE_DIR);
  if (!manifest) {
    const files = await listFiles(CURVE_DIR, /\.(csv|txt|tsv|frd|dat)$/i);
    const entries = await Promise.all(
      files.map(async (fileName) => {
        const text = await fs.readFile(path.join(CURVE_DIR, fileName), "utf8");
        return toEntry("curves", fileName, path.basename(fileName, path.extname(fileName)), text);
      })
    );
    return sortByName(entries);
  }

  const entries = [];
  for (const item of manifest) {
    if (!item || !item.path) continue;
    const fileName = path.basename(item.path);
    if (!CURVE_EXTENSIONS.has(path.extname(fileName).toLowerCase())) continue;
    const filePath = path.join(CURVE_DIR, fileName);
    if (!(await exists(filePath))) continue;
    const text = await fs.readFile(filePath, "utf8");
    entries.push(toEntry("curves", fileName, item.name || path.basename(fileName, path.extname(fileName)), text));
  }
  return sortByName(entries);
}

export async function readPresets() {
  const files = await listFiles(PRESET_DIR, /\.json$/i);
  const entries = await Promise.all(
    files
      .filter((fileName) => fileName !== "manifest.json")
      .map(async (fileName) => {
        const text = await fs.readFile(path.join(PRESET_DIR, fileName), "utf8");
        return toEntry("presets", fileName, path.basename(fileName, ".json"), text);
      })
  );
  return sortByName(entries);
}
