import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, readCurves, readPresets } from "./lib/scanData.js";

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const startedAt = Date.now();

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function isWithinDataDir(target, base) {
  const resolvedTarget = path.resolve(target);
  const resolvedBase = path.resolve(base);
  return resolvedTarget === resolvedBase || resolvedTarget.startsWith(`${resolvedBase}${path.sep}`);
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, uptime: Math.floor((Date.now() - startedAt) / 1000) });
});

app.get("/api/curves", async (req, res, next) => {
  try {
    res.json(await readCurves());
  } catch (error) {
    next(error);
  }
});

app.get("/api/presets", async (req, res, next) => {
  try {
    res.json(await readPresets());
  } catch (error) {
    next(error);
  }
});

app.get("/api/curves/content", async (req, res, next) => {
  try {
    const rel = String(req.query.path || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!rel || !rel.startsWith("curves/")) throw new Error("无效的曲线路径");
    const filePath = path.join(DATA_DIR, rel);
    if (!isWithinDataDir(filePath, path.join(DATA_DIR, "curves"))) throw new Error("路径越界");
    const text = await fs.readFile(filePath, "utf8");
    res.type("text/plain; charset=utf-8").send(stripBom(text));
  } catch (error) {
    next(error);
  }
});

app.get("/api/presets/content", async (req, res, next) => {
  try {
    const rel = String(req.query.path || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!rel || !rel.startsWith("presets/")) throw new Error("无效的 EQ 预设路径");
    const filePath = path.join(DATA_DIR, rel);
    if (!isWithinDataDir(filePath, path.join(DATA_DIR, "presets"))) throw new Error("路径越界");
    const text = await fs.readFile(filePath, "utf8");
    res.type("application/json; charset=utf-8").send(stripBom(text));
  } catch (error) {
    next(error);
  }
});

app.use("/api", (req, res) => {
  res.status(404).json({ error: `未知接口：${req.path}` });
});

app.use((error, req, res, next) => {
  console.error("[api]", error.message);
  res.status(500).json({ error: error.message });
});

export { app };

if (process.argv[1] && import.meta.url === new URL(process.argv[1], import.meta.url).href) {
  app.listen(PORT, () => {
    console.log(`[api] 监听端口 ${PORT}，数据目录 ${DATA_DIR}`);
  });
}
