import { ref } from 'vue'
import { apiFetch } from '../utils/api'

export function useMistakes() {
  const streaming = ref(false)
  const fullText = ref('')

  async function analyzeMistake(id: string, profile?: Record<string, any>) {
    streaming.value = true
    fullText.value = ''

    try {
      const resp = await apiFetch('api/mistakes/analyze', {
        method: 'POST',
        body: JSON.stringify({ id, profile }),
      })

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
          if (p === '[DONE]') continue
          try {
            const { delta } = JSON.parse(p)
            if (delta) fullText.value += delta
          } catch {}
        }
      }

      return fullText.value
    } catch {
      fullText.value = '分析失败'
      return ''
    } finally {
      streaming.value = false
    }
  }

  return { streaming, fullText, analyzeMistake }
}
