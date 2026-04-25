<template>
  <header class="app-header">
    <img src="/header-logo.webp" class="logo-img" alt="Logo" />
    <div class="divider"></div>
    <span class="app-name">AI 讲题助手</span>
    <div class="user-area">
      <span class="user-name">{{ authStore.currentUid }}</span>
      <button class="settings-btn" @click="$emit('openProfile')">设置</button>
      <button class="logout-btn" @click="authStore.logout()">退出</button>
    </div>
  </header>
</template>

<script setup lang="ts">
import { useAuthStore } from '../stores/auth'
const authStore = useAuthStore()
defineEmits<{ openProfile: [] }>()
</script>
