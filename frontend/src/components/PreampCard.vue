<script setup>
import { computed, inject } from "vue";
import VerticalSlider from "./VerticalSlider.vue";

const engine = inject("engine");
const state = engine.state;

const preamp = computed({
  get: () => state.preamp,
  set: (v) => engine.setPreamp(v)
});
</script>

<template>
  <aside class="preamp-card">
    <div class="preamp-copy">
      <strong>EQ 音量</strong>
    </div>
    <VerticalSlider
      v-model="preamp"
      :min="-30"
      :max="10"
      :step="0.2"
      :tick-values="[10, 0, -10, -20, -30]"
      :digits="1"
      suffix=" dB"
      :with-number-input="true"
    />
    <div class="preamp-help-wrap">
      <button class="btn btn-primary preamp-action-btn" type="button" @click="engine.autoPreamp()">
        失真补偿
      </button>
      <div class="preamp-help-popover">正增益会导致失真，点击失真补偿按钮平衡输出音量。</div>
    </div>
    <button class="btn preamp-action-btn preamp-reset-btn is-danger" type="button" @click="engine.resetAll()">
      <span><span>重置</span><span>EQ</span></span>
    </button>
  </aside>
</template>
