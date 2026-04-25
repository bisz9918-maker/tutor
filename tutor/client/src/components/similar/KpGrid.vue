<template>
  <div class="browse-section-title">{{ title }}</div>
  <div v-if="!results.length" class="placeholder">{{ emptyText }}</div>
  <QuestionCard v-for="q in results" :key="q.index" :q="q" @click="$emit('select', q.index)" />
</template>

<script setup lang="ts">
import QuestionCard from './QuestionCard.vue'

defineProps<{
  title: string
  results: any[]
  emptyText?: string
}>()

defineEmits<{ select: [index: number] }>()
</script>
