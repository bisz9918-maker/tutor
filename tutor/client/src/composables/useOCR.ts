import { ref } from 'vue'
import { apiFetch } from '../utils/api'

export function useOCR() {
  const ocrStatus = ref('')
  const ocrOk = ref(false)

  async function ocrImage(file: File, type: 'question' | 'answer' = 'question'): Promise<{ text: string; imagePath?: string }> {
    const b64 = await new Promise<string>(resolve => {
      const reader = new FileReader()
      reader.onload = e => resolve((e.target!.result as string).split(',')[1])
      reader.readAsDataURL(file)
    })
    return ocrB64(b64, type)
  }

  async function ocrB64(b64: string, type: 'question' | 'answer' = 'question'): Promise<{ text: string; imagePath?: string }> {
    ocrStatus.value = '识别中...'
    ocrOk.value = false
    const prompt = type === 'answer'
      ? '请识别图片中的所有文字内容，原样输出。'
      : '请识别图片中的题目文字，数学公式和符号用 LaTeX 格式输出（用 $ 包裹行内公式），原样保留文字结构。'

    try {
      const r = await apiFetch('api/ocr', {
        method: 'POST',
        body: JSON.stringify({ image: b64, prompt }),
      })
      const data = await r.json()
      if (data.error) {
        ocrStatus.value = '识别失败：' + data.error.slice(0, 40)
        return { text: '' }
      }
      ocrStatus.value = '✓ 识别完成'
      ocrOk.value = true
      return { text: data.text, imagePath: data.imagePath }
    } catch {
      ocrStatus.value = '识别失败'
      return { text: '' }
    }
  }

  async function handlePaste(event: ClipboardEvent, targetId: string, type: 'question' | 'answer' = 'question'): Promise<{ text: string; imagePath?: string } | null> {
    const items = Array.from(event.clipboardData?.items || [])
    const imgItem = items.find(i => i.type.startsWith('image/'))
    if (!imgItem) return null
    event.preventDefault()
    const blob = imgItem.getAsFile()
    if (!blob) return null
    return ocrImage(blob, type)
  }

  return { ocrStatus, ocrOk, ocrImage, ocrB64, handlePaste }
}
