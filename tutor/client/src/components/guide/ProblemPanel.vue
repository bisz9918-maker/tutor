<template>
  <div class="guide-problem" id="guide-problem">
    <div class="guide-problem-top" id="guide-problem-top" :class="{ collapsed: problemCollapsed }">
      <div class="guide-panel-header">
        <span class="guide-problem-label">题目</span>
        <button class="guide-collapse-btn" @click="problemCollapsed = !problemCollapsed">
          {{ problemCollapsed ? '展开' : '收起' }}
        </button>
      </div>
      <div id="guide-problem-top-body">
        <img v-if="guideStore.currentOcrImagePath" :src="guideStore.currentOcrImagePath" class="guide-problem-img" />
        <div ref="problemTextRef" class="guide-problem-text" id="guide-problem-text" v-html="renderedQuestion"></div>
      </div>
    </div>
    <div class="guide-problem-analysis" id="guide-problem-analysis" :class="{ collapsed: analysisCollapsed }">
      <div class="guide-panel-header">
        <span class="guide-problem-label">要点</span>
        <button class="guide-collapse-btn" @click="analysisCollapsed = !analysisCollapsed">
          {{ analysisCollapsed ? '展开' : '收起' }}
        </button>
      </div>
      <div id="guide-analysis-body" class="guide-analysis-body">
        <div v-if="guideStore.keypoints.length === 0" class="guide-analysis-empty">讲解中自动提取</div>
        <div v-for="(kp, i) in guideStore.keypoints" :key="i" ref="kpRefs" class="guide-keypoint" v-html="renderKeypoint(kp)"></div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useGuideStore } from '../../stores/guide'
import { cleanLatex, escapeHtml, replaceNewlinesOutsideMath } from '../../utils/latex'
import { useMathJax } from '../../composables/useMathJax'

const guideStore = useGuideStore()
const { typeset } = useMathJax()
const problemCollapsed = ref(false)
const analysisCollapsed = ref(false)
const problemTextRef = ref<HTMLElement | null>(null)

const renderedQuestion = computed(() => {
  if (!guideStore.currentQuestion) return ''
  return replaceNewlinesOutsideMath(cleanLatex(escapeHtml(guideStore.currentQuestion)))
})

function renderKeypoint(kp: string) {
  return replaceNewlinesOutsideMath(cleanLatex(escapeHtml(kp)))
}

watch(renderedQuestion, () => {
  setTimeout(() => typeset(problemTextRef.value), 50)
}, { immediate: true })

watch(() => guideStore.keypoints.length, () => {
  setTimeout(() => {
    const el = document.getElementById('guide-analysis-body')
    if (el) typeset(el)
  }, 150)
})
</script>
