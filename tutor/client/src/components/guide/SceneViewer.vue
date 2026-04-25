<template>
  <div class="guide-scene" id="guide-scene">
    <div class="guide-scene-label">步骤图示</div>
    <div class="scene-tabs" v-if="guideStore.currentScenes.length > 0">
      <div
        v-for="sc in guideStore.currentScenes"
        :key="sc.name"
        class="scene-tab"
        :class="{ active: sc.name === guideStore.activeSceneName }"
        @click="scene.showScene(sc.name)"
      >
        步骤 {{ sc.name.replace('scene', '') }}
      </div>
    </div>
    <div v-if="!guideStore.activeSceneName" class="guide-scene-empty">
      <div>等待 AI 绘图...</div>
    </div>
    <img
      v-if="scene.currentSceneUrl.value && !scene.currentSceneIsHtml.value"
      :src="scene.currentSceneUrl.value"
      class="guide-scene-img"
      @load="onImgLoad"
    />
    <div
      v-if="scene.currentSceneIsHtml.value"
      id="guide-scene-iframe-wrap"
      class="guide-scene-iframe-wrap"
    >
      <iframe
        id="guide-scene-iframe"
        ref="iframeRef"
        class="guide-scene-iframe"
        scrolling="no"
        :src="scene.currentSceneUrl.value"
        @load="onIframeLoad"
      ></iframe>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useGuideStore } from '../../stores/guide'
import { useScene } from '../../composables/useScene'

const guideStore = useGuideStore()
const scene = useScene()
const iframeRef = ref<HTMLIFrameElement | null>(null)

function onIframeLoad() {
  const iframe = iframeRef.value
  const wrap = document.getElementById('guide-scene-iframe-wrap')
  if (iframe && wrap) scene.onIframeLoad(iframe, wrap)
}

function onImgLoad(e: Event) {
  const img = e.target as HTMLImageElement
  img.style.opacity = '1'
}

// Watch for scene changes to update iframe/img src
watch(() => guideStore.activeSceneName, () => {
  const sc = guideStore.currentScenes.find(s => s.name === guideStore.activeSceneName)
  if (sc) {
    scene.currentSceneUrl.value = sc.url
    scene.currentSceneIsHtml.value = sc.isHtml
  }
}, { immediate: true })

// Auto-show first scene when scenes loaded but none active
watch(() => guideStore.currentScenes, (scenes) => {
  if (scenes.length > 0 && !guideStore.activeSceneName) {
    guideStore.showScene(scenes[0].name)
  }
}, { immediate: true })
</script>
