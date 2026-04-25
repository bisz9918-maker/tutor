<template>
  <div class="view" id="view-similar">
    <div class="topbar">
      <div class="topbar-row">
        <button class="back-btn" @click="$router.push('/')">← 返回</button>
        <span class="topbar-title">出题练习</span>
      </div>
      <div class="topbar-row">
        <div class="search-bar">
          <input type="text" id="kp-input" v-model="kpInput" placeholder="输入知识点，例如：杠杆的平衡条件" @keyup.enter="findSimilar('kp')" />
        </div>
        <button class="btn btn-primary" @click="findSimilar('kp')">按知识点出题</button>
        <span class="status" :class="{ ok: statusOk, err: statusErr }">{{ statusText }}</span>
      </div>
    </div>
    <div class="similar-body" id="similar-body">
      <div v-if="breadcrumb" class="browse-breadcrumb" v-html="breadcrumb"></div>
      <div id="browse-content">
        <SubjectGrid v-if="view === 'subjects'" :subjects="subjects" @select="showSubjectQuestions" />
        <KpGrid v-else-if="view === 'results'" :title="resultTitle" :results="results" empty-text="暂无题目" @select="loadAndGo" />
        <div v-else class="placeholder">加载中...</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useGuideStore } from '../stores/guide'
import { apiFetch } from '../utils/api'
import { useMathJax } from '../composables/useMathJax'
import SubjectGrid from '../components/similar/SubjectGrid.vue'
import KpGrid from '../components/similar/KpGrid.vue'

const router = useRouter()
const guideStore = useGuideStore()
const { typeset } = useMathJax()

const kpInput = ref('')
const statusText = ref('')
const statusOk = ref(false)
const statusErr = ref(false)
const view = ref<'subjects' | 'results' | 'loading'>('loading')
const subjects = ref<{ subject: string; label: string; count: number }[]>([])
const results = ref<any[]>([])
const resultTitle = ref('')
const breadcrumb = ref('')

onMounted(async () => {
  try {
    const r = await apiFetch('api/subjects')
    const d = await r.json()
    subjects.value = d.subjects || []
    view.value = 'subjects'
  } catch {
    view.value = 'subjects'
  }
})

async function showSubjectQuestions(subject: string) {
  const s = subjects.value.find(x => x.subject === subject)
  breadcrumb.value = `<span class="crumb" style="cursor:pointer">全部学科</span> › <span>${s?.label || subject}</span>`
  view.value = 'loading'
  statusText.value = ''
  try {
    const r = await apiFetch('api/similar', { method: 'POST', body: JSON.stringify({ subject }) })
    const data = await r.json()
    if (!data.results?.length) {
      results.value = []
      resultTitle.value = s?.label || subject
      view.value = 'results'
      return
    }
    statusText.value = `共 ${data.results.length} 道`
    statusOk.value = true
    results.value = data.results
    resultTitle.value = s?.label || subject
    view.value = 'results'
    setTimeout(() => typeset(document.getElementById('browse-content')), 50)
  } catch {
    results.value = []
    view.value = 'results'
  }
}

async function findSimilar(mode: string) {
  statusText.value = '搜索中...'
  statusOk.value = false
  statusErr.value = false
  let reqBody: any = {}
  if (mode === 'kp') {
    const kp = kpInput.value.trim()
    if (!kp) { statusText.value = '请输入知识点'; statusErr.value = true; return }
    reqBody = { knowledge_point: kp.split(/[,，、;；]+/).map(s => s.trim()).filter(Boolean), topN: 8 }
  } else {
    if (guideStore.currentIndex === null) return
    reqBody = { index: guideStore.currentIndex, topN: 8 }
  }
  try {
    const r = await apiFetch('api/similar', { method: 'POST', body: JSON.stringify(reqBody) })
    const data = await r.json()
    if (!data.results?.length) { statusText.value = '未找到相关题目'; statusErr.value = true; return }
    statusText.value = `共 ${data.results.length} 道`
    statusOk.value = true
    breadcrumb.value = '<span class="crumb" style="cursor:pointer">全部学科</span> › <span>搜索结果</span>'
    results.value = data.results
    resultTitle.value = '搜索结果'
    view.value = 'results'
    setTimeout(() => typeset(document.getElementById('browse-content')), 50)
  } catch {
    statusText.value = '请求失败'
    statusErr.value = true
  }
}

async function loadAndGo(index: number) {
  await guideStore.loadAndGo(index)
  router.push('/guide')
}
</script>
