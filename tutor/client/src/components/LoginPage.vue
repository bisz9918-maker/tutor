<template>
  <div id="login-mask">
    <div class="login-header-logo"><img src="/header-logo.webp" /></div>
    <div class="login-center">
      <div class="login-center-title">
        <h1>AI 讲题助手</h1>
        <p>智能引导，让每道题都成为进步的阶梯</p>
      </div>
      <div class="login-card">
        <div class="auth-tabs">
          <button class="auth-tab" :class="{ active: mode === 'login' }" @click="mode = 'login'">登录</button>
          <button class="auth-tab" :class="{ active: mode === 'register' }" @click="mode = 'register'">注册</button>
        </div>
        <div class="auth-field">
          <input v-model="uid" placeholder="用户名" @keyup.enter="submit" />
        </div>
        <div class="auth-field">
          <input v-model="password" type="password" placeholder="密码" @keyup.enter="submit" />
        </div>
        <div id="auth-error">{{ error }}</div>
        <button class="auth-submit" @click="submit" :disabled="loading">
          {{ mode === 'login' ? '登 录' : '注 册' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useAuthStore } from '../stores/auth'

const authStore = useAuthStore()
const mode = ref<'login' | 'register'>('login')
const uid = ref('')
const password = ref('')
const error = ref('')
const loading = ref(false)

async function submit() {
  error.value = ''
  loading.value = true
  try {
    if (mode.value === 'login') {
      await authStore.login(uid.value, password.value)
    } else {
      await authStore.register(uid.value, password.value)
    }
  } catch (e: any) {
    error.value = e.message || '操作失败'
  } finally {
    loading.value = false
  }
}
</script>
