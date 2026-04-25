import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface MistakeRecord {
  id: string
  index: number
  subject: string
  type: string
  difficulty: string
  knowledge_point: string[]
  question: string
  studentAnswer?: string
  gradeResult?: string
  addedAt: string
  note?: string
  hasDoc?: boolean
}

export const useMistakesStore = defineStore('mistakes', () => {
  const list = ref<MistakeRecord[]>([])
  const loading = ref(false)

  async function loadList() {
    loading.value = true
    try {
      const resp = await apiFetch('api/mistakes')
      if (resp.ok) list.value = await resp.json()
    } finally {
      loading.value = false
    }
  }

  async function deleteMistake(id: string) {
    await apiFetch(`api/mistakes/${id}`, { method: 'DELETE' })
    list.value = list.value.filter(m => m.id !== id)
  }

  async function addMistake(data: { index?: number; question?: string; imagePath?: string; studentAnswer?: string; gradeResult?: string; note?: string }) {
    const resp = await apiFetch('api/mistakes', {
      method: 'POST',
      body: JSON.stringify(data),
    })
    return resp.json()
  }

  return { list, loading, loadList, deleteMistake, addMistake }
})

import { apiFetch } from '../utils/api'
