<template>
  <div class="topbar" id="guide-topbar">
    <div class="topbar-row">
      <button class="back-btn" @click="$router.push('/')">← 首页</button>
      <button v-if="searched" class="btn btn-secondary topbar-toggle" @click="toggleTopbar">{{ topbarCollapsed ? '↓ 展开' : '↑ 收起' }}</button>
    </div>
    <div id="topbar-collapsible" :class="{ collapsed: topbarCollapsed }">
      <textarea id="q-input" ref="qInputRef" v-model="question" placeholder="粘贴或输入题目文字...（可直接 Ctrl+V 粘贴截图）" @paste="onPaste" />
      <div class="topbar-row" style="gap:6px;">
        <label class="btn btn-secondary" style="cursor:pointer;margin:0;">
          📷 拍照识别题目
          <input type="file" accept="image/*" capture="environment" style="display:none" @change="onOcrFile" />
        </label>
        <span class="status" :class="{ ok: ocrOk, err: ocrStatus && !ocrOk }">{{ ocrStatus }}</span>
      </div>
      <div class="topbar-row">
        <button class="btn btn-primary" id="search-btn" @click="search" :disabled="searching">检索题目</button>
        <button class="btn btn-outline" id="reset-btn" v-if="searched" @click="reset">重置</button>
        <button class="btn btn-primary" id="guide-btn" v-if="searched && guideStore.hasDoc && !notMyQ" @click="startGuide">开始讲题</button>
        <button class="btn btn-outline" v-if="searched && guideStore.currentIndex !== null && !notMyQ" @click="goGrade">批改</button>
        <button class="btn btn-outline" id="gen-doc-btn" v-if="(searched && !guideStore.hasDoc) || notMyQ" @click="generateDoc" :disabled="generating">准备讲解材料</button>
        <button class="btn btn-outline" id="similar-cur-btn" v-if="searched" @click="$router.push('/similar')">相似题目</button>
        <button class="btn btn-mistake" id="guide-add-mistake-btn" v-if="searched" @click="addMistake">{{ mistakeBtnText }}</button>
        <button class="btn btn-secondary" id="not-my-btn" v-if="searched && guideStore.hasDoc && !notMyQ" @click="onNotMyQuestion">不是这个题目</button>
        <span class="status" id="match-info" :class="{ ok: statusOk, err: statusErr }">{{ statusText }}</span>
        <GenProgressBar :visible="generating" :percent="genPercent" :label="genLabel" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useGuideStore } from '../../stores/guide'
import { apiFetch } from '../../utils/api'
import { useOCR } from '../../composables/useOCR'
import GenProgressBar from './GenProgressBar.vue'

const router = useRouter()
const guideStore = useGuideStore()
const ocr = useOCR()
const emit = defineEmits<{ 'start-guide': [] }>()

const question = ref('')
const originalQuestion = ref('')
const originalOcrImagePath = ref<string | null>(null)
const searching = ref(false)
const searched = ref(false)
const statusText = ref('')
const statusOk = ref(false)
const statusErr = ref(false)
const generating = ref(false)
const genPercent = ref(0)
const genLabel = ref('')
const topbarCollapsed = ref(false)
const notMyQ = ref(false)
const mistakeBtnText = ref('加入错题本')
const ocrStatus = ref('')
const ocrOk = ref(false)
const qInputRef = ref<HTMLTextAreaElement | null>(null)

// When navigating from mistakes/similar with data already loaded, sync UI state
function syncFromStore() {
  if (guideStore.currentIndex !== null && guideStore.currentQuestion && !searched.value) {
    question.value = guideStore.currentQuestion
    searched.value = true
    statusOk.value = true
    statusText.value = `✓ #${guideStore.currentIndex} ${guideStore.currentKP.join('、')}`
    mistakeBtnText.value = '加入错题本'
    topbarCollapsed.value = true
  }
}
watch(() => guideStore.currentIndex, () => syncFromStore())
syncFromStore()

function toggleTopbar() {
  topbarCollapsed.value = !topbarCollapsed.value
}

async function onPaste(e: ClipboardEvent) {
  const items = Array.from(e.clipboardData?.items || [])
  const imgItem = items.find(i => i.type.startsWith('image/'))
  if (!imgItem) return
  e.preventDefault()
  const blob = imgItem.getAsFile()
  if (!blob) return
  ocrStatus.value = '识别中...'
  ocrOk.value = false
  const result = await ocr.ocrImage(blob, 'question')
  if (result.text) {
    question.value = question.value ? question.value + '\n' + result.text : result.text
  }
  ocrStatus.value = ocr.ocrStatus.value
  ocrOk.value = ocr.ocrOk.value
  if (result.imagePath) guideStore.currentOcrImagePath = result.imagePath
}

