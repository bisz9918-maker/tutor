<template>
  <div class="msg-row" :class="role">
    <img v-if="role === 'ai'" class="msg-avatar" :src="avatarSrc" />
    <div class="msg" :class="role">
      <div v-if="role === 'user'" class="msg-user-text">{{ text }}</div>
      <div v-else ref="aiTextRef" class="msg-ai-text" v-html="renderedHtml"></div>
      <button v-if="role === 'ai' && text" class="tts-btn" @click="onTTS">🔊 播放</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import { cleanLatex, escapeHtml, replaceNewlinesOutsideMath } from '../../utils/latex'
import { stripMarkers } from '../../utils/markers'
import { useMathJax } from '../../composables/useMathJax'

const props = defineProps<{
  role: 'user' | 'ai'
  text: string
  avatarSrc?: string
}>()

const { typeset } = useMathJax()
const aiTextRef = ref<HTMLElement | null>(null)

function scheduleTypeset() {
  if (typesetTimer) clearTimeout(typesetTimer)
  typesetTimer = setTimeout(async () => {
    // Wait for ref to be available
    if (!aiTextRef.value) {
      await nextTick()
    }
    if (aiTextRef.value) typeset(aiTextRef.value)
  }, 150)
}

const renderedHtml = computed(() => {
  if (props.role === 'user') return ''
  return replaceNewlinesOutsideMath(cleanLatex(escapeHtml(stripMarkers(props.text))))
})

let typesetTimer: ReturnType<typeof setTimeout> | null = null
watch(renderedHtml, () => scheduleTypeset(), { immediate: true })

function onTTS() {
  const event = new CustomEvent('tts-play', { detail: { text: props.text, btn: null } })
  document.dispatchEvent(event)
}
</script>
