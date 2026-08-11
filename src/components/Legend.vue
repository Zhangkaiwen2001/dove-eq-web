<script setup>
import { computed, inject } from "vue";

const engine = inject("engine");
const state = engine.state;

const items = computed(() => {
  const list = [
    {
      key: "zero",
      label: "0 dB 基线",
      color: "#9faec0",
      active: state.showZeroBaseline,
      toggle: () => engine.toggleZeroBaseline()
    },
    {
      key: "total",
      label: "总 EQ 响应",
      color: "#55a6ff",
      active: state.showTotalEqTrace,
      toggle: () => engine.toggleTotalTrace()
    }
  ];
  if (state.importedNormalized) {
    list.push({
      key: "raw",
      label: "原始曲线",
      color: "#c0c7d4",
      active: state.showImportedRawTrace,
      toggle: () => engine.toggleImportedRaw()
    });
  }
  const importedEq = state.showImportedEqTrace && state.importedNormalized;
  if (importedEq) {
    list.push({
      key: "eq",
      label: "EQ 后 FR",
      color: "#ff6d6d",
      active: state.showImportedEqTrace,
      toggle: () => engine.toggleImportedEq()
    });
  }
  state.filters.forEach((filter, index) => {
    if (!filter || !filter.id) return;
    list.push({
      key: `f${filter.id}`,
      label: `${index + 1}`,
      colorIndex: index,
      active: filter.showTrace !== false,
      filter,
      toggle: () => engine.toggleFilterTrace(index)
    });
  });
  return list;
});

const FILTER_COLORS = ["#4ca1ff", "#ff7ab6", "#7ee081", "#ffcf5c", "#b58cff", "#5ce0d8", "#ff8a5c", "#9aa6ff"];
function colorFor(item) {
  return item.color || FILTER_COLORS[(item.colorIndex || 0) % FILTER_COLORS.length];
}
</script>

<template>
  <div class="legend">
    <div
      v-for="item in items"
      :key="item.key"
      class="legend-item is-toggle"
      :class="{ 'is-off': !item.active }"
      :style="{ '--legend-color': colorFor(item) }"
      :title="item.active ? `隐藏 ${item.label}` : `显示 ${item.label}`"
      @click="item.toggle()"
    >
      <span class="legend-swatch" :style="{ background: colorFor(item), borderColor: colorFor(item) }"></span>
      <span>{{ item.label }}</span>
    </div>
  </div>
</template>
