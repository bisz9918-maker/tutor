<template>
  <div class="mistake-card" @click="$emit('click')">
    <div class="mistake-meta">
      <span>{{ m.subject }}</span>
      <span>{{ m.type }}</span>
      <span class="tag" :class="diffClass">{{ m.difficulty }}</span>
      <span v-if="m.gradeResult" style="background:#dcfce7;color:var(--success);padding:2px 7px;border-radius:6px;font-size:.74rem;font-weight:600">有批改记录</span>
      <span v-if="m.hasDoc" style="background:var(--success-light);color:var(--success);padding:2px 7px;border-radius:6px;font-size:.74rem;font-weight:600">有讲解</span>
      <span v-else style="background:var(--warning-light);color:#b47800;padding:2px 7px;border-radius:6px;font-size:.74rem;font-weight:600">待生成</span>
      <span class="mistake-date">{{ formatDate(m.addedAt) }}</span>
    </div>
    <div class="mistake-text">{{ m.question.slice(0, 100) }}{{ m.question.length > 100 ? '...' : '' }}</div>
    <div style="font-size:.76rem;color:var(--primary);margin-top:5px;">📌 {{ m.knowledge_point.join('、') || '—' }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  m: {
    id: string
    subject: string
    type: string
    difficulty: string
    question: string
    knowledge_point: string[]
    hasDoc?: boolean
    gradeResult?: string
    addedAt: string
  }
}>()

defineEmits<{ click: [] }>()

const diffClass = computed(() => {
  if (props.m.difficulty === '难') return 'tag-hard'
  if (props.m.difficulty === '较难') return 'tag-medium'
  return 'tag-easy'
})

function formatDate(d: string) {
  return new Date(d).toLocaleDateString('zh-CN')
}
</script>
