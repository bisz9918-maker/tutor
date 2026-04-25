<template>
  <div class="gen-progress-wrap" v-if="visible" :class="{ visible: visible }">
    <div class="gen-progress-bar-bg">
      <div class="gen-progress-bar" :style="{ width: percent + '%' }"></div>
    </div>
    <div class="gen-progress-label">{{ label }}</div>
  </div>
</template>

<script setup lang="ts">
defineProps<{ visible: boolean; percent: number; label: string }>()
</script>
