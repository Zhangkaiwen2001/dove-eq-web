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

    <p class="module-signature">
      鸽子设计，后续更新请关注鸽子耳机 B站、抖音账号以及群内文件更新
      <a class="taobao-link" href="https://shop285374599.taobao.com/shop/view_shop.htm?appUid=RAzN8HWYfkbBEvZAvNcw4nvoxezRkrEfnaPq9eYbn38Q56eWdLw&amp;spm=a21n57.1.hoverItem.3" target="_blank" rel="noopener noreferrer" aria-label="打开淘宝店铺链接" title="打开淘宝店铺链接"><span class="taobao-icon" aria-hidden="true">淘</span></a>
      <a class="bilibili-link" href="https://space.bilibili.com/13124272?spm_id_from=333.1007.0.0" target="_blank" rel="noopener noreferrer" aria-label="打开B站主页链接" title="打开B站主页链接"><span class="bilibili-icon" aria-hidden="true">B</span></a>
      <a class="douyin-link" href="https://www.douyin.com/user/MS4wLjABAAAAr65d1MixiQk91ZeYEQ5yn6fhdU8eTpvFZyXzjhvtMh0?from_tab_name=main" target="_blank" rel="noopener noreferrer" aria-label="打开抖音主页链接" title="打开抖音主页链接"><span class="douyin-icon" aria-hidden="true">抖</span></a>
      <a class="goofish-link" href="https://www.goofish.com/personal?spm=a21ybx.item.itemHeader.1.5caf3da6iVtkDM&amp;userId=2742261426" target="_blank" rel="noopener noreferrer" aria-label="打开闲鱼主页链接" title="打开闲鱼主页链接"><span class="goofish-icon" aria-hidden="true">鱼</span></a>
    </p>
  </div>
</template>
