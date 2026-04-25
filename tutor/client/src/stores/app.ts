import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useAppStore = defineStore('app', () => {
  const currentView = ref('home')

  function enterView(name: string) {
    currentView.value = name
  }

  return { currentView, enterView }
})
