import express from "express";
import { DATA_DIR, readCurves, readPresets } from "./lib/scanData.js";

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const startedAt = Date.now();

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

app.use("/api", (req, res) => {
  res.status(404).json({ error: `未知接口：${req.path}` });
});

app.use((error, req, res, next) => {
  console.error("[api]", error.message);
  res.status(500).json({ error: error.message });
});

app.listen(PORT, () => {
  console.log(`[api] 监听端口 ${PORT}，数据目录 ${DATA_DIR}`);
});
