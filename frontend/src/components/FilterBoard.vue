<script setup>
import { computed, inject } from "vue";
import FilterColumn from "./FilterColumn.vue";

const engine = inject("engine");
const MAX_FILTERS = 8;

const columns = computed(() =>
  engine.state.filters
    .map((filter, index) => ({ filter, index }))
    .filter((entry) => entry.filter && entry.filter.id)
);
</script>

<template>
  <div class="filters">
    <FilterColumn
      v-for="entry in columns"
      :key="entry.filter.id"
      :index="entry.index"
      :filter="entry.filter"
    />
    <button
      v-if="engine.state.filters.length < MAX_FILTERS"
      class="band-add"
      type="button"
      title="添加 Peak 滤波器"
      @click="engine.addFilter()"
    >
      +
    </button>
  </div>
</template>
