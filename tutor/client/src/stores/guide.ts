import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { apiFetch } from '../utils/api'
import { extractSceneNames, extractKeypoints, stripMarkers } from '../utils/markers'
import { cleanLatex, escapeHtml } from '../utils/latex'

export interface Scene {
  name: string
  url: string
  isHtml: boolean
}

export const useGuideStore = defineStore('guide', () => {
  const currentIndex = ref<number | null>(null)
  const currentQuestion = ref('')
  const currentScenes = ref<Scene[]>([])
  const currentKP = ref<string[]>([])
  const currentOcrImagePath = ref<string | null>(null)
  const activeSceneName = ref<string | null>(null)
  const shownScenes = ref(new Set<string>())
  const streaming = ref(false)
  const history = ref<{ role: string; content: string }[]>([])
  const gradeIndex = ref<number | null>(null)
  const gradeResult = ref('')
  const gradeQuestion = ref('')
  const gradeQImageB64 = ref<string | null>(null)
  const gradeContext = ref<{ studentAnswer: string; gradeResult: string } | null>(null)
  const keypoints = ref<string[]>([])

  const hasDoc = computed(() => currentScenes.value.length > 0)

  async function searchQuestion(question: string) {
    const resp = await apiFetch('api/search', {
      method: 'POST',
      body: JSON.stringify({ question }),
    })
    const data = await resp.json()
    if (!data.found) return { found: false as const }
    currentIndex.value = data.index
    currentQuestion.value = data.question
    currentScenes.value = data.scenes || []
    currentKP.value = data.knowledge_point || []
    currentOcrImagePath.value = data.problemImgUrl || null
    return { found: true as const, ...data }
  }

  async function loadAndGo(index: number) {
    const resp = await apiFetch('api/load', {
      method: 'POST',
      body: JSON.stringify({ index }),
    })
    const data = await resp.json()
    currentIndex.value = data.index
    currentQuestion.value = data.question
    currentScenes.value = data.scenes || []
    currentKP.value = data.knowledge_point || []
    currentOcrImagePath.value = data.problemImgUrl || null
    return data
  }

  function showScene(name: string) {
    shownScenes.value.add(name)
    activeSceneName.value = name
  }

  async function addMistake(body: { index?: number; question?: string; imagePath?: string; studentAnswer?: string; gradeResult?: string; note?: string }) {
    await apiFetch('api/mistakes', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  }

  function resetGuide() {
    currentIndex.value = null
    currentScenes.value = []
    currentKP.value = []
    currentQuestion.value = ''
    currentOcrImagePath.value = null
    activeSceneName.value = null
    shownScenes.value = new Set()
    streaming.value = false
    history.value = []
    gradeIndex.value = null
    gradeResult.value = ''
    gradeQuestion.value = ''
    gradeQImageB64.value = null
    gradeContext.value = null
    keypoints.value = []
  }

  return {
    currentIndex, currentQuestion, currentScenes, currentKP, currentOcrImagePath,
    activeSceneName, shownScenes, streaming, history, gradeIndex, gradeResult,
    gradeQImageB64, gradeQuestion, gradeContext, keypoints, hasDoc,
    searchQuestion, loadAndGo, showScene, resetGuide, addMistake,
  }
})
