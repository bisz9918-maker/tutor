<template>
  <div class="view" id="view-mistakes">
    <div class="topbar">
      <div class="topbar-row">
        <button class="back-btn" @click="$router.push('/')">← 返回</button>
        <span class="topbar-title">错题本</span>
        <span class="status" v-if="mistakes.length">{{ mistakes.length }} 道错题</span>
      </div>
    </div>
    <div class="mistakes-body" id="mistakes-body">
      <div v-if="!mistakes.length" class="placeholder">错题本为空，在「题目解答」或「题目批改」中点击「加入错题本」</div>
      <MistakeCard
        v-for="m in mistakes"
        :key="m.id"
        :m="m"
        @click="openDetail(m)"
      />
    </div>
    <MistakeDetail
      :visible="detailVisible"
      :mistake="currentMistake"
      @close="detailVisible = false"
      @generate="onGenerate"
      @go-guide="onGoGuide"
      @delete="onDelete"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useGuideStore } from '../stores/guide'
import { apiFetch } from '../utils/api'
import MistakeCard from '../components/mistakes/MistakeCard.vue'
import MistakeDetail from '../components/mistakes/MistakeDetail.vue'

const router = useRouter()
const guideStore = useGuideStore()

const mistakes = ref<any[]>([])
const detailVisible = ref(false)
const currentMistake = ref<any | null>(null)

onMounted(() => { loadMistakesList() })

async function loadMistakesList() {
  try {
    const r = await apiFetch('api/mistakes')
    mistakes.value = await r.json()
  } catch {
    mistakes.value = []
  }
}

function openDetail(m: any) {
  currentMistake.value = m
  detailVisible.value = true
}

async function onGenerate(mistake: any) {
  if (!mistake) return
  mistake._generating = true
  try {
    const resp = await apiFetch('api/generate-doc', {
      method: 'POST',
      body: JSON.stringify({ question: mistake.question, imagePath: mistake.imagePath }),
    })
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}))
      alert('请求失败：' + (err.error || resp.status))
      mistake._generating = false
      return
    }
    let { taskId } = await resp.json()
    if (!taskId) { alert('启动失败'); mistake._generating = false; return }
    const poll = async () => {
      try {
        const r = await apiFetch(`api/generate-doc/status/${taskId}`)
        if (r.status === 404) {
          // Task lost (e.g. server restart) — re-trigger generation
          const reResp = await apiFetch('api/generate-doc', {
            method: 'POST',
            body: JSON.stringify({ question: mistake.question, imagePath: mistake.imagePath }),
          })
          if (reResp.ok) {
            const reData = await reResp.json()
            if (reData.taskId) { taskId = reData.taskId; setTimeout(poll, 2000); return }
          }
          alert('任务不存在，请重试'); mistake._generating = false; return
        }
        const st = await r.json()
        if (st.status === 'done') {
          mistake.hasDoc = true
          mistake._generating = false
          detailVisible.value = false
          loadMistakesList()
        } else if (st.status === 'error') {
          alert('生成失败：' + (st.msg || ''))
          mistake._generating = false
        } else {
          setTimeout(poll, 3000)
        }
      } catch { setTimeout(poll, 3000) }
    }
    setTimeout(poll, 2000)
  } catch (e: any) {
    alert('请求失败：' + e.message)
    mistake._generating = false
  }
}

async function onGoGuide(mistake: any) {
  if (!mistake) return
  detailVisible.value = false
  await guideStore.loadAndGo(mistake.index)
  router.push('/guide')
}

async function onDelete(id: string | undefined) {
  if (!id || !confirm('确认移出错题本？')) return
  await apiFetch(`api/mistakes/${id}`, { method: 'DELETE' })
  detailVisible.value = false
  loadMistakesList()
}
</script>
