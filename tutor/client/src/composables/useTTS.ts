import { ref } from 'vue'
import { apiFetch } from '../utils/api'

export type TTSComposable = ReturnType<typeof _createTTS>

let _instance: TTSComposable | null = null

export function useTTS(): TTSComposable {
  if (!_instance) _instance = _createTTS()
  return _instance
}

function _createTTS() {
  const autoRead = ref(true)
  const currentAudio = ref<AudioBufferSourceNode | null>(null)
  const currentAudioStopped = ref(false)
  const isPlaying = ref(false)
  const isLoading = ref(false)
  let ttsAbort: AbortController | null = null

  function stopCurrentAudio() {
    currentAudioStopped.value = true
    isPlaying.value = false
    isLoading.value = false
    if (currentAudio.value) {
      try { currentAudio.value.stop() } catch {}
      currentAudio.value = null
    }
  }

  function splitTTSSentences(text: string): string[] {
    const raw = text
      .replace(/\[SHOW_SCENE\s+scene\d+\]/g, '')
      .replace(/\[scene\d+\]/g, '')
      .replace(/\[\d+\]/g, '')
    const parts = raw.match(/[^。！？；\n]*[。！？；\n]|[^。！？；\n]+$/g) || [raw]
    const merged: string[] = []
    let buf = ''
    for (const p of parts) {
      buf += p
      if (buf.length >= 15) { merged.push(buf); buf = '' }
    }
    if (buf) { if (merged.length > 0 && merged[merged.length - 1].length < 30) merged[merged.length - 1] += buf; else merged.push(buf) }
    return merged.length > 0 ? merged : [raw]
  }

  async function playTTS(text: string, btn: HTMLButtonElement, avatar?: HTMLImageElement | null) {
    stopCurrentAudio()
    if (ttsAbort) { ttsAbort.abort(); ttsAbort = null }
    if (btn.classList.contains('playing')) {
      btn.classList.remove('playing')
      btn.innerHTML = '🔊 播放'
      return
    }
    document.querySelectorAll('.tts-btn.playing').forEach(b => {
      ;(b as HTMLButtonElement).classList.remove('playing')
      ;(b as HTMLButtonElement).innerHTML = '🔊 播放'
    })
    const sentences = splitTTSSentences(text)
    const abort = new AbortController()
    ttsAbort = abort
    currentAudioStopped.value = false
    btn.disabled = true
    btn.innerHTML = '⏳ 加载...'

    try {
      const ctx = new AudioContext()
      await ctx.resume()
      let nextStartTime = 0

      for (const sentence of sentences) {
        if (abort.signal.aborted || currentAudioStopped.value) break
        const sessId = 'tts-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
        const startResp = await fetch('/api/tts-stream-start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: sentence, sid: sessId }),
          signal: abort.signal,
        })
        if (!startResp.ok) continue
        const streamResp = await fetch('/api/tts-stream-direct/' + sessId, { signal: abort.signal })
        if (!streamResp.ok || !streamResp.body) continue
        const reader = streamResp.body.getReader()
        const textDec = new TextDecoder()
        let sseBuf = ''
        while (!abort.signal.aborted && !currentAudioStopped.value) {
          const { done, value } = await reader.read()
          if (done) break
          sseBuf += textDec.decode(value, { stream: true })
          const lines = sseBuf.split('\n')
          sseBuf = lines.pop() || ''
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            try {
              const obj = JSON.parse(line.slice(6))
              if (obj.done || obj.chunkEnd || obj.error) continue
              if (!obj.audio) continue
              const binary = atob(obj.audio)
              const bytes = new Uint8Array(binary.length)
              for (let j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j)
              try {
                const audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0))
                const source = ctx.createBufferSource()
                source.buffer = audioBuffer
                source.connect(ctx.destination)
                const startAt = Math.max(nextStartTime, ctx.currentTime)
                source.start(startAt)
                nextStartTime = startAt + audioBuffer.duration
                currentAudio.value = source
                isPlaying.value = true
                btn.disabled = false
                btn.classList.add('playing')
                btn.innerHTML = '⏸ 暂停'
              } catch {}
            } catch {}
          }
        }
      }
      if (nextStartTime > ctx.currentTime) {
        await new Promise(r => setTimeout(r, (nextStartTime - ctx.currentTime) * 1000 + 200))
      }
      ctx.close()
    } catch (e: any) {
      if (e.name !== 'AbortError') console.error('TTS error:', e)
    }
    btn.disabled = false
    btn.innerHTML = '🔊 播放'
    btn.classList.remove('playing')
    isPlaying.value = false
    currentAudio.value = null
    ttsAbort = null
  }

  async function streamAutoRead(ttsSessionId: string, avatar?: HTMLImageElement | null) {
    if (!autoRead.value || !ttsSessionId) return
    currentAudioStopped.value = false
    isLoading.value = true
    try {
      const streamResp = await apiFetch('api/tts-stream-direct/' + ttsSessionId)
      if (!streamResp.ok || !streamResp.body) return
      const ctx = new AudioContext()
      await ctx.resume()
      let nextStartTime = 0
      const reader = streamResp.body.getReader()
      const textDec = new TextDecoder()
      let sseBuf = ''
      while (!currentAudioStopped.value) {
        const { done, value } = await reader.read()
        if (done) break
        sseBuf += textDec.decode(value, { stream: true })
        const lines = sseBuf.split('\n')
        sseBuf = lines.pop() || ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const obj = JSON.parse(line.slice(6))
            if (obj.chunkEnd || obj.error) continue
            if (obj.done) break
            if (!obj.audio) continue
            const binary = atob(obj.audio)
            const bytes = new Uint8Array(binary.length)
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
            try {
              const audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0))
              const source = ctx.createBufferSource()
              source.buffer = audioBuffer
              source.connect(ctx.destination)
              const startAt = Math.max(nextStartTime, ctx.currentTime)
              source.start(startAt)
              nextStartTime = startAt + audioBuffer.duration
              currentAudio.value = source
              isLoading.value = false
              isPlaying.value = true
            } catch {}
          } catch {}
        }
      }
      if (nextStartTime > ctx.currentTime) {
        await new Promise(r => setTimeout(r, (nextStartTime - ctx.currentTime) * 1000 + 200))
      }
      ctx.close()
      isPlaying.value = false
    } catch (e) {
      console.warn('[TTS] stream error:', e)
    } finally {
      isLoading.value = false
    }
  }

  return { autoRead, currentAudio, isPlaying, isLoading, stopCurrentAudio, splitTTSSentences, playTTS, streamAutoRead }
}
