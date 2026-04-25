<template>
  <div class="chat-sidebar" id="chat-sidebar" :class="{ open: isOpen }">
    <div class="sidebar-header">
      <span class="sidebar-header-title">AI 讲解</span>
      <div class="auto-read-wrap">
        <label class="auto-read-switch">
          <input type="checkbox" v-model="tts.autoRead.value" />
          <span class="auto-read-slider"></span>
        </label>
        <span>朗读</span>
      </div>
      <button class="sidebar-close-btn" @click="close">✕</button>
    </div>
    <div class="messages" id="messages" ref="messagesRef">
      <div v-if="guideStore.history.length === 0 && !chat.streaming.value" class="placeholder">检索到题目后<br>选择「开始讲题」</div>
      <ChatMessage
        v-for="(msg, i) in guideStore.history"
        :key="i"
        :role="msg.role as 'user' | 'ai'"
        :text="msg.content"
        :avatar-src="msg.role === 'ai' ? avatarListening : undefined"
      />
      <ChatMessage
        v-if="chat.streaming.value && chat.fullText.value"
        key="streaming"
        role="ai"
        :text="chat.fullText.value"
        :avatar-src="avatarThinking"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, nextTick, watch } from 'vue'
import { useGuideStore } from '../../stores/guide'
import { useChat } from '../../composables/useChat'
import { useTTS } from '../../composables/useTTS'
import ChatMessage from './ChatMessage.vue'

const guideStore = useGuideStore()
const tts = useTTS()
const chat = useChat(tts)

const isOpen = ref(false)
const messagesRef = ref<HTMLElement | null>(null)

const avatarExplaining = '/teacher_explaining.svg'
const avatarListening = '/teacher_listening.svg'
const avatarThinking = '/teacher_thinking.svg'

function open() { isOpen.value = true }
function close() { isOpen.value = false }
function toggle() { isOpen.value = !isOpen.value }

// Auto-scroll on new messages or streaming text
watch(() => guideStore.history.length, () => {
  nextTick(() => {
    if (messagesRef.value) messagesRef.value.scrollTop = messagesRef.value.scrollHeight
  })
})
watch(() => chat.fullText.value, () => {
  nextTick(() => {
    if (messagesRef.value) messagesRef.value.scrollTop = messagesRef.value.scrollHeight
  })
})

defineExpose({ open, close, toggle, isOpen })
</script>
