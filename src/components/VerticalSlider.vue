<script setup>
import { computed } from "vue";
import { math } from "../engine/eqEngine.js";

const props = defineProps({
  modelValue: { type: Number, required: true },
  min: { type: Number, default: -30 },
  max: { type: Number, default: 10 },
  step: { type: Number, default: 0.2 },
  digits: { type: Number, default: 1 },
  suffix: { type: String, default: " dB" },
  tickValues: { type: Array, default: () => [10, 0, -10, -20, -30] },
  withNumberInput: { type: Boolean, default: true }
});
const emit = defineEmits(["update:modelValue"]);

const display = computed(() => `${props.modelValue > 0 ? "+" : ""}${props.modelValue.toFixed(props.digits)}${props.suffix}`);

function onSlider(e) {
  const raw = Number(e.target.value);
  if (!Number.isFinite(raw)) return;
  emit("update:modelValue", math.roundToStep(math.clamp(raw, props.min, props.max), props.step));
}
function onNumber(e) {
  const raw = Number(e.target.value);
  if (!Number.isFinite(raw)) return;
  emit("update:modelValue", math.roundToStep(math.clamp(raw, props.min, props.max), props.step));
}
</script>

<template>
  <div class="vertical-control">
    <div class="vertical-value">{{ display }}</div>
    <div class="vertical-slider-shell">
      <div class="vertical-slider-track"></div>
      <input
        class="vertical-slider range-input"
        type="range"
        :min="min"
        :max="max"
        :step="step"
        :value="modelValue"
        @input="onSlider"
      />
      <div class="vertical-scale">
        <span v-for="(tick, i) in tickValues" :key="i">{{ tick > 0 ? "+" : "" }}{{ tick }}</span>
      </div>
    </div>
    <input
      v-if="withNumberInput"
      class="vertical-number"
      type="number"
      :min="min"
      :max="max"
      :step="step"
      :value="modelValue.toFixed(digits)"
      @input="onNumber"
    />
  </div>
</template>
