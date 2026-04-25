import { ref } from 'vue'
import { apiFetch } from '../utils/api'

export function useASR() {
  const isRecording = ref(false)
  let audioCtx: AudioContext | null = null
  let micStream: MediaStream | null = null
  let scriptNode: ScriptProcessorNode | null = null
  let pcmChunks: Float32Array[] = []
  let asrTimer: ReturnType<typeof setInterval> | null = null
  let asrSending = false

  function encodeWAV(samples: Float32Array, sampleRate: number): Blob {
    const buf = new ArrayBuffer(44 + samples.length * 2)
    const view = new DataView(buf)
    function writeStr(offset: number, str: string) { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)) }
    writeStr(0, 'RIFF')
    view.setUint32(4, 36 + samples.length * 2, true)
    writeStr(8, 'WAVE')
    writeStr(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, sampleRate * 2, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    writeStr(36, 'data')
    view.setUint32(40, samples.length * 2, true)
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]))
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true)
    }
    return new Blob([buf], { type: 'audio/wav' })
  }

  function collectPCM(): Float32Array | null {
    if (pcmChunks.length === 0) return null
    let totalLen = 0
    for (const c of pcmChunks) totalLen += c.length
    const merged = new Float32Array(totalLen)
    let offset = 0
    for (const c of pcmChunks) { merged.set(c, offset); offset += c.length }
    return merged
  }

  async function sendASRSegment(targetInput: HTMLTextAreaElement) {
    if (asrSending || pcmChunks.length === 0) return
    asrSending = true
    const rate = audioCtx ? audioCtx.sampleRate : 16000
    const merged = collectPCM()
    pcmChunks = []
    if (!merged) { asrSending = false; return }
    const wavBlob = encodeWAV(merged, rate)
    try {
      const resp = await apiFetch('api/asr', {
        method: 'POST',
        body: wavBlob,
      })
      const data = await resp.json()
      if (data.text) {
        targetInput.value = targetInput.value ? targetInput.value + data.text : data.text
        targetInput.focus()
      }
    } catch (e) {
      console.error('ASR segment error:', e)
    }
    asrSending = false
  }

  async function startRecording(targetInput: HTMLTextAreaElement) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1 } })
      audioCtx = new AudioContext({ sampleRate: 16000 })
      const source = audioCtx.createMediaStreamSource(micStream)
      scriptNode = audioCtx.createScriptProcessor(4096, 1, 1)
      pcmChunks = []
      scriptNode.onaudioprocess = (e) => {
        const data = e.inputBuffer.getChannelData(0)
        pcmChunks.push(new Float32Array(data))
      }
      source.connect(scriptNode)
      scriptNode.connect(audioCtx.destination)
      isRecording.value = true
      asrTimer = setInterval(() => { sendASRSegment(targetInput) }, 1000)
    } catch (e) {
      alert('无法访问麦克风，请检查浏览器权限设置')
      console.error('Mic error:', e)
    }
  }

  function stopRecording(targetInput: HTMLTextAreaElement) {
    if (!isRecording.value) return
    isRecording.value = false
    if (asrTimer) { clearInterval(asrTimer); asrTimer = null }
    if (scriptNode) { scriptNode.disconnect(); scriptNode = null }
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null }
    const rate = audioCtx ? audioCtx.sampleRate : 16000
    if (audioCtx) { audioCtx.close(); audioCtx = null }
    if (pcmChunks.length > 0) {
      const merged = collectPCM()
      pcmChunks = []
      if (merged) {
        const wavBlob = encodeWAV(merged, rate)
        transcribeAudio(wavBlob, targetInput)
      }
    }
  }

  async function transcribeAudio(blob: Blob, targetInput: HTMLTextAreaElement) {
    try {
      const resp = await apiFetch('api/asr', {
        method: 'POST',
        body: blob,
      })
      const data = await resp.json()
      if (data.text) {
        targetInput.value = targetInput.value ? targetInput.value + data.text : data.text
        targetInput.focus()
      }
    } catch (e) {
      console.error('ASR error:', e)
    }
  }

  function toggleMic(targetInput: HTMLTextAreaElement) {
    if (isRecording.value) stopRecording(targetInput)
    else startRecording(targetInput)
  }

  return { isRecording, toggleMic }
}
