<script setup>
import { computed } from "vue";
import { math } from "../engine/eqEngine.js";

const props = defineProps({
  modelValue: { type: Number, required: true },
  min: { type: Number, default: -10 },
  max: { type: Number, default: 10 },
  step: { type: Number, default: 0.2 },
  digits: { type: Number, default: 1 },
  suffix: { type: String, default: " dB" }
});
const emit = defineEmits(["update:modelValue"]);

const display = computed(() => `${props.modelValue >= 0 ? "+" : ""}${props.modelValue.toFixed(props.digits)}${props.suffix}`);

function onInput(e) {
  const raw = Number(e.target.value);
  if (!Number.isFinite(raw)) return;
  emit("update:modelValue", math.roundToStep(math.clamp(raw, props.min, props.max), props.step));
}
</script>

<template>
  <div class="horizontal-gain">
    <div class="horizontal-gain-row">
      <div class="horizontal-gain-value">{{ display }}</div>
      <input
        class="range-input"
        type="range"
        :min="min"
        :max="max"
        :step="step"
        :value="modelValue"
        @input="onInput"
      />
    </div>
    <div class="horizontal-scale">
      <span>{{ min > 0 ? "+" : "" }}{{ min }}</span>
      <span>0</span>
      <span>{{ max > 0 ? "+" : "" }}{{ max }}</span>
    </div>
  </div>
</template>
