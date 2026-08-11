<script setup>
import { provide, onMounted } from "vue";
import { createEqEngine } from "./engine/eqEngine.js";
import TopBar from "./components/TopBar.vue";
import SidePanel from "./components/SidePanel.vue";
import FilterBoard from "./components/FilterBoard.vue";
import PlotCanvas from "./components/PlotCanvas.vue";
import PreampCard from "./components/PreampCard.vue";

const engine = createEqEngine();
provide("engine", engine);

onMounted(() => {
  engine.init();
});
</script>

<template>
  <div class="app">
    <TopBar />
    <main class="workspace">
      <aside class="panel side-panel">
        <SidePanel />
      </aside>
      <section class="panel main-panel">
        <div class="main-panel-layout">
          <div class="band-board">
            <div class="band-frame">
              <FilterBoard />
            </div>
          </div>
          <div class="plot-main-wrap">
            <div class="plot-main">
              <PlotCanvas />
            </div>
            <PreampCard />
          </div>
        </div>
      </section>
    </main>
  </div>
</template>
