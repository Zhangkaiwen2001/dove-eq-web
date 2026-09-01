<script setup>
import { ref, inject, computed } from "vue";

const engine = inject("engine");
const state = engine.state;
const curveSearch = ref(state.curveLibrarySearch || "");

function onCurveSearch(e) {
  curveSearch.value = e.target.value;
  state.curveLibrarySearch = e.target.value;
  engine.refreshCurveLibraryOptions(e.target.value);
}
function onSelect(e) {
  state.selectedCurveLibraryPath = e.target.value;
  if (e.target.value) engine.importSelectedCurveLibraryEntry();
}
const refFreq = computed({
  get: () => state.refFreq,
  set: (v) => {
    state.refFreq = Number(v) || 1000;
  }
});
function onRefChange() {
  engine.applyRefFreq();
}
</script>

<template>
  <div class="import-box">
    <div class="import-head">
      <button class="btn import-title-btn" type="button" @click="engine.importSelectedCurveLibraryEntry()">
        导入频响曲线
      </button>
      <div class="import-help-wrap">
        <button class="import-help-btn" type="button" aria-label="导入频响曲线帮助">?</button>
        <div class="import-help-popover">
          <p class="mini-note">
            <span class="status-text" :class="{ 'is-error': state.curveLibraryStatusTone === 'error', 'is-ok': state.curveLibraryStatusTone === 'ok' }">
              {{ state.curveLibraryStatus }}
            </span>
          </p>
          <p class="import-inline-note">曲线来源：<code>web/曲线库</code>。支持常见 <code>.frd</code> / 文本双列频响文件。</p>
          <p class="mini-note">
            <span class="status-text" :class="{ 'is-error': state.importStatusTone === 'error', 'is-ok': state.importStatusTone === 'ok' }">
              {{ state.importStatus }}
            </span>
          </p>
        </div>
      </div>
    </div>

    <div class="import-panel-body">
      <div class="import-grid">
        <div class="field span-two">
          <label>曲线搜索</label>
          <input
            class="search-input"
            type="search"
            placeholder="输入曲线名称或文件名关键词"
            :value="curveSearch"
            @input="onCurveSearch"
          />
        </div>
        <div class="field span-two">
          <label>曲线库</label>
          <select
            class="curve-library-select"
            :value="state.selectedCurveLibraryPath"
            @change="onSelect"
          >
            <option v-if="!state.curveLibraryFilteredEntries.length" value="" disabled selected>
              {{ curveSearch ? "没有匹配的曲线" : "曲线库为空" }}
            </option>
            <option
              v-for="entry in state.curveLibraryFilteredEntries"
              :key="entry.path"
              :value="entry.path"
            >
              {{ entry.name }} | {{ entry.relativePath }}
            </option>
          </select>
        </div>
        <div class="curve-actions-row">
          <div class="field">
            <label>参考频率 (Hz)</label>
            <input
              class="number-input"
              type="number"
              min="20"
              max="20000"
              step="1"
              v-model="refFreq"
              @change="onRefChange"
            />
          </div>
          <button class="btn" type="button" @click="engine.applyRefFreq()">对齐</button>
          <button class="btn btn-danger" type="button" @click="engine.clearImportedCurve()">卸载曲线</button>
        </div>
      </div>
    </div>
  </div>
</template>
