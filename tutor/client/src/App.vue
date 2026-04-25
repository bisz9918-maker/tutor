<template>
  <div id="app-root" style="height:100vh;display:flex;flex-direction:column;overflow:hidden;">
    <AppHeader v-if="authStore.loggedIn" @openProfile="showProfile = true" />
    <div class="main" v-if="authStore.loggedIn">
      <div class="content">
        <router-view />
      </div>
    </div>
    <LoginPage v-if="!authStore.loggedIn" />
    <ProfileModal v-if="showProfile" @close="showProfile = false" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useAuthStore } from './stores/auth'
import AppHeader from './components/AppHeader.vue'
import LoginPage from './components/LoginPage.vue'
import ProfileModal from './components/ProfileModal.vue'

const authStore = useAuthStore()
const showProfile = ref(false)

onMounted(() => {
  authStore.initAuth()
})
</script>
