import { createApp } from "vue";
import App from "./App.vue";
import "./styles/main.css";

const app = createApp(App);

// 可见错误浮层：任何运行时错误都直接显示在页面上，避免白屏
function showErrorOverlay(err) {
  const existing = document.getElementById("__error_overlay__");
  if (existing) return;
  const box = document.createElement("div");
  box.id = "__error_overlay__";
  box.style.cssText =
    "position:fixed;inset:12px;z-index:99999;background:rgba(20,12,16,0.96);color:#ffd9d9;" +
    "border:1px solid #ff6b6b;border-radius:12px;padding:18px 20px;font:13px/1.6 monospace;" +
    "overflow:auto;white-space:pre-wrap;box-shadow:0 20px 60px rgba(0,0,0,.5)";
  box.textContent = "⚠️ 应用运行时错误：\n\n" + (err && err.stack ? err.stack : String(err));
  document.body.appendChild(box);
}

app.config.errorHandler = (err) => showErrorOverlay(err);
window.addEventListener("error", (e) => showErrorOverlay(e.error || e.message));
window.addEventListener("unhandledrejection", (e) => showErrorOverlay(e.reason));

app.mount("#app");
