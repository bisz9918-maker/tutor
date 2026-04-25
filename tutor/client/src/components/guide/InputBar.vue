<template>
  <div class="input-bar" id="input-bar" v-if="visible">
    <textarea
      ref="inputRef"
      id="reply-input"
      v-model="text"
      placeholder="输入回答...（Enter 发送，Shift+Enter 换行）"
      @keydown="handleKey"
    ></textarea>
    <button class="btn btn-primary" id="send-btn" @click="send" :disabled="chat.streaming.value">发送</button>
    <button class="mic-btn" id="mic-btn" @click="toggleMic" :class="{ recording: asr.isRecording.value }" title="语音输入">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="1" width="6" height="11" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="8" y1="21" x2="16" y2="21"/></svg>
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useChat } from '../../composables/useChat'
import { useASR } from '../../composables/useASR'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{ send: [text: string] }>()

const chat = useChat()
const asr = useASR()
const text = ref('')
const inputRef = ref<HTMLTextAreaElement | null>(null)

function handleKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
}

function send() {
  if (chat.streaming.value) return
  const msg = text.value.trim()
  if (!msg) return
  text.value = ''
  emit('send', msg)
}

function toggleMic() {
  if (inputRef.value) asr.toggleMic(inputRef.value)
}
</script>
