<template>
  <div class="teacher-fab" id="teacher-fab" v-if="visible" @click="$emit('click')">
    <img :src="avatarSrc" />
  </div>
</template>

<script setup lang="ts">
defineProps<{ visible: boolean; avatarSrc?: string }>()
defineEmits<{ click: [] }>()
</script>
