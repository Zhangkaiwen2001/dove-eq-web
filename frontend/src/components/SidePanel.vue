<script setup>
import { inject } from "vue";
import DevicePeqPanel from "./DevicePeqPanel.vue";
import ImportBox from "./ImportBox.vue";
import EqLibrary from "./EqLibrary.vue";

const engine = inject("engine");
const state = engine.state;
</script>

<template>
  <div class="side-panel-layout">
    <DevicePeqPanel />

    <div class="plot-import">
      <ImportBox />
      <div class="more-panel">
        <div class="more-meta">
          <label class="toggle-pill" :class="{ 'is-on': state.showIndividuals }">
            <input
              type="checkbox"
              :checked="state.showIndividuals"
              @change="engine.setShowIndividuals($event.target.checked)"
            />
            <span>显示单个滤波器曲线</span>
          </label>
        </div>
        <EqLibrary />
      </div>
    </div>
  </div>
</template>
