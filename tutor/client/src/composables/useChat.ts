import { ref } from 'vue'
import { useGuideStore } from '../stores/guide'
import { useAuthStore } from '../stores/auth'
import { apiFetch } from '../utils/api'
import { extractSceneNames, stripMarkers } from '../utils/markers'
import { cleanLatex, escapeHtml } from '../utils/latex'
import { applyMarkers } from './useScene'
import { useTTS, TTSComposable } from './useTTS'

export function useChat(tts?: TTSComposable) {
  const guideStore = useGuideStore()
  const authStore = useAuthStore()
  const ttsInstance = tts || useTTS()
  const streaming = ref(false)
  const fullText = ref('')

  function renderAIText(text: string, triggerScenes = false): string {
    if (triggerScenes) {
      const names = extractSceneNames(text)
      if (names.length > 0) {
        const lastName = names[names.length - 1]
        if (guideStore.currentScenes.find(s => s.name === lastName)) {
          guideStore.showScene(lastName)
        }
      }
    }
    return cleanLatex(escapeHtml(stripMarkers(text)))
  }

  async function sendMessage(userMsg: string): Promise<string> {
    if (streaming.value) return ''
    streaming.value = true
    guideStore.streaming = true
    fullText.value = ''
    guideStore.keypoints = []

    guideStore.history.push({ role: 'user', content: userMsg })

    try {
      const resp = await apiFetch('api/chat', {
        method: 'POST',
        body: JSON.stringify({
          index: guideStore.currentIndex,
          history: guideStore.history.slice(0, -1),
          userMessage: userMsg,
          profile: authStore.userProfile,
        }),
      })

      // Read TTS session from response header for auto-read
      const ttsSessionId = resp.headers.get('X-TTS-Session')
      if (ttsSessionId) {
        ttsInstance.streamAutoRead(ttsSessionId)
      }

      const reader = resp.body!.getReader()
      const dec = new TextDecoder()
      let buf = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop()!
        for (const l of lines) {
          if (!l.startsWith('data: ')) continue
          const p = l.slice(6)
          try {
            const evt = JSON.parse(p)
            if (evt.delta) {
              fullText.value += evt.delta
            }
            if (evt.keypoint) {
              guideStore.keypoints.push(evt.keypoint)
            }
          } catch {}
        }
      }

      // Trigger scenes and actions on complete text
      const names = extractSceneNames(fullText.value)
      if (names.length > 0) {
        const lastName = names[names.length - 1]
        if (guideStore.currentScenes.find(s => s.name === lastName)) {
          guideStore.showScene(lastName)
        }
      }

      // Execute CLICK and SPOTLIGHT markers
      applyMarkers(fullText.value)

      guideStore.history.push({ role: 'assistant', content: fullText.value })
      return fullText.value
    } catch {
      fullText.value = '请求失败，请重试。'
      return fullText.value
    } finally {
      streaming.value = false
      guideStore.streaming = false
    }
  }

  return { streaming, fullText, sendMessage, renderAIText }
}
