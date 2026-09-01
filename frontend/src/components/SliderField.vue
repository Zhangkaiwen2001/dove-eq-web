<script setup>
import { computed } from "vue";
import { math } from "../engine/eqEngine.js";

const props = defineProps({
  label: { type: String, required: true },
  modelValue: { type: Number, required: true },
  mode: { type: String, default: "linear" }, // "log" | "linear"
  min: { type: Number, required: true },
  max: { type: Number, required: true },
  step: { type: Number, default: 0.1 },
  sliderMin: { type: Number, default: null },
  sliderMax: { type: Number, default: null },
  sliderStep: { type: Number, default: 1 },
  digits: { type: Number, default: 1 }
});
const emit = defineEmits(["update:modelValue"]);

const sMin = computed(() => (props.sliderMin != null ? props.sliderMin : props.min));
const sMax = computed(() => (props.sliderMax != null ? props.sliderMax : props.max));

const sliderValue = computed(() => {
  if (props.mode === "log") {
    return Math.round(math.freqToSlider(props.modelValue, props.min, props.max, sMin.value, sMax.value));
  }
  return props.modelValue;
});

const numberText = computed(() => {
  if (props.mode === "log") return String(Math.round(props.modelValue));
  return props.modelValue.toFixed(1);
});

function onNumber(e) {
  const raw = Number(e.target.value);
  if (!Number.isFinite(raw)) return;
  let v = props.mode === "log" ? Math.round(math.clamp(raw, props.min, props.max)) : math.roundToStep(math.clamp(raw, props.min, props.max), props.step);
  emit("update:modelValue", v);
}
function onSlider(e) {
  const v = Number(e.target.value);
  const out = props.mode === "log" ? math.sliderToFreq(v, props.min, props.max, sMin.value, sMax.value) : v;
  emit("update:modelValue", out);
}
</script>

<template>
  <div class="field">
    <label>{{ label }}</label>
    <input
      class="number-input"
      type="number"
      :min="min"
      :max="max"
      :step="mode === 'log' ? 1 : step"
      :value="numberText"
      @input="onNumber"
    />
    <input
      class="range-input"
      type="range"
      :min="sMin"
      :max="sMax"
      :step="sliderStep"
      :value="sliderValue"
      @input="onSlider"
    />
  </div>
</template>
