import { reactive } from "vue";

/* ============================================================
 * DOVE EQ WEB — 引擎核心
 * 原版原生逻辑忠实移植到 Vue reactive 状态。
 * 画布绘制 / 拖拽 / 曲线库 / 预设 / 设备 PEQ 全部保留。
 * ============================================================ */

const SAMPLE_RATE = 48000;
const MAX_FILTERS = 8;
const CURVE_LIBRARY_DIR = "/曲线库";
const CURVE_LIBRARY_MANIFEST = `${CURVE_LIBRARY_DIR}/manifest.json`;
const CURVE_LIBRARY_SCRIPT = `${CURVE_LIBRARY_DIR}/curve-library.generated.js`;
const CURVE_LIBRARY_GLOBAL_KEY = "__EQ_CURVE_LIBRARY_DATA";
const EQ_LIBRARY_DIR = "/eq库";
const EQ_LIBRARY_MANIFEST = `${EQ_LIBRARY_DIR}/manifest.json`;
const EQ_LIBRARY_SCRIPT = `${EQ_LIBRARY_DIR}/eq-library.generated.js`;
const EQ_LIBRARY_GLOBAL_KEY = "__EQ_PRESET_LIBRARY_DATA";
const SUPPORTED_CURVE_EXTENSIONS = [".txt", ".csv", ".frd", ".tsv", ".dat"];
const SUPPORTED_EQ_PRESET_EXTENSIONS = [".json", ".eqpreset"];
const FIXED_UI_MIN_WIDTH = 1460;
const FIXED_UI_MIN_HEIGHT = 900;
const MIN_FILTER_Q = 0.2;
const MAX_FILTER_Q = 4;
const FILTER_Q_STEP = 0.1;

function uuid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

