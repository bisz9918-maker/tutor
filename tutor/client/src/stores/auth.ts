import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { apiFetch } from '../utils/api'

export const useAuthStore = defineStore('auth', () => {
  const sessionToken = ref(localStorage.getItem('session_token') || '')
  const currentUid = ref('')
  const userProfile = ref<Record<string, any>>({})

  const loggedIn = computed(() => !!sessionToken.value && !!currentUid.value)

  async function initAuth() {
    if (!sessionToken.value) return
    try {
      const resp = await apiFetch('api/me')
      if (resp.ok) {
        const data = await resp.json()
        currentUid.value = data.uid
        userProfile.value = data.profile || {}
      } else {
        sessionToken.value = ''
        localStorage.removeItem('session_token')
      }
    } catch {
      sessionToken.value = ''
      localStorage.removeItem('session_token')
    }
  }

  async function login(uid: string, password: string) {
    const resp = await apiFetch('api/login', {
      method: 'POST',
      body: JSON.stringify({ uid, password }),
    })
    const data = await resp.json()
    if (!resp.ok) throw new Error(data.error || '登录失败')
    sessionToken.value = data.token
    currentUid.value = data.uid
    localStorage.setItem('session_token', data.token)
  }

  async function register(uid: string, password: string) {
    const resp = await apiFetch('api/register', {
      method: 'POST',
      body: JSON.stringify({ uid, password }),
    })
    const data = await resp.json()
    if (!resp.ok) throw new Error(data.error || '注册失败')
    sessionToken.value = data.token
    currentUid.value = data.uid
    localStorage.setItem('session_token', data.token)
  }

  async function logout() {
    await apiFetch('api/logout', { method: 'POST' })
    sessionToken.value = ''
    currentUid.value = ''
    userProfile.value = {}
    localStorage.removeItem('session_token')
  }

  return { sessionToken, currentUid, userProfile, loggedIn, initAuth, login, register, logout }
})
