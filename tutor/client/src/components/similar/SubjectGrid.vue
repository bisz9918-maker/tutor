<template>
  <div class="browse-section-title">选择学科</div>
  <div class="subject-grid">
    <div v-for="s in subjects" :key="s.subject" class="subject-card" @click="$emit('select', s.subject)">
      <div class="subject-card-name">{{ s.label }}</div>
      <div class="subject-card-count">{{ s.count }} 道题</div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{ subjects: { subject: string; label: string; count: number }[] }>()
defineEmits<{ select: [subject: string] }>()
</script>
