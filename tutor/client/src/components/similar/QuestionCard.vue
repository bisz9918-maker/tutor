<template>
  <div class="q-card" @click="$emit('click')">
    <div class="q-meta">
      <span>{{ q.subject }}</span>
      <span>{{ q.type }}</span>
      <span class="tag" :class="diffClass">{{ q.difficulty }}</span>
      <span v-if="q.hasDoc" style="color:var(--primary)">有图解</span>
    </div>
    <div class="q-text">{{ q.question.slice(0, 120) }}{{ q.question.length > 120 ? '...' : '' }}</div>
    <div class="q-kp">📌 {{ q.knowledge_point.join('、') || '—' }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  q: {
    index: number
    subject: string
    type: string
    difficulty: string
    question: string
    knowledge_point: string[]
    hasDoc?: boolean
  }
}>()

defineEmits<{ click: [] }>()

const diffClass = computed(() => {
  if (props.q.difficulty === '难') return 'tag-hard'
  if (props.q.difficulty === '较难') return 'tag-medium'
  return 'tag-easy'
})
</script>
