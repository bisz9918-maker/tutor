<template>
  <Teleport to="body">
    <div v-if="visible" class="mistake-detail-overlay" @click.self="$emit('close')">
      <div class="mistake-detail-card">
        <div class="mistake-detail-header">
          <span class="mistake-detail-title">错题分析</span>
          <button class="back-btn" @click="$emit('close')">✕ 关闭</button>
        </div>
        <div class="mistake-detail-body">
          <div class="detail-question" v-html="renderedQuestion"></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn btn-primary" @click="analyze" :disabled="analyzing">{{ analyzing ? '分析中...' : 'AI 深度分析' }}</button>
            <button class="btn btn-primary" v-if="!mistake?.hasDoc" @click="$emit('generate', mistake)" :disabled="mistake?._generating">{{ mistake?._generating ? '生成中...' : '生成讲解材料' }}</button>
            <button class="btn btn-outline" v-if="mistake?.hasDoc" @click="$emit('go-guide', mistake)">从这题开始讲解</button>
            <button class="btn btn-secondary" @click="$emit('delete', mistake?.id)">移出错题本</button>
          </div>
          <GenProgressBar :visible="generating" :percent="genPercent" :label="genLabel" />
          <div v-if="analysis" class="detail-analysis" v-html="renderedAnalysis"></div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { cleanLatex, escapeHtml } from '../../utils/latex'
import { useMathJax } from '../../composables/useMathJax'
import { useMistakes } from '../../composables/useMistakes'
import GenProgressBar from '../guide/GenProgressBar.vue'

const props = defineProps<{
  visible: boolean
  mistake: any | null
}>()

const emit = defineEmits<{
  close: []
  generate: [mistake: any]
  'go-guide': [mistake: any]
  delete: [id: string | undefined]
}>()

const { typeset } = useMathJax()
const mistakesComposable = useMistakes()
const analyzing = ref(false)
const generating = ref(false)
const genPercent = ref(0)
const genLabel = ref('')
const analysis = ref('')

const renderedQuestion = computed(() => {
  if (!props.mistake) return ''
  return cleanLatex(escapeHtml(props.mistake.question))
})

const renderedAnalysis = computed(() => {
  if (!analysis.value) return ''
  return cleanLatex(escapeHtml(analysis.value))
})

watch(renderedQuestion, () => {
  setTimeout(() => {
    const el = document.querySelector('.detail-question')
    if (el) typeset(el as HTMLElement)
  }, 50)
})

watch(renderedAnalysis, () => {
  setTimeout(() => {
    const el = document.querySelector('.detail-analysis')
    if (el) typeset(el as HTMLElement)
  }, 50)
})

watch(() => props.visible, () => {
  if (props.visible) analysis.value = ''
})

async function analyze() {
  if (!props.mistake) return
  analyzing.value = true
  analysis.value = ''
  const result = await mistakesComposable.analyzeMistake(props.mistake.id)
  analysis.value = result || ''
  analyzing.value = false
}
</script>

<style scoped>
.mistake-detail-overlay {
  position: fixed;
  inset: 0;
  background: rgba(10, 10, 40, 0.45);
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(2px);
}
.mistake-detail-card {
  background: #fff;
  border-radius: 16px;
  width: 680px;
  max-width: 95vw;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 8px 40px rgba(85, 90, 255, 0.18);
}
.mistake-detail-header {
  padding: 18px 24px;
  border-bottom: 1px solid var(--border);
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.mistake-detail-title {
  font-weight: 700;
  font-size: 0.98rem;
  color: var(--text);
}
.mistake-detail-body {
  flex: 1;
  overflow-y: auto;
  padding: 18px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.detail-question {
  background: #f5f6ff;
  border: 1px solid #e0e1ff;
  border-radius: 12px;
  padding: 14px;
  font-size: 0.9rem;
  line-height: 1.75;
  white-space: pre-wrap;
  color: var(--text);
}
.detail-analysis {
  white-space: pre-wrap;
  line-height: 1.85;
  font-size: 0.91rem;
  color: var(--text);
}
</style>
