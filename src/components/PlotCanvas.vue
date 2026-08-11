<script setup>
import { ref, inject, onMounted, onBeforeUnmount, watch } from "vue";
import Legend from "./Legend.vue";

const engine = inject("engine");
const canvasRef = ref(null);
let observer = null;

onMounted(() => {
  engine.attachCanvas(canvasRef.value);
  observer = new ResizeObserver(() => engine.drawPlot());
  observer.observe(canvasRef.value);
  // 任意状态变化都重绘（滤波器参数 / 曲线 / 开关等）
  watch(
    () => engine.state,
    () => engine.drawPlot(),
    { deep: true }
  );
});

onBeforeUnmount(() => {
  if (observer && canvasRef.value) observer.disconnect();
});
</script>

<template>
  <div class="plot-wrap">
    <canvas ref="canvasRef" class="plot-canvas" width="1400" height="860" style="touch-action: none"></canvas>
    <div class="plot-footer">
      <Legend />
      <div class="plot-axis-label">频响曲线 · 单位：赫兹</div>
    </div>
  </div>
</template>
