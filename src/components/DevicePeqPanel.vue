<script setup>
import { inject } from "vue";

const engine = inject("engine");
const state = engine.state;
</script>

<template>
  <div class="device-dock">
    <div class="device-peq-host">
      <div class="device-peq-card">
        <div class="device-peq-title">
          <span class="dot"></span> 设备 PEQ 直连
        </div>
        <!-- 设备插件会将 UI 注入到该锚点 -->
        <div id="devicePeqAnchor"></div>
        <p class="device-peq-hint">{{ state.devicePeqHint }}</p>
        <p
          class="status-text"
          :class="{
            'is-error': state.devicePeqStatusTone === 'error',
            'is-ok': state.devicePeqStatusTone === 'ok'
          }"
        >
          {{ state.devicePeqStatus }}
        </p>
      </div>
    </div>
  </div>
</template>
