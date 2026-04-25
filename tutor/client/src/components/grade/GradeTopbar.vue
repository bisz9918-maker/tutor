<template>
  <div class="topbar">
    <div class="topbar-row">
      <button class="back-btn" @click="$router.push('/')">← 返回</button>
      <span class="topbar-title">题目批改</span>
    </div>
    <textarea
      id="grade-q-input"
      v-model="question"
      placeholder="粘贴题目文字...（可直接 Ctrl+V 粘贴截图）"
      @paste="onPasteQuestion"
    ></textarea>
    <div v-if="questionImgSrc" id="grade-q-img-wrap" style="position:relative;display:inline-block;margin-top:4px;">
      <img :src="questionImgSrc" style="max-width:100%;max-height:200px;border-radius:8px;border:1px solid var(--border);" />
      <button style="position:absolute;top:4px;right:4px;background:rgba(0,0,0,.5);color:#fff;border:none;border-radius:50%;width:22px;height:22px;cursor:pointer;font-size:12px;" @click="removeImg">✕</button>
    </div>
    <div class="topbar-row" style="gap:6px;">
      <label class="btn btn-secondary" style="cursor:pointer;margin:0;">
        📷 拍照识别题目
        <input type="file" accept="image/*" capture="environment" style="display:none" @change="onOcrFile($event, 'question')" />
      </label>
      <span class="status" :class="{ ok: ocrOk, err: ocrStatus && !ocrOk }">{{ ocrStatus }}</span>
    </div>
    <div class="topbar-row">
      <button class="btn btn-primary" id="grade-search-btn" @click="searchForGrade" :disabled="searching">检索题目</button>
      <button class="btn btn-outline" id="grade-reset-btn" v-if="gradeStore.gradeIndex !== null" @click="resetGrade">重置</button>
      <button class="btn btn-mistake" id="grade-add-mistake-btn" v-if="gradeStore.gradeIndex !== null" @click="addMistake">加入错题本</button>
      <button class="btn btn-primary" id="grade-to-guide-btn" v-if="gradeStore.gradeResult" @click="gradeToGuide">去讲题</button>
      <span class="status" :class="{ ok: statusOk, err: statusErr }">{{ statusText }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useGuideStore } from '../../stores/guide'
import { useAuthStore } from '../../stores/auth'
import { apiFetch } from '../../utils/api'
import { useOCR } from '../../composables/useOCR'

const router = useRouter()
const gradeStore = useGuideStore()
const authStore = useAuthStore()
const ocr = useOCR()

const question = ref('')
const questionImgSrc = ref('')
const questionImgB64 = ref<string | null>(null)
const searching = ref(false)
const statusText = ref('')
const statusOk = ref(false)
const statusErr = ref(false)
const ocrStatus = ref('')
const ocrOk = ref(false)

// Sync from guide store if navigating from guide/mistakes with index already set
onMounted(() => {
  if (gradeStore.gradeIndex !== null && !question.value) {
    question.value = gradeStore.currentQuestion || ''
    statusOk.value = true
    statusText.value = `✓ #${gradeStore.gradeIndex}`
  }
  if (gradeStore.gradeQuestion && !question.value) {
    question.value = gradeStore.gradeQuestion
  }
})

// Sync question text and image to store for GradeResult to use
watch(question, (q) => { gradeStore.gradeQuestion = q })
watch(questionImgB64, (b64) => { gradeStore.gradeQImageB64 = b64 })

async function onPasteQuestion(e: ClipboardEvent) {
  const items = Array.from(e.clipboardData?.items || [])
  const imgItem = items.find(i => i.type.startsWith('image/'))
  if (!imgItem) return
  e.preventDefault()
  const blob = imgItem.getAsFile()
  if (!blob) return
  const b64 = await new Promise<string>(resolve => {
    const reader = new FileReader()
    reader.onload = ev => resolve((ev.target!.result as string).split(',')[1])
    reader.readAsDataURL(blob)
  })
  questionImgB64.value = b64
  questionImgSrc.value = 'data:image/png;base64,' + b64
  const result = await ocr.ocrB64(b64, 'question')
  if (result.text) question.value = question.value ? question.value + '\n' + result.text : result.text
  ocrStatus.value = ocr.ocrStatus.value
  ocrOk.value = ocr.ocrOk.value
}

async function onOcrFile(e: Event, type: 'question' | 'answer') {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const b64 = await new Promise<string>(resolve => {
    const reader = new FileReader()
    reader.onload = ev => resolve((ev.target!.result as string).split(',')[1])
    reader.readAsDataURL(file)
  })
  questionImgB64.value = b64
  questionImgSrc.value = 'data:image/png;base64,' + b64
  const result = await ocr.ocrImage(file, type)
  if (result.text) question.value = question.value ? question.value + '\n' + result.text : result.text
  if (result.imagePath) gradeStore.currentOcrImagePath = result.imagePath
  ocrStatus.value = ocr.ocrStatus.value
  ocrOk.value = ocr.ocrOk.value
  input.value = ''
}

function removeImg() {
  questionImgB64.value = null
  questionImgSrc.value = ''
}

async function searchForGrade() {
  const q = question.value.trim()
  if (!q) return
  searching.value = true
  statusText.value = '检索中...'
  statusOk.value = false
  statusErr.value = false
  try {
    const r = await apiFetch('api/search', { method: 'POST', body: JSON.stringify({ question: q }) })
    const data = await r.json()
    if (!data.found) {
      statusText.value = '未找到题目'
      statusErr.value = true
      return
    }
    gradeStore.gradeIndex = data.index
    statusText.value = `✓ #${data.index} ${data.subject} ${data.difficulty}`
    statusOk.value = true
    question.value = data.question || q
  } catch {
    statusText.value = '连接失败'
    statusErr.value = true
  } finally {
    searching.value = false
  }
}

function resetGrade() {
  gradeStore.gradeIndex = null
  gradeStore.gradeResult = ''
  question.value = ''
  questionImgB64.value = null
  questionImgSrc.value = ''
  statusText.value = ''
  statusOk.value = false
  statusErr.value = false
}

async function addMistake() {
  if (gradeStore.gradeIndex === null) return
  try {
    await apiFetch('api/mistakes', {
      method: 'POST',
      body: JSON.stringify({ index: gradeStore.gradeIndex }),
    })
    alert('已加入错题本')
  } catch { /* ignore */ }
}

function gradeToGuide() {
  if (!gradeStore.gradeIndex) return
  gradeStore.gradeContext = {
    studentAnswer: '',
    gradeResult: gradeStore.gradeResult || '',
  }
  router.push('/guide')
}
</script>