async function onOcrFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  ocrStatus.value = '识别中...'
  ocrOk.value = false
  const result = await ocr.ocrImage(file, 'question')
  if (result.text) {
    question.value = question.value ? question.value + '\n' + result.text : result.text
  }
  ocrStatus.value = ocr.ocrStatus.value
  ocrOk.value = ocr.ocrOk.value
  if (result.imagePath) guideStore.currentOcrImagePath = result.imagePath
  input.value = ''
}

async function search() {
  if (!question.value.trim()) return
  searching.value = true
  statusText.value = '检索中...'
  statusOk.value = false
  statusErr.value = false
  try {
    originalQuestion.value = question.value
    originalOcrImagePath.value = guideStore.currentOcrImagePath
    const result = await guideStore.searchQuestion(question.value)
    if (!result.found) {
      statusText.value = '未找到匹配题目，可用 AI 合成讲解'
      statusErr.value = true
      searched.value = true
      return
    }
    statusText.value = `✓ #${result.index} ${result.subject} ${result.difficulty} ${result.score}% ${guideStore.currentKP.join('、')}`
    statusOk.value = true
    question.value = guideStore.currentQuestion
    searched.value = true
    notMyQ.value = false
    mistakeBtnText.value = '加入错题本'
  } catch {
    statusText.value = '搜索失败'
    statusErr.value = true
  } finally {
    searching.value = false
  }
}

function reset() {
  guideStore.resetGuide()
  question.value = ''
  statusText.value = ''
  statusOk.value = false
  statusErr.value = false
  searched.value = false
  ocrStatus.value = ''
  ocrOk.value = false
  topbarCollapsed.value = false
  notMyQ.value = false
}

function startGuide() {
  topbarCollapsed.value = true
  emit('start-guide')
}

function goGrade() {
  if (guideStore.currentIndex !== null) {
    guideStore.gradeIndex = guideStore.currentIndex
  }
  guideStore.gradeQuestion = question.value || guideStore.currentQuestion
  router.push('/grade')
}

async function generateDoc() {
  if (!question.value.trim()) return
  generating.value = true
  genPercent.value = 5
  genLabel.value = '启动 AI 合成...'
  try {
    const resp = await apiFetch('api/generate-doc', {
      method: 'POST',
      body: JSON.stringify({ question: question.value, imagePath: guideStore.currentOcrImagePath }),
    })
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}))
      statusText.value = '请求失败：' + (err.error || resp.status)
      statusErr.value = true
      generating.value = false
      return
    }
    const { taskId } = await resp.json()
    if (!taskId) { statusText.value = '启动失败'; statusErr.value = true; generating.value = false; return }
    let pct = 10
    const poll = async () => {
      try {
        const r = await apiFetch(`api/generate-doc/status/${taskId}`)
        if (r.status === 404) { statusText.value = '任务不存在，请重试'; statusErr.value = true; generating.value = false; return }
        const st = await r.json()
        if (st.status === 'done') {
          if (!st.hasDoc) { statusText.value = '生成失败，未产生讲解文件，请重试'; statusErr.value = true; generating.value = false; return }
          genPercent.value = 100
          genLabel.value = '完成！'
          guideStore.currentIndex = st.index
          guideStore.currentScenes = st.scenes || []
          guideStore.currentQuestion = st.question || question.value
          statusText.value = '✓ 讲解材料已准备好，可以开始讲题'
          statusOk.value = true
          setTimeout(() => { generating.value = false }, 1000)
        } else if (st.status === 'error') {
          statusText.value = '失败：' + st.msg
          statusErr.value = true
          generating.value = false
        } else {
          pct = Math.min(pct + 5, 90)
          genPercent.value = pct
          genLabel.value = st.msg || '生成中...'
          statusText.value = st.msg || '生成中...'
          setTimeout(poll, 3000)
        }
      } catch {
        setTimeout(poll, 3000)
      }
    }
    setTimeout(poll, 2000)
  } catch (e: any) {
    statusText.value = '请求失败：' + e.message
    statusErr.value = true
    generating.value = false
  }
}

function onNotMyQuestion() {
  question.value = originalQuestion.value
  guideStore.currentOcrImagePath = originalOcrImagePath.value
  statusText.value = '将为你的题目准备专属讲解材料'
  statusOk.value = false
  statusErr.value = false
  notMyQ.value = true
  guideStore.currentIndex = null
  guideStore.currentScenes = []
  guideStore.currentKP = []
  guideStore.currentQuestion = ''
}

async function addMistake() {
  const idx = guideStore.currentIndex
  const q = question.value.trim()
  mistakeBtnText.value = '保存中...'
  try {
    const body: any = {}
    if (idx !== null) body.index = idx
    else if (q) { body.question = q; body.imagePath = guideStore.currentOcrImagePath || undefined }
    await apiFetch('api/mistakes', { method: 'POST', body: JSON.stringify(body) })
    mistakeBtnText.value = '✓ 已加入'
  } catch {
    mistakeBtnText.value = '加入错题本'
  }
}
</script>
