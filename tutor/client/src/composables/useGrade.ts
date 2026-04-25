import { ref } from 'vue'
import { apiFetch } from '../utils/api'
import { renderGradeXML } from '../utils/gradeXml'

export function useGrade() {
  const streaming = ref(false)
  const fullText = ref('')
  const resultHtml = ref('')

  async function gradeAnswer(body: { index?: number; question?: string; questionImage?: string; studentAnswer: string }) {
    streaming.value = true
    fullText.value = ''
    resultHtml.value = '<div style="color:var(--text-sub);text-align:center;padding:20px;">批改中...</div>'

    try {
      const resp = await apiFetch('api/grade', {
        method: 'POST',
        body: JSON.stringify(body),
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

      resultHtml.value = renderGradeXML(fullText.value)
      return fullText.value
    } catch {
      resultHtml.value = '<div style="color:var(--danger);">批改请求失败</div>'
      return ''
    } finally {
      streaming.value = false
    }
  }

  return { streaming, fullText, resultHtml, gradeAnswer }
}
