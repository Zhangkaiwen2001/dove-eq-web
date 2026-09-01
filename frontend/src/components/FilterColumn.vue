<script setup>
import { computed, inject } from "vue";
import SliderField from "./SliderField.vue";
import GainSlider from "./GainSlider.vue";

const props = defineProps({
  index: { type: Number, required: true },
  filter: { type: Object, required: true }
});
const engine = inject("engine");

const freq = computed({
  get: () => (props.filter ? props.filter.freq : 1000),
  set: (v) => engine.updateFilterFreq(props.index, v)
});
const q = computed({
  get: () => (props.filter ? props.filter.q : 0.75),
  set: (v) => engine.updateFilterQ(props.index, v)
});
const gain = computed({
  get: () => (props.filter ? props.filter.gain : 0),
  set: (v) => engine.updateFilterGain(props.index, v)
});
</script>

<template>
  <section class="band-column">
    <div class="band-head">
      <div class="band-title">
        <div class="band-name">{{ index + 1 }}</div>
        <button
          class="reset-toggle"
          type="button"
          title="重置该滤波器"
          @click="engine.resetFilter(index)"
        >
          ↻
        </button>
      </div>
      <div class="band-actions">
        <button
          class="enable-toggle"
          :class="{ 'is-off': !filter.enabled }"
          type="button"
          :title="filter.enabled ? '禁用该滤波器' : '启用该滤波器'"
          @click="engine.toggleFilterEnabled(index)"
        ></button>
        <button class="btn btn-danger band-remove" type="button" @click="engine.removeFilter(filter.id)">删</button>
      </div>
    </div>

    <div class="band-form">
      <SliderField
        label="频点"
        v-model="freq"
        mode="log"
        :min="20"
        :max="20000"
        :step="1"
        :slider-min="0"
        :slider-max="1000"
        :slider-step="1"
      />
      <SliderField
        label="Q 值"
        v-model="q"
        mode="linear"
        :min="0.2"
        :max="4"
        :step="0.1"
        :slider-min="0.2"
        :slider-max="4"
        :slider-step="0.1"
      />
    </div>

    <div class="band-gain">
      <div class="band-gain-header">
        <span>推子增益</span>
        <strong :class="{ 'is-neg': filter.gain < 0 }">
          {{ filter.gain >= 0 ? "+" : "" }}{{ filter.gain.toFixed(1) }} dB
        </strong>
      </div>
      <GainSlider v-model="gain" :min="-10" :max="10" :step="0.2" />
    </div>
  </section>
</template>
