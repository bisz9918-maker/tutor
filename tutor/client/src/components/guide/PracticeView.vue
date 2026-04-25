<template>
  <div class="practice-view" v-if="visible">
    <div class="practice-topbar">
      <button class="back-btn" @click="$emit('switch-to-guide')">← 返回讲题</button>
      <span style="font-size:.88rem;font-weight:700;color:var(--text);">做题</span>
      <div style="margin-left:auto;">
        <button class="btn btn-success" @click="$router.push('/grade')">提交解答 → 去批改</button>
      </div>
    </div>
    <div class="practice-body">
      <div class="practice-card">
        <div class="practice-kp">
          <span v-for="kp in guideStore.currentKP" :key="kp" class="kp-tag">{{ kp }}</span>
        </div>
        <div class="practice-text" v-html="renderedQuestion"></div>
        <img v-if="guideStore.currentOcrImagePath" :src="guideStore.currentOcrImagePath" class="practice-img" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'
import { useGuideStore } from '../../stores/guide'
import { cleanLatex, escapeHtml } from '../../utils/latex'
import { useMathJax } from '../../composables/useMathJax'

defineProps<{ visible: boolean }>()
defineEmits<{ 'switch-to-guide': [] }>()

const guideStore = useGuideStore()
const { typeset } = useMathJax()

const renderedQuestion = computed(() => {
  if (!guideStore.currentQuestion) return ''
  return cleanLatex(escapeHtml(guideStore.currentQuestion))
})

watch(renderedQuestion, () => {
  setTimeout(() => {
    const el = document.querySelector('.practice-card')
    if (el) typeset(el as HTMLElement)
  }, 50)
})
</script>