function buildFrequencies(min, max, count) {
  const out = [];
  const ratio = Math.pow(max / min, 1 / (count - 1));
  let current = min;
  for (let i = 0; i < count; i += 1) {
    out.push(Math.round(current * 1000) / 1000);
    current *= ratio;
  }
  return out;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

const EQ_FREQUENCIES = buildFrequencies(20, 20000, 512);

const FILTER_COLORS = [
  "#4ca1ff",
  "#ff7ab6",
  "#7ee081",
  "#ffcf5c",
  "#b58cff",
  "#5ce0d8",
  "#ff8a5c",
  "#9aa6ff"
];

const DEFAULT_FILTER_FREQUENCIES = [50, 200, 500, 1000, 2500, 5000, 10000, 15000];

/* ---------- 标准数学工具（供组件复用） ---------- */
function roundToStep(value, step) {
  if (!step) return value;
  return Math.round(value / step) * step;
}
function freqToSlider(freq, min, max, sliderMin, sliderMax) {
  const minLog = Math.log(min);
  const maxLog = Math.log(max);
  const ratio = (Math.log(clamp(freq, min, max)) - minLog) / (maxLog - minLog);
  return sliderMin + ratio * (sliderMax - sliderMin);
}
function sliderToFreq(sliderValue, min, max, sliderMin, sliderMax) {
  const ratio = (sliderValue - sliderMin) / (sliderMax - sliderMin || 1);
  return Math.exp(Math.log(min) + ratio * (Math.log(max) - Math.log(min)));
}
function xToFreq(x, min, max, left, width) {
  const ratio = (clamp(x, left, left + width) - left) / (width || 1);
  return Math.exp(Math.log(min) + ratio * (Math.log(max) - Math.log(min)));
}
function yToDb(y, minDb, maxDb, top, height) {
  const ratio = 1 - (clamp(y, top, top + height) - top) / (height || 1);
  return minDb + ratio * (maxDb - minDb);
}
function dbToY(db, minDb, maxDb, top, height) {
  const ratio = (db - minDb) / (maxDb - minDb || 1);
  return top + height - ratio * height;
}

export const math = {
  clamp,
  roundToStep,
  freqToSlider,
  sliderToFreq,
  xToFreq,
  yToDb,
  dbToY
};

/* ============================================================
 * 引擎工厂
 * ============================================================ */
export function createEqEngine() {
  const state = reactive({
    filters: [],
    showIndividuals: false,
    showZeroBaseline: true,
    showTotalEqTrace: true,
    showImportedRawTrace: true,
    showImportedEqTrace: true,
    preamp: 0,
    refFreq: 1000,
    importedRaw: null,
    importedNormalized: null,
    importedFileName: "",
    curveLibraryEntries: [],
    curveLibraryFilteredEntries: [],
    curveLibrarySearch: "",
    eqLibraryEntries: [],
    eqLibraryFilteredEntries: [],
    eqLibrarySearch: "",
    selectedCurveLibraryPath: "",
    selectedEqLibraryPath: "",
    closeGuardEnabled: false,
    eqLibraryDirectoryHandle: null,
    uiBaseWidth: FIXED_UI_MIN_WIDTH,
    uiBaseHeight: FIXED_UI_MIN_HEIGHT,
    /* 状态文字（替代原版 els.X.textContent） */
    status: "",
    importStatus: "",
    importStatusTone: "",
    curveLibraryStatus: "",
    curveLibraryStatusTone: "",
    eqLibraryStatus: "",
    eqLibraryStatusTone: "",
    devicePeqHint: "",
    devicePeqStatus: "",
    devicePeqStatusTone: ""
  });

  const plotInteraction = {
    markers: [],
    layout: null,
    activePointerId: null,
    draggingFilterId: null,
    dragMode: null,
    dragSnapshot: null,
    needsFilterUiRefresh: false
  };

  let curveLibraryScriptPromise = null;
  let eqLibraryScriptPromise = null;
  let canvas = null;
  let devicePeqRuntimePromise = null;

  /* ---------- 状态文字 setter ---------- */
  function setImportStatus(text, tone) {
    state.importStatus = text || "";
    state.importStatusTone = tone || "";
  }
  function setCurveLibraryStatus(text, tone) {
    state.curveLibraryStatus = text || "";
    state.curveLibraryStatusTone = tone || "";
  }
  function setDevicePeqStatus(text, tone) {
    state.devicePeqStatus = text || "";
    state.devicePeqStatusTone = tone || "";
  }
  function setEqLibraryStatus(text, tone) {
    state.eqLibraryStatus = text || "";
    state.eqLibraryStatusTone = tone || "";
  }
  function setDevicePeqHint(text) {
    state.devicePeqHint = text || "";
  }

  /* ---------- 设备 PEQ ---------- */
  function normalizeDeviceFilterType() {
    return "PK";
  }
  function getDevicePeqFilters(includeDisabled = false) {
    return state.filters
      .filter((f) => includeDisabled || f.enabled)
      .map((f) => ({
        disabled: !f.enabled,
        type: normalizeDeviceFilterType(f.type),
        freq: Math.round(clamp(Number(f.freq) || 1000, 20, 20000)),
        q: roundToStep(clamp(Number(f.q) || 1, MIN_FILTER_Q, MAX_FILTER_Q), FILTER_Q_STEP),
        gain: roundToStep(clamp(Number(f.gain) || 0, -10, 10), 0.1)
      }));
  }
  function applyDevicePeqFilters(filters) {
    state.filters = Array.from(filters || [])
      .slice(0, MAX_FILTERS)
      .map((f) => ({
        id: uuid(),
        enabled: f.disabled !== true,
        showTrace: false,
        type: normalizeDeviceFilterType(f.type),
        freq: clamp(Math.round(Number(f.freq) || 1000), 20, 20000),
        q: clamp(roundToStep(Number(f.q) || 1, FILTER_Q_STEP), MIN_FILTER_Q, MAX_FILTER_Q),
        gain: clamp(roundToStep(Number(f.gain) || 0, 0.2), -10, 10)
      }))
      .filter((f) => f && f.id);
    renderAll();
  }
  function calcEqDevPreamp() {
    return Number.isFinite(state.preamp) ? state.preamp : 0;
  }
  function notifyExtensionFiltersUpdated() {
    document.dispatchEvent(new CustomEvent("UpdateExtensionFilters"));
  }

  function loadDevicePeqRuntime() {
    if (typeof window.initializeDeviceEqPlugin === "function") {
      return Promise.resolve(window.initializeDeviceEqPlugin);
    }
    if (devicePeqRuntimePromise) return devicePeqRuntimePromise;
    devicePeqRuntimePromise = new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-device-peq-runtime="true"]');
      if (existing) {
        existing.addEventListener("load", () => resolve(window.initializeDeviceEqPlugin), { once: true });
        existing.addEventListener("error", () => reject(new Error("Device PEQ bundle 加载失败。")), { once: true });
        return;
      }
      const script = document.createElement("script");
      script.src = "/vendor/devicepeq/devicepeq.bundle.js?v=20260318d";
      script.async = true;
      script.dataset.devicePeqRuntime = "true";
      script.addEventListener("load", () => {
        if (typeof window.initializeDeviceEqPlugin === "function") {
          resolve(window.initializeDeviceEqPlugin);
          return;
        }
        reject(new Error("Device PEQ bundle 已加载，但初始化入口不存在。"));
      }, { once: true });
      script.addEventListener("error", () => {
        reject(new Error("Device PEQ bundle 加载失败。请确认 vendor/devicepeq/devicepeq.bundle.js 存在。"));
      }, { once: true });
      document.head.appendChild(script);
    });
    return devicePeqRuntimePromise;
  }

  function ensureDevicePeqHelpUi() {
    const deviceEqArea = document.getElementById("deviceEqArea");
    if (!deviceEqArea) return;
    const heading = deviceEqArea.querySelector("h4");
    const peqSlotArea = deviceEqArea.querySelector(".peq-slot-area");
    const connectButton = deviceEqArea.querySelector(".connect-device");
    if (!heading || !connectButton || !peqSlotArea) return;

    let head = deviceEqArea.querySelector(".device-peq-head");
    if (!head) {
      head = document.createElement("div");
      head.className = "device-peq-head";
      heading.insertAdjacentElement("beforebegin", head);
    }
    let wrap = deviceEqArea.querySelector(".device-peq-help-wrap");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "device-peq-help-wrap";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "device-peq-help-btn";
      button.setAttribute("aria-label", "Device PEQ 帮助");
      button.textContent = "?";
      const popover = document.createElement("div");
      popover.id = "devicePeqHintPopover";
      popover.className = "device-peq-help-popover";
      wrap.append(button, popover);
    }
    head.append(heading, peqSlotArea, connectButton, wrap);
    setDevicePeqHint(state.devicePeqHint);
  }

  async function initDevicePeqIntegration() {
    if (!window.isSecureContext) {
      setDevicePeqHint("Device PEQ 需要安全上下文。请优先通过 localhost 或 HTTPS 打开此页面。");
      setDevicePeqStatus("当前页面不在安全上下文中，无法访问 WebHID / WebSerial。", "error");
      return;
    }
    if (!("hid" in navigator) && !("serial" in navigator)) {
      setDevicePeqHint("当前浏览器未提供 WebHID / WebSerial，无法连接支持 Device PEQ 的设备。推荐使用最新版 Chrome 或 Edge。");
      setDevicePeqStatus("当前浏览器不支持 Device PEQ 所需接口。", "error");
      return;
    }
    try {
      const initializeDeviceEqPlugin = await loadDevicePeqRuntime();
      await initializeDeviceEqPlugin({
        config: {
          advanced: false,
          showLogs: false,
          devicePEQHeadingTag: "h4",
          devicePEQAnchorDiv: "#devicePeqAnchor",
          devicePEQPlacement: "afterend"
        },
        elemToFilters: getDevicePeqFilters,
        filtersToElem: applyDevicePeqFilters,
        applyEQ: renderAll,
        calcEqDevPreamp
      });
      ensureDevicePeqHelpUi();
      setDevicePeqHint(
        location.protocol === "file:"
          ? "已加载 Device PEQ。当前为本地文件离线模式，连接设备仍取决于浏览器对 WebHID / WebSerial 的支持。"
          : "已加载 Device PEQ。仅部分设备支持直连写入，设备能力取决于其协议与浏览器接口支持。"
      );
      setDevicePeqStatus(
        `运行方式：${location.protocol === "file:" ? "本地文件" : "网页"} | 浏览器接口：${"hid" in navigator ? "WebHID" : ""}${"hid" in navigator && "serial" in navigator ? " + " : ""}${"serial" in navigator ? "WebSerial" : ""}`,
        "ok"
      );
    } catch (error) {
      console.error("Device PEQ 初始化失败：", error);
      setDevicePeqHint(`Device PEQ 初始化失败：${error.message}`);
      setDevicePeqStatus(
        location.protocol === "file:"
          ? "如果你是直接双击打开 HTML，现在已经改为 bundle 模式；若仍失败，请确认整个 web 目录结构完整。"
          : "如果页面通过 localhost 打开仍失败，请检查 vendor/devicepeq 下的脚本是否完整。",
        "error"
      );
    }
  }

  function getWalkplayKt1213Toolkit() {
    if (!window.walkplayKt1213Toolkit) throw new Error("walkplayKt1213Toolkit.js 未加载。");
    return window.walkplayKt1213Toolkit;
  }
  function buildWalkplayCurrentEqProfile(options = {}) {
    const toolkit = getWalkplayKt1213Toolkit();
    return toolkit.fromAppFilters(state.filters, {
      source: "eq-sim-demo",
      layout: options.layout || DEFAULT_FILTER_FREQUENCIES.slice(),
      bandCount: options.bandCount || Math.min(state.filters.length || MAX_FILTERS, MAX_FILTERS),
      preamp: calcEqDevPreamp()
    });
  }
  function buildWalkplayCurrentPackets(options = {}) {
    const toolkit = getWalkplayKt1213Toolkit();
    const profile = buildWalkplayCurrentEqProfile(options);
    return toolkit.buildEqPackets(profile, {
      includeCommitPacket: options.includeCommitPacket === true,
      appendCrc: options.appendCrc === true
    });
  }
  async function connectWalkplayKt1213(options = {}) {
    const toolkit = getWalkplayKt1213Toolkit();
    try {
      const device = options.useGrantedDevice
        ? await toolkit.reconnectGrantedDevice()
        : await toolkit.requestDevice();
      setDevicePeqHint("KT1213 辅助写入工具已就绪。可调用 pushCurrentEqToWalkplayKt1213() 将当前页面 EQ 按 WalkPlay 站点协议写入设备。");
      setDevicePeqStatus(`KT1213 已连接：${device.productName || "WalkPlay Device"}`, "ok");
      return device;
    } catch (error) {
      setDevicePeqStatus(`KT1213 连接失败：${error.message}`, "error");
      throw error;
    }
  }
  async function pushCurrentEqToWalkplayKt1213(options = {}) {
    const toolkit = getWalkplayKt1213Toolkit();
    try {
      let device = toolkit.getConnectedDevice();
      if (!device) device = await connectWalkplayKt1213(options);
      const profile = buildWalkplayCurrentEqProfile(options);
      const result = await toolkit.writeEqProfile(profile, {
        device,
        includeCommitPacket: options.includeCommitPacket !== false,
        packetDelayMs: Math.max(0, Number(options.packetDelayMs) || 0)
      });
      setDevicePeqStatus(`KT1213 已写入 ${result.profile.filters.length} 段 EQ。`, "ok");
      return result;
    } catch (error) {
      setDevicePeqStatus(`KT1213 写入失败：${error.message}`, "error");
      throw error;
    }
  }
  function attachWalkplayKt1213Bridge() {
    window.getWalkplayKt1213Toolkit = getWalkplayKt1213Toolkit;
    window.buildWalkplayCurrentEqProfile = buildWalkplayCurrentEqProfile;
    window.buildWalkplayCurrentPackets = buildWalkplayCurrentPackets;
    window.connectWalkplayKt1213 = connectWalkplayKt1213;
    window.pushCurrentEqToWalkplayKt1213 = pushCurrentEqToWalkplayKt1213;
  }

  /* ---------- 滤波器集合管理 ---------- */
  function syncIndividualsToggle() {
    state.showIndividuals = state.showIndividuals;
  }
  function refreshIndividualsToggleFromFilters() {
    state.showIndividuals = state.filters.length > 0 && state.filters.every((f) => f.showTrace !== false);
  }
  function createDefaultFilters() {
    return DEFAULT_FILTER_FREQUENCIES.map((freq) => ({
      id: uuid(),
      enabled: true,
      showTrace: false,
      type: "PK",
      freq,
      q: 0.75,
      gain: 0.0
    }));
  }
  function makeFilter() {
    return { id: uuid(), enabled: true, showTrace: false, type: "PK", freq: 1000, q: 1, gain: 3 };
  }
  function addFilter() {
    if (state.filters.length >= MAX_FILTERS) return;
    state.filters.push(makeFilter());
    renderAll();
  }
  function removeFilter(id) {
    state.filters = state.filters.filter((f) => f.id !== id);
    renderAll();
  }
  function resetFilter(index) {
    const filter = state.filters[index];
    if (!filter) return;
    filter.freq = DEFAULT_FILTER_FREQUENCIES[index] || 1000;
    filter.q = 0.2;
    filter.gain = 0;
    filter.type = "PK";
    renderAll();
  }
  function toggleFilterEnabled(index) {
    const filter = state.filters[index];
    if (!filter) return;
    filter.enabled = !filter.enabled;
    renderAll();
  }
  function updateFilterFreq(index, value) {
    const filter = state.filters[index];
    if (!filter) return;
    filter.freq = clamp(Math.round(value), 20, 20000);
    drawPlot();
  }
  function updateFilterQ(index, value) {
    const filter = state.filters[index];
    if (!filter) return;
    filter.q = clamp(roundToStep(value, FILTER_Q_STEP), MIN_FILTER_Q, MAX_FILTER_Q);
    drawPlot();
  }
  function updateFilterGain(index, value) {
    const filter = state.filters[index];
    if (!filter) return;
    filter.gain = clamp(roundToStep(value, 0.2), -10, 10);
    drawPlot();
  }
  function setShowIndividuals(value) {
    state.showIndividuals = value;
    state.filters.forEach((f) => {
      f.showTrace = value;
    });
    drawPlot();
  }
  function setPreamp(value) {
    state.preamp = clamp(roundToStep(value, 0.2), -30, 10);
    drawPlot();
  }
  function autoPreamp() {
    state.preamp = clamp(calcSuggestedPreamp(getTotalTrace(state.filters)), -30, 10);
    renderAll();
  }
  function resetAll() {
    const confirmed = window.confirm("确认重置全部 EQ 吗？当前频点、增益和 Q 值都会恢复到初始位置。");
    if (!confirmed) return;
    state.filters = createDefaultFilters();
    renderAll();
  }

  /* ---------- 预设 ---------- */
  function isSupportedEqPresetFile(fileName) {
    const lower = String(fileName || "").toLowerCase();
    return SUPPORTED_EQ_PRESET_EXTENSIONS.some((ext) => lower.endsWith(ext));
  }
  function sanitizeEqPresetName(name) {
    const cleaned = String(name || "")
      .trim()
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, " ");
    return cleaned || `EQ-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;
  }
  function buildEqPresetString() {
    const parts = ["EQv1"];
    state.filters.forEach((f) => {
      const freq = Math.round(clamp(Number(f.freq) || 1000, 20, 20000));
      const q = roundToStep(clamp(Number(f.q) || 0.75, MIN_FILTER_Q, MAX_FILTER_Q), FILTER_Q_STEP);
      const gain = roundToStep(clamp(Number(f.gain) || 0, -10, 10), 0.2);
      parts.push(`${freq},${q.toFixed(1)},${gain.toFixed(1)}`);
    });
    return parts.join("|");
  }
  function normalizeEqPresetFilter(filter, index) {
    return {
      id: uuid(),
      enabled: filter && filter.enabled !== false,
      showTrace: filter && filter.showTrace === true,
      type: normalizeDeviceFilterType(filter && filter.type),
      freq: clamp(Math.round(Number(filter && filter.freq) || DEFAULT_FILTER_FREQUENCIES[index] || 1000), 20, 20000),
      q: clamp(roundToStep(Number(filter && filter.q) || 0.75, FILTER_Q_STEP), MIN_FILTER_Q, MAX_FILTER_Q),
      gain: clamp(roundToStep(Number(filter && filter.gain) || 0, 0.2), -10, 10)
    };
  }
  function parseEqPresetText(text, sourceName) {
    const normalizedText = String(text || "").trim().replace(/^\uFEFF/, "");
    if (!normalizedText) throw new Error(`${sourceName || "EQ 文件"} 为空。`);
    if (normalizedText.startsWith("{") || normalizedText.startsWith("[")) {
      let payload;
      try {
        payload = JSON.parse(normalizedText);
      } catch (e) {
        throw new Error(`${sourceName || "EQ 文件"} 不是有效的 EQ 字符串。`);
      }
      if (!payload || typeof payload !== "object" || !Array.isArray(payload.filters)) {
        throw new Error(`${sourceName || "EQ 文件"} 中缺少有效的滤波器数据。`);
      }
      return payload;
    }
    const segments = normalizedText.split("|").map((s) => s.trim()).filter(Boolean);
    if (!segments.length || segments[0] !== "EQv1") {
      throw new Error(`${sourceName || "EQ 文件"} 不是有效的 EQ 字符串。`);
    }
    const filters = segments.slice(1).map((segment) => {
      const values = segment.split(",").map((s) => s.trim());
      if (values.length < 3) throw new Error(`${sourceName || "EQ 文件"} 中存在无法识别的 EQ 字符串片段。`);
      const freq = Number(values[0]);
      const q = Number(values[1]);
      const gain = Number(values[2]);
      if (!Number.isFinite(freq) || !Number.isFinite(q) || !Number.isFinite(gain)) {
        throw new Error(`${sourceName || "EQ 文件"} 中存在无效的频点/Q/增益数值。`);
      }
      return { enabled: true, showTrace: false, type: "PK", freq, q, gain };
    });
    if (!filters.length) throw new Error(`${sourceName || "EQ 文件"} 中没有可用的 EQ 数据。`);
    return { version: 1, name: sourceName || "EQ 字符串", filters };
  }
  function applyEqPresetPayload(payload, sourceName) {
    const filters = Array.from(payload.filters.slice(0, MAX_FILTERS))
      .map((f, i) => normalizeEqPresetFilter(f, i))
      .filter((f) => f && f.id);
    if (!filters.length) throw new Error(`${sourceName || "EQ 文件"} 中没有可用的 EQ 数据。`);
    if (Object.prototype.hasOwnProperty.call(payload, "preamp")) {
      state.preamp = clamp(roundToStep(Number(payload.preamp) || 0, 0.2), -30, 10);
    }
    state.filters = filters;
    renderAll();
    setEqLibraryStatus(`已加载 ${sourceName || payload.name || "EQ 文件"}。`, "ok");
  }
  async function importEqPresetFile(file) {
    if (!file) return;
    if (!isSupportedEqPresetFile(file.name)) {
      setEqLibraryStatus("仅支持 .json / .eqpreset 格式的 EQ 文件。", "error");
      return;
    }
    try {
      const text = await file.text();
      const payload = parseEqPresetText(text, file.name);
      applyEqPresetPayload(payload, (payload.name || file.name).replace(/\.[^.]+$/, ""));
    } catch (error) {
      setEqLibraryStatus(`载入失败：${error.message}`, "error");
    }
  }
  function downloadTextFile(text, fileName) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  function buildEqPresetSavePickerOptions(fileName) {
    const options = {
      id: "eq-preset-save",
      suggestedName: fileName,
      startIn: "documents",
      types: [{ description: "EQ 字符串预设", accept: { "text/plain": [".eqpreset"] } }]
    };
    if (state.eqLibraryDirectoryHandle) options.startIn = state.eqLibraryDirectoryHandle;
    return options;
  }
  async function ensureEqLibraryDirectoryHandle() {
    if (!window.showDirectoryPicker || !window.isSecureContext) return null;
    if (state.eqLibraryDirectoryHandle) {
      try {
        if (typeof state.eqLibraryDirectoryHandle.queryPermission === "function") {
          const permission = await state.eqLibraryDirectoryHandle.queryPermission({ mode: "read" });
          if (permission === "granted") return state.eqLibraryDirectoryHandle;
        } else {
          return state.eqLibraryDirectoryHandle;
        }
      } catch (e) {
        console.warn("EQ 库目录权限检查失败：", e);
      }
    }
    setEqLibraryStatus("首次打开请定位到 web/eq库 文件夹，之后会记住该目录。", "");
    const handle = await window.showDirectoryPicker({ id: "eq-library-folder", mode: "read" });
    state.eqLibraryDirectoryHandle = handle;
    setEqLibraryStatus(`已绑定 EQ 库目录：${handle.name || "eq库"}。`, "ok");
    loadEqLibrary(true);
    return handle;
  }
  function buildEqPresetOpenPickerOptions() {
    const options = {
      id: "eq-preset-open",
      multiple: false,
      startIn: "documents",
      types: [{ description: "EQ 预设文件", accept: { "application/json": [".json"], "text/plain": [".eqpreset"] } }]
    };
    if (state.eqLibraryDirectoryHandle) options.startIn = state.eqLibraryDirectoryHandle;
    return options;
  }
  async function saveCurrentEqPreset() {
    const rawName = window.prompt("请输入 EQ 文件名称：", getDefaultEqPresetName());
    if (rawName === null) return;
    const suggestedName = sanitizeEqPresetName(rawName);
    const fileName = `${suggestedName}.eqpreset`;
    const text = `${buildEqPresetString()}\n`;
    try {
      if (window.showSaveFilePicker && window.isSecureContext) {
        const fileHandle = await window.showSaveFilePicker(buildEqPresetSavePickerOptions(fileName));
        const writable = await fileHandle.createWritable();
        await writable.write(text);
        await writable.close();
        setEqLibraryStatus(`已保存 ${fileHandle.name || fileName}。`, "ok");
        loadEqLibrary(true);
        return;
      }
    } catch (error) {
      if (error && error.name === "AbortError") return;
      console.error("保存 EQ 文件失败：", error);
    }
    downloadTextFile(text, fileName);
    setEqLibraryStatus(`已导出 ${fileName}，如需进入项目库，请保存到 web/eq库。`, "ok");
  }
  async function openEqPresetFile() {
    if (window.showOpenFilePicker && window.isSecureContext) {
      try {
        await ensureEqLibraryDirectoryHandle();
        const [fileHandle] = await window.showOpenFilePicker(buildEqPresetOpenPickerOptions());
        if (!fileHandle) return;
        const file = await fileHandle.getFile();
        await importEqPresetFile(file);
        loadEqLibrary(true);
        return;
      } catch (error) {
        if (error && error.name === "AbortError") return;
        console.error("打开 EQ 文件失败：", error);
      }
    }
    if (openEqFileInputRef) openEqFileInputRef.click();
  }
  let openEqFileInputRef = null;
  function registerOpenEqFileInput(el) {
    openEqFileInputRef = el;
  }
  async function handleOpenEqFileInputChange(event) {
    const [file] = Array.from((event.target && event.target.files) || []);
    if (!file) return;
    await importEqPresetFile(file);
    if (event.target) event.target.value = "";
  }

  /* ---------- 滤波器数学 ---------- */
  function lowshelf(freq, q, gain, sampleRate) {
    freq = clamp(freq / sampleRate, 1e-6, 1);
    q = clamp(q, 1e-4, 1000);
    gain = clamp(gain, -40, 40);
    const w0 = 2 * Math.PI * freq;
    const sin = Math.sin(w0);
    const cos = Math.cos(w0);
    const a = Math.pow(10, gain / 40);
    const alpha = sin / (2 * q);
    const alphaMod = 2 * Math.sqrt(a) * alpha || 0;
    const a0 = (a + 1) + (a - 1) * cos + alphaMod;
    const a1 = -2 * ((a - 1) + (a + 1) * cos);
    const a2 = (a + 1) + (a - 1) * cos - alphaMod;
    const b0 = a * ((a + 1) - (a - 1) * cos + alphaMod);
    const b1 = 2 * a * ((a - 1) - (a + 1) * cos);
    const b2 = a * ((a + 1) - (a - 1) * cos - alphaMod);
    return [1, a1 / a0, a2 / a0, b0 / a0, b1 / a0, b2 / a0];
  }
  function highshelf(freq, q, gain, sampleRate) {
    freq = clamp(freq / sampleRate, 1e-6, 1);
    q = clamp(q, 1e-4, 1000);
    gain = clamp(gain, -40, 40);
    const w0 = 2 * Math.PI * freq;
    const sin = Math.sin(w0);
    const cos = Math.cos(w0);
    const a = Math.pow(10, gain / 40);
    const alpha = sin / (2 * q);
    const alphaMod = 2 * Math.sqrt(a) * alpha || 0;
    const a0 = (a + 1) - (a - 1) * cos + alphaMod;
    const a1 = 2 * ((a - 1) - (a + 1) * cos);
    const a2 = (a + 1) - (a - 1) * cos - alphaMod;
    const b0 = a * ((a + 1) + (a - 1) * cos + alphaMod);
    const b1 = -2 * a * ((a - 1) + (a + 1) * cos);
    const b2 = a * ((a + 1) + (a - 1) * cos - alphaMod);
    return [1, a1 / a0, a2 / a0, b0 / a0, b1 / a0, b2 / a0];
  }
  function peaking(freq, q, gain, sampleRate) {
    freq = clamp(freq / sampleRate, 1e-6, 1);
    q = clamp(q, 1e-4, 1000);
    gain = clamp(gain, -40, 40);
    const w0 = 2 * Math.PI * freq;
    const sin = Math.sin(w0);
    const cos = Math.cos(w0);
    const a = Math.pow(10, gain / 40);
    const alpha = sin / (2 * q);
    const a0 = 1 + alpha / a;
    const a1 = -2 * cos;
    const a2 = 1 - alpha / a;
    const b0 = 1 + alpha * a;
    const b1 = -2 * cos;
    const b2 = 1 - alpha * a;
    return [1, a1 / a0, a2 / a0, b0 / a0, b1 / a0, b2 / a0];
  }
  function filterToCoeffs(filter) {
    if (filter.type === "LSQ") return lowshelf(filter.freq, filter.q, filter.gain, SAMPLE_RATE);
    if (filter.type === "HSQ") return highshelf(filter.freq, filter.q, filter.gain, SAMPLE_RATE);
    return peaking(filter.freq, filter.q, filter.gain, SAMPLE_RATE);
  }
  function calcGains(freqs, coeffs) {
    const gains = new Array(freqs.length).fill(0);
    for (let i = 0; i < coeffs.length; i += 1) {
      const [a0, a1, a2, b0, b1, b2] = coeffs[i];
      for (let j = 0; j < freqs.length; j += 1) {
        const w = 2 * Math.PI * freqs[j] / SAMPLE_RATE;
        const phi = 4 * Math.pow(Math.sin(w / 2), 2);
        const response =
          10 * Math.log10(Math.pow(b0 + b1 + b2, 2) + (b0 * b2 * phi - (b1 * (b0 + b2) + 4 * b0 * b2)) * phi) -
          10 * Math.log10(Math.pow(a0 + a1 + a2, 2) + (a0 * a2 * phi - (a1 * (a0 + a2) + 4 * a0 * a2)) * phi);
        gains[j] += response;
      }
    }
    return gains;
  }
  function getFilterTrace(filter) {
    const coeffs = filterToCoeffs(filter);
    const gains = calcGains(EQ_FREQUENCIES, [coeffs]);
    return EQ_FREQUENCIES.map((freq, index) => [freq, gains[index]]);
  }
  function getTotalTrace(filters) {
    const enabled = filters.filter((f) => f.enabled);
    if (!enabled.length) return EQ_FREQUENCIES.map((freq) => [freq, 0]);
    const coeffs = enabled.map(filterToCoeffs);
    const gains = calcGains(EQ_FREQUENCIES, coeffs);
    return EQ_FREQUENCIES.map((freq, index) => [freq, gains[index]]);
  }
  function calcSuggestedPreamp(totalTrace) {
    const peak = totalTrace.reduce((max, [, value]) => Math.max(max, value), -Infinity);
    if (!Number.isFinite(peak) || peak <= 0) return 0;
    return roundToStep(-peak, 0.2);
  }
  function applyEqToResponse(points, filters, preamp) {
    const enabled = filters.filter((f) => f.enabled);
    const preampGain = Number.isFinite(preamp) ? preamp : 0;
    if (!enabled.length) return points.map(([freq, value]) => [freq, value + preampGain]);
    const coeffs = enabled.map(filterToCoeffs);
    const freqs = points.map(([freq]) => freq);
    const gains = calcGains(freqs, coeffs);
    return points.map(([freq, value], index) => [freq, value + gains[index] + preampGain]);
  }
  function interpolateAt(points, targetFreq) {
    if (!points || !points.length) return 0;
    if (targetFreq <= points[0][0]) return points[0][1];
    for (let i = 1; i < points.length; i += 1) {
      const [f1, v1] = points[i];
      const [f0, v0] = points[i - 1];
      if (targetFreq <= f1) {
        const x0 = Math.log(f0);
        const x1 = Math.log(f1);
        const xt = Math.log(targetFreq);
        const ratio = (xt - x0) / (x1 - x0 || 1);
        return v0 + (v1 - v0) * ratio;
      }
    }
    return points[points.length - 1][1];
  }
  function normalizeResponse(points, refFreq) {
    const refValue = interpolateAt(points, refFreq);
    return points.map(([freq, value]) => [freq, value - refValue]);
  }
  function parseFrequencyResponse(text) {
    const rows = [];
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
      const matches = trimmed.match(/[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g);
      if (!matches || matches.length < 2) continue;
      const freq = Number(matches[0]);
      const value = Number(matches[1]);
      if (!Number.isFinite(freq) || !Number.isFinite(value) || freq <= 0) continue;
      rows.push([freq, value]);
    }
    rows.sort((a, b) => a[0] - b[0]);
    const unique = [];
    for (const row of rows) {
      const last = unique[unique.length - 1];
      if (!last || Math.abs(last[0] - row[0]) > 1e-6) unique.push(row);
      else unique[unique.length - 1] = row;
    }
    return unique;
  }
  function importCurveFromText(text, fileName) {
    const points = parseFrequencyResponse(text);
    if (points.length < 10) throw new Error("解析失败：有效数据点太少，至少需要 10 个点。");
    const refFreq = clamp(Number(state.refFreq) || 1000, 20, 20000);
    state.importedRaw = points;
    state.importedNormalized = normalizeResponse(points, refFreq);
    state.importedFileName = fileName || "导入曲线";
    setImportStatus(
      `已导入 ${state.importedFileName}，共 ${points.length} 个点，已按 ${Math.round(refFreq)} Hz 归一化到 0 dB。`,
      "ok"
    );
  }
  function isSupportedCurveFile(filePath) {
    const lower = String(filePath || "").toLowerCase();
    return SUPPORTED_CURVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
  }
  function normalizeCurveLibraryPath(filePath) {
    const normalized = String(filePath || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
    if (!normalized) return "";
    if (normalized.startsWith("曲线库/")) return `/${normalized}`;
    return `${CURVE_LIBRARY_DIR}/${normalized.replace(/^曲线库\//, "")}`;
  }
  function getCurveDisplayName(filePath, preferredName) {
    if (preferredName) return preferredName;
    const fileName = String(filePath || "").replace(/\\/g, "/").split("/").pop() || "未命名曲线";
    return fileName.replace(/\.[^.]+$/, "");
  }
  function normalizeEqLibraryPath(filePath) {
    const normalized = String(filePath || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
    if (!normalized) return "";
    if (normalized.startsWith("eq库/")) return `/${normalized}`;
    return `${EQ_LIBRARY_DIR}/${normalized.replace(/^eq库\//, "")}`;
  }
  function getEqDisplayName(filePath, preferredName) {
    if (preferredName) return preferredName;
    const fileName = String(filePath || "").replace(/\\/g, "/").split("/").pop() || "未命名EQ";
    return fileName.replace(/\.[^.]+$/, "");
  }
  function toEqLibraryEntry(item) {
    const rawPath = typeof item === "string" ? item : item && item.path;
    if (!rawPath || !isSupportedEqPresetFile(rawPath)) return null;
    const normalizedPath = normalizeEqLibraryPath(rawPath);
    const relativePath = normalizedPath.replace(/^\//, "");
    const name = getEqDisplayName(rawPath, typeof item && item === "object" ? item.name : "");
    const tags = Array.isArray(item && item.tags) ? item.tags.filter(Boolean) : [];
    const rawText = typeof item === "object" ? item.text ?? item.content ?? "" : "";
    const text = typeof rawText === "string" ? rawText : rawText && typeof rawText.value === "string" ? rawText.value : "";
    return {
      name,
      path: normalizedPath,
      relativePath,
      text,
      fileHandle: item && typeof item === "object" ? item.fileHandle || null : null,
      searchText: [name, relativePath, ...tags].join(" ").toLowerCase()
    };
  }
  function dedupeEqLibraryEntries(entries) {
    const seen = new Map();
    entries.forEach((entry) => {
      if (!entry || !entry.path || seen.has(entry.path)) return;
      seen.set(entry.path, entry);
    });
    return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }
  function toCurveLibraryEntry(item) {
    const rawPath = typeof item === "string" ? item : item && item.path;
    if (!rawPath || !isSupportedCurveFile(rawPath)) return null;
    const normalizedPath = normalizeCurveLibraryPath(rawPath);
    const relativePath = normalizedPath.replace(/^\//, "");
    const name = getCurveDisplayName(rawPath, typeof item === "object" ? item.name : "");
    const tags = Array.isArray(item && item.tags) ? item.tags.filter(Boolean) : [];
    const rawText = typeof item === "object" ? item.text ?? item.content ?? "" : "";
    const text = typeof rawText === "string" ? rawText : rawText && typeof rawText.value === "string" ? rawText.value : "";
    return {
      name,
      path: normalizedPath,
      relativePath,
      text,
      searchText: [name, relativePath, ...tags].join(" ").toLowerCase()
    };
  }
  function dedupeCurveLibraryEntries(entries) {
    const seen = new Map();
    entries.forEach((entry) => {
      if (!entry || !entry.path || seen.has(entry.path)) return;
      seen.set(entry.path, entry);
    });
    return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }

  async function loadCurveLibraryManifest(forceRefresh = false) {
    const url = `${CURVE_LIBRARY_MANIFEST}${forceRefresh ? `?t=${Date.now()}` : ""}`;
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`manifest ${response.status}`);
    const data = await response.json();
    const payload = Array.isArray(data) ? data : data.files || data.entries || [];
    const rawEntries = Array.isArray(payload) ? payload : [payload];
    return dedupeCurveLibraryEntries(rawEntries.map(toCurveLibraryEntry).filter(Boolean));
  }
  async function loadEqLibraryManifest(forceRefresh = false) {
    const url = `${EQ_LIBRARY_MANIFEST}${forceRefresh ? `?t=${Date.now()}` : ""}`;
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`manifest ${response.status}`);
    const data = await response.json();
    const payload = Array.isArray(data) ? data : data.files || data.entries || [];
    const rawEntries = Array.isArray(payload) ? payload : [payload];
    return dedupeEqLibraryEntries(rawEntries.map(toEqLibraryEntry).filter(Boolean));
  }
  async function loadCurveLibraryEmbeddedData(forceRefresh = false) {
    if (!forceRefresh && Array.isArray(window[CURVE_LIBRARY_GLOBAL_KEY]) && window[CURVE_LIBRARY_GLOBAL_KEY].length) {
      return dedupeCurveLibraryEntries(window[CURVE_LIBRARY_GLOBAL_KEY].map(toCurveLibraryEntry).filter(Boolean));
    }
    if (forceRefresh) {
      delete window[CURVE_LIBRARY_GLOBAL_KEY];
      curveLibraryScriptPromise = null;
      const existing = document.querySelector('script[data-curve-library-script="true"]');
      if (existing) existing.remove();
    }
    if (!curveLibraryScriptPromise) {
      curveLibraryScriptPromise = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = `${CURVE_LIBRARY_SCRIPT}?t=${Date.now()}`;
        script.async = true;
        script.dataset.curveLibraryScript = "true";
        script.addEventListener("load", () => {
          const payload = window[CURVE_LIBRARY_GLOBAL_KEY];
          if (!payload) {
            reject(new Error("embedded-data-missing"));
            return;
          }
          resolve(payload);
        }, { once: true });
        script.addEventListener("error", () => reject(new Error("embedded-data-load-failed")), { once: true });
        document.head.appendChild(script);
      });
    }
    const payload = await curveLibraryScriptPromise;
    const list = Array.isArray(payload) ? payload : [payload];
    return dedupeCurveLibraryEntries(list.map(toCurveLibraryEntry).filter(Boolean));
  }
  async function loadEqLibraryEmbeddedData(forceRefresh = false) {
    if (!forceRefresh && Array.isArray(window[EQ_LIBRARY_GLOBAL_KEY]) && window[EQ_LIBRARY_GLOBAL_KEY].length) {
      return dedupeEqLibraryEntries(window[EQ_LIBRARY_GLOBAL_KEY].map(toEqLibraryEntry).filter(Boolean));
    }
    if (forceRefresh) {
      delete window[EQ_LIBRARY_GLOBAL_KEY];
      eqLibraryScriptPromise = null;
      const existing = document.querySelector('script[data-eq-library-script="true"]');
      if (existing) existing.remove();
    }
    if (!eqLibraryScriptPromise) {
      eqLibraryScriptPromise = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = `${EQ_LIBRARY_SCRIPT}?t=${Date.now()}`;
        script.async = true;
        script.dataset.eqLibraryScript = "true";
        script.addEventListener("load", () => {
          const payload = window[EQ_LIBRARY_GLOBAL_KEY];
          if (!payload) {
            reject(new Error("embedded-data-missing"));
            return;
          }
          resolve(payload);
        }, { once: true });
        script.addEventListener("error", () => reject(new Error("embedded-data-load-failed")), { once: true });
        document.head.appendChild(script);
      });
    }
    const payload = await eqLibraryScriptPromise;
    const list = Array.isArray(payload) ? payload : [payload];
    return dedupeEqLibraryEntries(list.map(toEqLibraryEntry).filter(Boolean));
  }
  function parseCurveLibraryDirectoryIndex(htmlText) {
    const doc = new DOMParser().parseFromString(htmlText, "text/html");
    return dedupeCurveLibraryEntries(
      Array.from(doc.querySelectorAll("a[href]"))
        .map((a) => decodeURIComponent(a.getAttribute("href") || ""))
        .filter((href) => href && href !== "../" && href !== "./" && !href.startsWith("?") && isSupportedCurveFile(href))
        .map((href) => ({ path: href }))
        .map(toCurveLibraryEntry)
        .filter(Boolean)
    );
  }
  function parseEqLibraryDirectoryIndex(htmlText) {
    const doc = new DOMParser().parseFromString(htmlText, "text/html");
    return dedupeEqLibraryEntries(
      Array.from(doc.querySelectorAll("a[href]"))
        .map((a) => decodeURIComponent(a.getAttribute("href") || ""))
        .filter((href) => href && href !== "../" && href !== "./" && !href.startsWith("?") && isSupportedEqPresetFile(href))
        .map((href) => ({ path: href }))
        .map(toEqLibraryEntry)
        .filter(Boolean)
    );
  }
  async function loadCurveLibraryDirectoryIndex(forceRefresh = false) {
    const url = `${CURVE_LIBRARY_DIR}/${forceRefresh ? `?t=${Date.now()}` : ""}`;
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`index ${response.status}`);
    return parseCurveLibraryDirectoryIndex(await response.text());
  }
  async function loadEqLibraryDirectoryIndex(forceRefresh = false) {
    const url = `${EQ_LIBRARY_DIR}/${forceRefresh ? `?t=${Date.now()}` : ""}`;
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`index ${response.status}`);
    return parseEqLibraryDirectoryIndex(await response.text());
  }
  async function loadEqLibraryFromDirectoryHandle() {
    if (!state.eqLibraryDirectoryHandle || typeof state.eqLibraryDirectoryHandle.values !== "function") return [];
    const entries = [];
    for await (const handle of state.eqLibraryDirectoryHandle.values()) {
      if (!handle || handle.kind !== "file") continue;
      if (!isSupportedEqPresetFile(handle.name)) continue;
      entries.push(toEqLibraryEntry({ name: getEqDisplayName(handle.name, ""), path: handle.name, fileHandle: handle }));
    }
    return dedupeEqLibraryEntries(entries.filter(Boolean));
  }

  function refreshCurveLibraryOptions(searchTerm) {
    const keyword = String(searchTerm || state.curveLibrarySearch || "").trim().toLowerCase();
    const filtered = state.curveLibraryEntries.filter((e) => !keyword || e.searchText.includes(keyword));
    state.curveLibraryFilteredEntries = filtered;
    const previous = state.selectedCurveLibraryPath;
    if (!filtered.length) {
      state.selectedCurveLibraryPath = "";
      return;
    }
    const selectedPath = filtered.some((e) => e.path === previous) ? previous : "";
    state.selectedCurveLibraryPath = selectedPath;
  }
  function refreshEqLibraryOptions(searchTerm) {
    const keyword = String(searchTerm || state.eqLibrarySearch || "").trim().toLowerCase();
    const filtered = state.eqLibraryEntries.filter((e) => !keyword || e.searchText.includes(keyword));
    state.eqLibraryFilteredEntries = filtered;
    const previous = state.selectedEqLibraryPath;
    if (!filtered.length) {
      state.selectedEqLibraryPath = "";
      return;
    }
    const selectedPath = filtered.some((e) => e.path === previous) ? previous : filtered[0].path;
    state.selectedEqLibraryPath = selectedPath;
  }
  function getSelectedCurveLibraryEntry() {
    const selectedPath = state.selectedCurveLibraryPath;
    if (selectedPath) return state.curveLibraryEntries.find((e) => e.path === selectedPath) || null;
    return state.curveLibraryFilteredEntries[0] || state.curveLibraryEntries[0] || null;
  }
  function getSelectedEqLibraryEntry() {
    const selectedPath = state.selectedEqLibraryPath;
    if (selectedPath) return state.eqLibraryEntries.find((e) => e.path === selectedPath) || null;
    return state.eqLibraryFilteredEntries[0] || state.eqLibraryEntries[0] || null;
  }
  function getDefaultEqPresetName() {
    const curveEntry = getSelectedCurveLibraryEntry();
    const baseName = String(curveEntry?.name || state.importedFileName || "我的EQ").trim() || "我的EQ";
    return `${baseName}（）`;
  }
  function syncEqLibrarySearchFromCurve(entry) {
    if (!entry) return;
    const sourceName = entry.name || getCurveDisplayName(entry.relativePath || entry.path || "", "");
    state.eqLibrarySearch = Array.from(String(sourceName || "").trim()).slice(0, 3).join("");
    refreshEqLibraryOptions(state.eqLibrarySearch);
  }
  function tryImportSingleCurveSelection() {
    if (state.curveLibraryFilteredEntries.length !== 1) return;
    const only = state.curveLibraryFilteredEntries[0];
    if (!only || !only.path) return;
    state.selectedCurveLibraryPath = only.path;
    importSelectedCurveLibraryEntry();
  }
  function tryImportSingleEqSelection() {
    if (state.eqLibraryFilteredEntries.length !== 1) return;
    const only = state.eqLibraryFilteredEntries[0];
    if (!only || !only.path) return;
    state.selectedEqLibraryPath = only.path;
    importSelectedEqLibraryEntry();
  }
  async function importSelectedCurveLibraryEntry() {
    const entry = getSelectedCurveLibraryEntry();
    if (!entry) {
      setImportStatus("当前没有可导入的曲线。", "error");
      return;
    }
    syncEqLibrarySearchFromCurve(entry);
    try {
      const text = entry.text
        ? entry.text
        : await (async () => {
            const response = await fetch(`${entry.path}?t=${Date.now()}`, { cache: "no-store" });
            if (!response.ok) throw new Error(`读取失败：${response.status}`);
            return response.text();
          })();
      importCurveFromText(text, entry.name);
      drawPlot();
    } catch (error) {
      setImportStatus(`导入失败：${error.message}`, "error");
    }
  }
  async function importSelectedEqLibraryEntry() {
    const entry = getSelectedEqLibraryEntry();
    if (!entry) {
      setEqLibraryStatus("当前没有可导入的 EQ 预设。", "error");
      return;
    }
    try {
      const text = entry.text
        ? entry.text
        : await (async () => {
            if (entry.fileHandle && typeof entry.fileHandle.getFile === "function") {
              return (await entry.fileHandle.getFile()).text();
            }
            const response = await fetch(`${entry.path}?t=${Date.now()}`, { cache: "no-store" });
            if (!response.ok) throw new Error(`读取失败：${response.status}`);
            return response.text();
          })();
      const payload = parseEqPresetText(text, entry.name);
      applyEqPresetPayload(payload, entry.name);
    } catch (error) {
      setEqLibraryStatus(`载入失败：${error.message}`, "error");
    }
  }
  async function fetchApiList(kind) {
    const response = await fetch(`/api/${kind}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`api ${response.status}`);
    const payload = await response.json();
    return Array.isArray(payload) ? payload : [];
  }
  async function loadCurveLibraryFromApi() {
    const list = await fetchApiList("curves");
    return dedupeCurveLibraryEntries(list.map(toCurveLibraryEntry).filter(Boolean));
  }
  async function loadEqLibraryFromApi() {
    const list = await fetchApiList("presets");
    return dedupeEqLibraryEntries(list.map(toEqLibraryEntry).filter(Boolean));
  }

  async function loadCurveLibrary(forceRefresh = false) {
    setCurveLibraryStatus("正在读取曲线库...", "");
    let entries = [];
    const errors = [];
    try {
      entries = await loadCurveLibraryFromApi();
    } catch (e) {
      errors.push(`api: ${e.message}`);
    }
    try {
      if (!entries.length) entries = await loadCurveLibraryEmbeddedData(forceRefresh);
    } catch (e) {
      errors.push(`embedded: ${e.message}`);
    }
    try {
      if (!entries.length) entries = await loadCurveLibraryManifest(forceRefresh);
    } catch (e) {
      errors.push(`manifest: ${e.message}`);
    }
    try {
      if (!entries.length) entries = await loadCurveLibraryDirectoryIndex(forceRefresh);
    } catch (e) {
      errors.push(`index: ${e.message}`);
    }
    state.curveLibraryEntries = entries;
    refreshCurveLibraryOptions(state.curveLibrarySearch);
    if (entries.length) {
      setCurveLibraryStatus(`已加载 ${entries.length} 条曲线，可搜索后直接导入。`, "ok");
      return;
    }
    const fallback = location.protocol === "file:"
      ? "未读取到曲线库。建议通过 localhost 打开页面，或更新 曲线库/manifest.json。"
      : "未读取到曲线库，请检查 曲线库 目录或 manifest.json。";
    setCurveLibraryStatus(errors.length ? `${fallback} (${errors.join(" | ")})` : fallback, "error");
  }
  async function loadEqLibrary(forceRefresh = false) {
    setEqLibraryStatus("正在读取 EQ 库...", "");
    let entries = [];
    const errors = [];
    try {
      if (state.eqLibraryDirectoryHandle) entries = await loadEqLibraryFromDirectoryHandle();
    } catch (e) {
      errors.push(`handle: ${e.message}`);
    }
    try {
      if (!entries.length) entries = await loadEqLibraryFromApi();
    } catch (e) {
      errors.push(`api: ${e.message}`);
    }
    try {
      if (!entries.length) entries = await loadEqLibraryEmbeddedData(forceRefresh);
    } catch (e) {
      errors.push(`embedded: ${e.message}`);
    }
    try {
      if (!entries.length) entries = await loadEqLibraryManifest(forceRefresh);
    } catch (e) {
      errors.push(`manifest: ${e.message}`);
    }
    try {
      if (!entries.length) entries = await loadEqLibraryDirectoryIndex(forceRefresh);
    } catch (e) {
      errors.push(`index: ${e.message}`);
    }
    state.eqLibraryEntries = entries;
    refreshEqLibraryOptions(state.eqLibrarySearch);
    if (entries.length) {
      setEqLibraryStatus(`已加载 ${entries.length} 条 EQ 预设，可搜索后直接调用。`, "ok");
      return;
    }
    const fallback = location.protocol === "file:"
      ? "未读取到 EQ 库。建议通过 localhost 打开页面，或更新 eq库/manifest.json。"
      : "未读取到 EQ 库，请检查 eq库 目录或 manifest.json。";
    setEqLibraryStatus(errors.length ? `${fallback} (${errors.join(" | ")})` : fallback, "error");
  }
  function applyRefFreq() {
    if (!state.importedRaw) return;
    const refFreq = clamp(Number(state.refFreq) || 1000, 20, 20000);
    state.importedNormalized = normalizeResponse(state.importedRaw, refFreq);
    setImportStatus(`已按 ${Math.round(refFreq)} Hz 重新归一化到 0 dB。`, "ok");
    drawPlot();
  }
  function clearImportedCurve() {
    state.importedRaw = null;
    state.importedNormalized = null;
    state.importedFileName = "";
    setImportStatus("还没有导入频响曲线。");
    drawPlot();
  }

  /* ---------- 图例开关 ---------- */
  function toggleZeroBaseline() {
    state.showZeroBaseline = !state.showZeroBaseline;
    drawPlot();
  }
  function toggleTotalTrace() {
    state.showTotalEqTrace = !state.showTotalEqTrace;
    drawPlot();
  }
  function toggleImportedRaw() {
    state.showImportedRawTrace = !state.showImportedRawTrace;
    drawPlot();
  }
  function toggleImportedEq() {
    state.showImportedEqTrace = !state.showImportedEqTrace;
    drawPlot();
  }
  function toggleFilterTrace(index) {
    const filter = state.filters[index];
    if (!filter) return;
    filter.showTrace = filter.showTrace === false;
    refreshIndividualsToggleFromFilters();
    drawPlot();
  }

  /* ============================================================
   * 画布绘制
   * ============================================================ */
  function resizeCanvas() {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(640, Math.round(rect.width * dpr));
    const height = Math.max(560, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }
  function getYBounds(traces, forcedMinDb) {
    let min = Infinity;
    let max = -Infinity;
    traces.forEach((trace) => {
      trace.points.forEach(([, value]) => {
        if (Number.isFinite(value)) {
          min = Math.min(min, value);
          max = Math.max(max, value);
        }
      });
    });
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      const fallback = Number.isFinite(forcedMinDb) ? forcedMinDb : -18;
      return [fallback, fallback + 24];
    }
    const paddedMin = Number.isFinite(forcedMinDb) ? forcedMinDb : Math.floor((min - 2) / 3) * 3;
    const paddedMax = Math.ceil((max + 2) / 3) * 3;
    if (paddedMin >= paddedMax) return [paddedMin, paddedMin + 12];
    return [paddedMin, paddedMax];
  }
  function getReferenceLowerBound(importedEq, totalTrace, preamp) {
    const getTraceMin = (points) => {
      if (!points || !points.length) return null;
      let minValue = Infinity;
      points.forEach(([freq, value]) => {
        if (freq >= 100 && freq <= 15000 && Number.isFinite(value)) minValue = Math.min(minValue, value);
      });
      return Number.isFinite(minValue) ? minValue : null;
    };
    if (importedEq && importedEq.length) {
      const m = getTraceMin(importedEq);
      if (Number.isFinite(m)) return m - 6;
    }
    if (totalTrace && totalTrace.length) {
      const m = getTraceMin(totalTrace);
      if (Number.isFinite(m)) return m + preamp - 6;
    }
    return -6;
  }
  function buildDbTicks(minDb, maxDb) {
    const step = 3;
    const ticks = [];
    for (let value = Math.ceil(minDb / step) * step; value <= maxDb; value += step) ticks.push(value);
    if (!ticks.includes(0) && minDb < 0 && maxDb > 0) {
      ticks.push(0);
      ticks.sort((a, b) => a - b);
    }
    return ticks;
  }
  function drawEqFrequencyMarkers(ctx, markers, totalTrace, xAt, yAt, plotBounds) {
    if (!markers.length || !totalTrace.length) return [];
    const dpr = window.devicePixelRatio || 1;
    const badgeY = plotBounds.padTop + 14 * dpr;
    const lineTop = plotBounds.padTop + 28 * dpr;
    const lineBottom = plotBounds.padTop + plotBounds.plotHeight;
    const interactive = [];
    markers.forEach(({ filter, index }) => {
      const color = FILTER_COLORS[index % FILTER_COLORS.length];
      const x = xAt(clamp(filter.freq, 20, 20000));
      const db = interpolateAt(totalTrace, filter.freq);
      const y = yAt(db);
      const qY = qToHandleY(filter.q, y, lineBottom);
      const isActive = plotInteraction.draggingFilterId === filter.id;
      const badgeRadius = (isActive && plotInteraction.dragMode === "freq" ? 11.5 : 10) * dpr;
      const pointRadius = (isActive && plotInteraction.dragMode === "gain" ? 5.5 : 4.5) * dpr;
      const qPointRadius = (isActive && plotInteraction.dragMode === "q" ? 5.5 : 4.5) * dpr;
      ctx.save();
      ctx.strokeStyle = isActive && plotInteraction.dragMode === "freq" ? color : `${color}88`;
      ctx.lineWidth = (isActive && plotInteraction.dragMode === "freq" ? 1.8 : 1.2) * dpr;
      ctx.setLineDash([4 * dpr, 5 * dpr]);
      ctx.beginPath();
      ctx.moveTo(x, lineTop);
      ctx.lineTo(x, lineBottom);
      ctx.stroke();
      ctx.restore();
      ctx.save();
      ctx.fillStyle = color;
      ctx.strokeStyle = "#eef4ff";
      ctx.lineWidth = 1.6 * dpr;
      ctx.beginPath();
      ctx.arc(x, y, pointRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      ctx.save();
      ctx.strokeStyle = `${color}55`;
      ctx.lineWidth = 1.2 * dpr;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, qY);
      ctx.stroke();
      ctx.restore();
      ctx.save();
      ctx.fillStyle = color;
      ctx.strokeStyle = "#eef4ff";
      ctx.lineWidth = 1.6 * dpr;
      ctx.beginPath();
      ctx.arc(x, qY, qPointRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      ctx.save();
      ctx.fillStyle = color;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.88)";
      ctx.lineWidth = 1.2 * dpr;
      ctx.beginPath();
      ctx.arc(x, badgeY, badgeRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#10141c";
      ctx.font = `${11 * dpr}px Tahoma`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`${index + 1}`, x, badgeY + 0.5 * dpr);
      ctx.restore();
      interactive.push({
        filterId: filter.id,
        x,
        y,
        qY,
        badgeY,
        badgeRadius,
        pointRadius,
        qPointRadius,
        lineTop,
        lineBottom,
        hitPadding: 8 * dpr
      });
    });
    return interactive;
  }
  function drawPlotWatermark(ctx, plotBounds) {
    const dpr = window.devicePixelRatio || 1;
    const text = "鸽子耳机";
    const stepX = 220 * dpr;
    const stepY = 170 * dpr;
    const startX = plotBounds.padLeft - 140 * dpr;
    const endX = plotBounds.padLeft + plotBounds.plotWidth + 140 * dpr;
    const startY = plotBounds.padTop - 90 * dpr;
    const endY = plotBounds.padTop + plotBounds.plotHeight + 90 * dpr;
    ctx.save();
    ctx.fillStyle = "rgba(218, 226, 240, 0.08)";
    ctx.font = `700 ${24 * dpr}px "Segoe UI", Tahoma, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    let rowIndex = 0;
    for (let y = startY; y <= endY; y += stepY, rowIndex += 1) {
      const rowOffset = rowIndex % 2 === 0 ? 0 : stepX / 2;
      for (let x = startX + rowOffset; x <= endX; x += stepX) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(-Math.PI / 4);
        ctx.fillText(text, 0, 0);
        ctx.restore();
      }
    }
    ctx.restore();
  }

  function qToHandleOffsetRange(mainY, lineBottom) {
    const dpr = window.devicePixelRatio || 1;
    const minOffset = 26 * dpr;
    const maxOffset = Math.max(minOffset, Math.min(96 * dpr, lineBottom - mainY - 8 * dpr));
    return { minOffset, maxOffset };
  }
  function qToNormalizedRatio(q) {
    const minLog = Math.log(MIN_FILTER_Q);
    const maxLog = Math.log(MAX_FILTER_Q);
    const qLog = Math.log(clamp(q, MIN_FILTER_Q, MAX_FILTER_Q));
    return (qLog - minLog) / (maxLog - minLog || 1);
  }
  function normalizedRatioToQ(ratio) {
    const minLog = Math.log(MIN_FILTER_Q);
    const maxLog = Math.log(MAX_FILTER_Q);
    const qLog = minLog + clamp(ratio, 0, 1) * (maxLog - minLog);
    return Math.exp(qLog);
  }
  function qToHandleOffset(q, minOffset, maxOffset) {
    const ratio = qToNormalizedRatio(q);
    return maxOffset - ratio * (maxOffset - minOffset);
  }
  function handleOffsetToQ(offset, minOffset, maxOffset) {
    const ratio = 1 - (offset - minOffset) / (maxOffset - minOffset || 1);
    return clamp(roundToStep(normalizedRatioToQ(ratio), FILTER_Q_STEP), MIN_FILTER_Q, MAX_FILTER_Q);
  }
  function qToHandleY(q, mainY, lineBottom) {
    const { minOffset, maxOffset } = qToHandleOffsetRange(mainY, lineBottom);
    return mainY + qToHandleOffset(q, minOffset, maxOffset);
  }
  function handleYToQ(handleY, mainY, lineBottom) {
    const { minOffset, maxOffset } = qToHandleOffsetRange(mainY, lineBottom);
    const offset = clamp(handleY - mainY, minOffset, maxOffset);
    return handleOffsetToQ(offset, minOffset, maxOffset);
  }

  function getCanvasPointerPosition(event) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / (rect.width || 1);
    const scaleY = canvas.height / (rect.height || 1);
    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY
    };
  }
  function getInteractiveMarkerAt(point) {
    let bestMarker = null;
    let bestScore = Infinity;
    plotInteraction.markers.forEach((marker) => {
      const badgeDistance = Math.hypot(point.x - marker.x, point.y - marker.badgeY);
      const pointDistance = Math.hypot(point.x - marker.x, point.y - marker.y);
      const qPointDistance = Math.hypot(point.x - marker.x, point.y - marker.qY);
      const lineDistance = Math.abs(point.x - marker.x);
      const withinLineY = point.y >= marker.lineTop - marker.hitPadding && point.y <= marker.lineBottom + marker.hitPadding;
      [
        { mode: "freq", score: badgeDistance <= marker.badgeRadius + marker.hitPadding ? badgeDistance : Infinity },
        { mode: "gain", score: pointDistance <= marker.pointRadius + marker.hitPadding ? pointDistance + marker.hitPadding : Infinity },
        { mode: "q", score: qPointDistance <= marker.qPointRadius + marker.hitPadding ? qPointDistance + marker.hitPadding : Infinity },
        { mode: "freq", score: withinLineY && lineDistance <= marker.hitPadding ? lineDistance + marker.hitPadding * 2 : Infinity }
      ].forEach((candidate) => {
        if (candidate.score < bestScore) {
          bestScore = candidate.score;
          bestMarker = { ...marker, mode: candidate.mode };
        }
      });
    });
    return bestMarker;
  }
  function updatePlotCursor(mode) {
    if (!canvas) return;
    if (mode === "freq") canvas.style.cursor = "ew-resize";
    else if (mode === "gain" || mode === "q") canvas.style.cursor = "ns-resize";
    else canvas.style.cursor = "default";
  }
  function getActivePlotLayout() {
    return plotInteraction.dragSnapshot && plotInteraction.dragSnapshot.layout
      ? plotInteraction.dragSnapshot.layout
      : plotInteraction.layout;
  }
  function beginPlotDragging(filter, mode, point) {
    const layout = plotInteraction.layout ? { ...plotInteraction.layout } : null;
    if (!layout) {
      plotInteraction.dragSnapshot = null;
      return;
    }
    const snapshot = {
      layout,
      startPointerX: 0,
      startPointerY: point.y,
      startFreq: filter.freq,
      startGain: filter.gain,
      startQ: filter.q
    };
    if (mode === "q") {
      const totalTrace = getTotalTrace(state.filters);
      const currentDb = interpolateAt(totalTrace, filter.freq);
      const mainY = dbToY(currentDb, layout.minDb, layout.maxDb, layout.padTop, layout.plotHeight);
      const lineBottom = layout.padTop + layout.plotHeight;
      const { minOffset, maxOffset } = qToHandleOffsetRange(mainY, lineBottom);
      snapshot.qMainY = mainY;
      snapshot.qLineBottom = lineBottom;
      snapshot.qMinOffset = minOffset;
      snapshot.qMaxOffset = maxOffset;
      snapshot.qStartOffset = qToHandleOffset(filter.q, minOffset, maxOffset);
    }
    plotInteraction.dragSnapshot = snapshot;
    plotInteraction.needsFilterUiRefresh = false;
  }
  function updatePlotDuringDrag() {
    plotInteraction.needsFilterUiRefresh = true;
    drawPlot();
  }
  function syncDraggedFilterFrequency(canvasX) {
    const layout = getActivePlotLayout();
    if (!plotInteraction.draggingFilterId || !layout) return;
    const filter = state.filters.find((f) => f.id === plotInteraction.draggingFilterId);
    if (!filter) return;
    const nextFreq = Math.round(xToFreq(canvasX, layout.minFreq, layout.maxFreq, layout.padLeft, layout.plotWidth));
    const normalized = clamp(nextFreq, 20, 20000);
    if (normalized === filter.freq) return;
    filter.freq = normalized;
    updatePlotDuringDrag();
    updatePlotCursor("freq");
  }
  function syncDraggedFilterGain(canvasY) {
    const layout = getActivePlotLayout();
    const snapshot = plotInteraction.dragSnapshot;
    if (!plotInteraction.draggingFilterId || !layout || !snapshot) return;
    const filter = state.filters.find((f) => f.id === plotInteraction.draggingFilterId);
    if (!filter) return;
    const dragDeltaY = canvasY - snapshot.startPointerY;
    const dbRange = layout.maxDb - layout.minDb || 1;
    const targetDb = snapshot.startGain - (dragDeltaY / (layout.plotHeight || 1)) * dbRange;
    const nextGain = clamp(roundToStep(targetDb, 0.2), -10, 10);
    if (nextGain === filter.gain) return;
    filter.gain = nextGain;
    updatePlotDuringDrag();
    updatePlotCursor("gain");
  }
  function syncDraggedFilterQ(canvasY) {
    const snapshot = plotInteraction.dragSnapshot;
    if (!plotInteraction.draggingFilterId || !snapshot) return;
    const filter = state.filters.find((f) => f.id === plotInteraction.draggingFilterId);
    if (!filter) return;
    const dragDeltaY = canvasY - snapshot.startPointerY;
    const nextOffset = clamp(snapshot.qStartOffset + dragDeltaY, snapshot.qMinOffset, snapshot.qMaxOffset);
    const nextQ = handleOffsetToQ(nextOffset, snapshot.qMinOffset, snapshot.qMaxOffset);
    if (nextQ === filter.q) return;
    filter.q = nextQ;
    updatePlotDuringDrag();
    updatePlotCursor("q");
  }
  function stopPlotDragging(event) {
    if (event && plotInteraction.activePointerId !== null && event.pointerId !== undefined && event.pointerId !== plotInteraction.activePointerId) return;
    if (plotInteraction.activePointerId !== null && canvas.hasPointerCapture && canvas.hasPointerCapture(plotInteraction.activePointerId)) {
      canvas.releasePointerCapture(plotInteraction.activePointerId);
    }
    plotInteraction.activePointerId = null;
    plotInteraction.draggingFilterId = null;
    plotInteraction.dragMode = null;
    plotInteraction.dragSnapshot = null;
    if (plotInteraction.needsFilterUiRefresh) {
      plotInteraction.needsFilterUiRefresh = false;
      renderFilterUiAndPlot();
    }
    if (event && event.type !== "pointerleave") {
      const marker = getInteractiveMarkerAt(getCanvasPointerPosition(event));
      updatePlotCursor(marker ? marker.mode : null);
      return;
    }
    updatePlotCursor(null);
  }
  function initPlotInteractions() {
    canvas.addEventListener("pointerdown", (event) => {
      const hit = getInteractiveMarkerAt(getCanvasPointerPosition(event));
      if (!hit) return;
      event.preventDefault();
      plotInteraction.activePointerId = event.pointerId;
      plotInteraction.draggingFilterId = hit.filterId;
      plotInteraction.dragMode = hit.mode;
      canvas.setPointerCapture(event.pointerId);
      const point = getCanvasPointerPosition(event);
      const filter = state.filters.find((f) => f.id === hit.filterId);
      if (!filter) {
        stopPlotDragging(event);
        return;
      }
      beginPlotDragging(filter, hit.mode, point);
      if (hit.mode === "gain") syncDraggedFilterGain(point.y);
      else if (hit.mode === "q") syncDraggedFilterQ(point.y);
      else syncDraggedFilterFrequency(point.x);
      updatePlotCursor(hit.mode);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (plotInteraction.activePointerId !== null && event.pointerId === plotInteraction.activePointerId) {
        event.preventDefault();
        const point = getCanvasPointerPosition(event);
        if (plotInteraction.dragMode === "gain") syncDraggedFilterGain(point.y);
        else if (plotInteraction.dragMode === "q") syncDraggedFilterQ(point.y);
        else syncDraggedFilterFrequency(point.x);
        return;
      }
      const marker = getInteractiveMarkerAt(getCanvasPointerPosition(event));
      updatePlotCursor(marker ? marker.mode : null);
    });
    canvas.addEventListener("pointerup", stopPlotDragging);
    canvas.addEventListener("pointercancel", stopPlotDragging);
    canvas.addEventListener("lostpointercapture", stopPlotDragging);
    canvas.addEventListener("pointerleave", () => {
      if (plotInteraction.activePointerId === null) updatePlotCursor(null);
    });
  }

  function drawPlot() {
    if (!canvas) return;
    resizeCanvas();
    const traces = [];
    const totalTrace = getTotalTrace(state.filters);
    state.filters.forEach((filter, index) => {
      if (!filter.enabled) return;
      if (filter.showTrace === false) return;
      traces.push({
        label: `${index + 1}`,
        color: FILTER_COLORS[index % FILTER_COLORS.length],
        width: 1.6,
        dash: [6, 5],
        points: getFilterTrace(filter)
      });
    });
    if (state.showTotalEqTrace) {
      traces.push({ label: "总 EQ 响应", color: "#55a6ff", width: 2.8, dash: [], points: totalTrace });
    }
    let importedEq = null;
    if (state.importedNormalized) {
      if (state.showImportedRawTrace) {
        traces.push({ label: "原始曲线", color: "#c0c7d4", width: 5, dash: [], points: state.importedNormalized });
      }
      importedEq = applyEqToResponse(state.importedNormalized, state.filters, state.preamp);
      if (state.showImportedEqTrace) {
        traces.push({ label: "EQ 后 FR (含 Preamp)", color: "#ff6d6d", width: 1.5, dash: [], points: importedEq });
      }
    }
    const ctx = canvas.getContext("2d");
    const width = canvas.width;
    const height = canvas.height;
    const padLeft = 64;
    const padRight = 22;
    const padTop = 18;
    const padBottom = 34;
    const plotWidth = width - padLeft - padRight;
    const plotHeight = height - padTop - padBottom;
    const minFreq = 20;
    const maxFreq = 20000;
    const freqTicks = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    const frozenLayout = plotInteraction.dragSnapshot && plotInteraction.dragSnapshot.layout;
    const lowerBound = getReferenceLowerBound(importedEq, totalTrace, state.preamp);
    const [minDb, maxDb] = frozenLayout ? [frozenLayout.minDb, frozenLayout.maxDb] : getYBounds(traces, lowerBound);
    const dbTicks = buildDbTicks(minDb, maxDb);
    plotInteraction.layout = { padLeft, padTop, plotWidth, plotHeight, minFreq, maxFreq, minDb, maxDb };
    const xAt = (freq) => {
      const ratio = Math.log(freq / minFreq) / Math.log(maxFreq / minFreq);
      return padLeft + ratio * plotWidth;
    };
    const yAt = (db) => {
      const ratio = (db - minDb) / (maxDb - minDb);
      return padTop + plotHeight - ratio * plotHeight;
    };
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#131822";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "#2a3245";
    ctx.lineWidth = 1;
    ctx.font = `${12 * (window.devicePixelRatio || 1)}px "Segoe UI", Tahoma, sans-serif`;
    ctx.fillStyle = "#aeb8d0";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    freqTicks.forEach((freq) => {
      const x = xAt(freq);
      ctx.beginPath();
      ctx.moveTo(x, padTop);
      ctx.lineTo(x, padTop + plotHeight);
      ctx.stroke();
      ctx.fillText(freq >= 1000 ? `${freq / 1000}k` : `${freq}`, x, padTop + plotHeight + 6);
    });
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    dbTicks.forEach((db) => {
      if (db === 0 && !state.showZeroBaseline) return;
      const y = yAt(db);
      ctx.strokeStyle = db === 0 ? "#6db4ff" : "#2a3245";
      ctx.lineWidth = db === 0 ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + plotWidth, y);
      ctx.stroke();
      ctx.fillText(`${db > 0 ? "+" : ""}${db}`, padLeft - 8, y);
    });
    ctx.strokeStyle = "#4a5468";
    ctx.lineWidth = 1.2;
    ctx.strokeRect(padLeft, padTop, plotWidth, plotHeight);
    ctx.save();
    ctx.beginPath();
    ctx.rect(padLeft, padTop, plotWidth, plotHeight);
    ctx.clip();
    drawPlotWatermark(ctx, { padLeft, padTop, plotWidth, plotHeight });
    traces.forEach((trace) => {
      ctx.save();
      ctx.strokeStyle = trace.color;
      ctx.lineWidth = trace.width * (window.devicePixelRatio || 1);
      ctx.setLineDash(trace.dash.map((v) => v * (window.devicePixelRatio || 1)));
      ctx.beginPath();
      trace.points.forEach(([freq, db], index) => {
        const x = xAt(clamp(freq, minFreq, maxFreq));
        const y = yAt(db);
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.restore();
    });
    plotInteraction.markers = drawEqFrequencyMarkers(
      ctx,
      state.filters.map((filter, index) => ({ filter, index })).filter(({ filter }) => filter.enabled),
      totalTrace,
      xAt,
      yAt,
      { padTop, plotHeight }
    );
    ctx.restore();
    ctx.save();
    ctx.fillStyle = "#c8d2e8";
    ctx.translate(16, padTop + plotHeight / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("增益 / 相对频响 (dB)", 0, 0);
    ctx.restore();
    notifyExtensionFiltersUpdated();
  }

  function renderFilterUiAndPlot() {
    drawPlot();
  }
  function renderAll() {
    refreshIndividualsToggleFromFilters();
    drawPlot();
  }

  /* ============================================================
   * 初始化 & 画布绑定
   * ============================================================ */
  function attachCanvas(canvasEl) {
    canvas = canvasEl;
    initPlotInteractions();
    drawPlot();
  }
  function init() {
    refreshIndividualsToggleFromFilters();
    state.filters = createDefaultFilters();
    refreshCurveLibraryOptions("");
    refreshEqLibraryOptions("");
    setImportStatus("还没有导入频响曲线。");
    setEqLibraryStatus("还没有保存或打开 EQ 文件。");
    setCurveLibraryStatus("正在读取曲线库...");
    loadCurveLibrary();
    loadEqLibrary();
    initDevicePeqIntegration();
    attachWalkplayKt1213Bridge();
  }

  return {
    state,
    math,
    /* 滤波器 */
    addFilter,
    removeFilter,
    resetFilter,
    toggleFilterEnabled,
    updateFilterFreq,
    updateFilter: updateFilterFreq,
    updateFilterQ,
    updateFilterGain,
    setShowIndividuals,
    setPreamp,
    autoPreamp,
    resetAll,
    /* 曲线库 */
    loadCurveLibrary,
    refreshCurveLibraryOptions,
    importSelectedCurveLibraryEntry,
    tryImportSingleCurveSelection,
    applyRefFreq,
    clearImportedCurve,
    registerOpenEqFileInput,
    handleOpenEqFileInputChange,
    /* EQ 库 */
    loadEqLibrary,
    refreshEqLibraryOptions,
    importSelectedEqLibraryEntry,
    tryImportSingleEqSelection,
    saveCurrentEqPreset,
    openEqPresetFile,
    /* 图例 */
    toggleZeroBaseline,
    toggleTotalTrace,
    toggleImportedRaw,
    toggleImportedEq,
    toggleFilterTrace,
    /* 画布 */
    attachCanvas,
    drawPlot,
    init
  };
}
