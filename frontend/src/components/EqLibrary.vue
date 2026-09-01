<script setup>
import { ref, inject, onMounted } from "vue";

const engine = inject("engine");
const state = engine.state;
const eqSearch = ref(state.eqLibrarySearch || "");
const fileInput = ref(null);

onMounted(() => {
  if (fileInput.value) engine.registerOpenEqFileInput(fileInput.value);
});

function onEqSearch(e) {
  eqSearch.value = e.target.value;
  state.eqLibrarySearch = e.target.value;
  engine.refreshEqLibraryOptions(e.target.value);
}
function onSelect(e) {
  state.selectedEqLibraryPath = e.target.value;
  if (e.target.value) engine.importSelectedEqLibraryEntry();
}
function onFileChange(e) {
  engine.handleOpenEqFileInputChange(e);
}
</script>

<template>
  <div class="eq-library-box">
    <div class="eq-library-head">
      <strong>EQ 库</strong>
      <p class="import-inline-note">默认目录：<code>web/eq库</code>。支持直接搜索、选择并调用 EQ 预设。</p>
    </div>
    <div class="eq-library-actions">
      <button class="btn" type="button" @click="engine.saveCurrentEqPreset()">保存当前EQ</button>
      <button class="btn" type="button" @click="engine.openEqPresetFile()">打开EQ文件</button>
      <button class="btn" type="button" @click="engine.loadEqLibrary(true)">刷新EQ库</button>
    </div>
    <div class="field">
      <label>EQ 搜索</label>
      <input
        class="search-input"
        type="search"
        placeholder="输入 EQ 名称或文件名关键词"
        :value="eqSearch"
        @input="onEqSearch"
      />
    </div>
    <div class="field">
      <label>EQ 预设</label>
      <select class="curve-library-select" :value="state.selectedEqLibraryPath" @change="onSelect">
        <option v-if="!state.eqLibraryFilteredEntries.length" value="" disabled selected>
          {{ eqSearch ? "没有匹配的EQ预设" : "EQ库为空" }}
        </option>
        <option
          v-for="entry in state.eqLibraryFilteredEntries"
          :key="entry.path"
          :value="entry.path"
        >
          {{ entry.name }} | {{ entry.relativePath }}
        </option>
      </select>
    </div>
    <p
      class="status-text"
      :class="{ 'is-error': state.eqLibraryStatusTone === 'error', 'is-ok': state.eqLibraryStatusTone === 'ok' }"
    >
      {{ state.eqLibraryStatus }}
    </p>
    <input
      ref="fileInput"
      type="file"
      accept=".json,.eqpreset,application/json"
      hidden
      @change="onFileChange"
    />
  </div>
</template>
