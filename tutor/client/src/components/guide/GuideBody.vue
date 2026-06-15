<template>
  <div class="guide-body" id="guide-body">
    <!-- Problem panel (visible once question loaded) -->
    <div class="guide-problem-standalone" v-if="questionReady && !guideStarted">
      <ProblemPanel />
      <div class="guide-standalone-actions">
        <button class="btn btn-primary guide-action-btn" v-if="guideStore.hasDoc" @click="startGuide">去讲解</button>
      </div>
    </div>

    <!-- Top panel: problem + scene (visible once guide started) -->
    <div class="guide-top" id="guide-top" :class="{ visible: guideStarted, collapsed: collapsed }">
      <ProblemPanel />
      <SceneViewer />
    </div>

    <!-- Collapse bar -->
    <div class="guide-collapse-bar" :class="{ visible: guideStarted }">
      <button class="collapse-btn" @click="collapsed = !collapsed">
        {{ collapsed ? '展开 ▼' : '收起 ▲' }}
      </button>
    </div>

    <!-- Practice view overlay -->
    <PracticeView :visible="practiceVisible" @switch-to-guide="switchToGuide" />

    <!-- Teacher FAB -->
    <TeacherFab :visible="fabVisible && !sidebarOpen" :avatar-src="fabAvatar" @click="chatSidebar?.toggle()" />

    <!-- Chat sidebar -->
    <ChatSidebar ref="chatSidebar" />

    <!-- Input bar -->
    <InputBar :visible="inputVisible" @send="onSend" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useGuideStore } from '../../stores/guide'
import { useChat } from '../../composables/useChat'
import { useTTS } from '../../composables/useTTS'
import { useMathJax } from '../../composables/useMathJax'
import ProblemPanel from './ProblemPanel.vue'
import SceneViewer from './SceneViewer.vue'
import PracticeView from './PracticeView.vue'
import TeacherFab from './TeacherFab.vue'
import ChatSidebar from './ChatSidebar.vue'
import InputBar from './InputBar.vue'

const router = useRouter()
const guideStore = useGuideStore()
const tts = useTTS()
const chat = useChat(tts)
const { typeset } = useMathJax()

const collapsed = ref(false)
const practiceVisible = ref(false)
const inputVisible = ref(false)
const fabVisible = ref(false)
const guideStarted = ref(false)
const questionReady = computed(() => guideStore.currentQuestion.length > 0)
const fabAvatar = computed(() => {
  if (chat.streaming.value) return avatarThinking
  if (tts.isPlaying.value || tts.isLoading.value) return avatarExplaining
  return avatarListening
})
const chatSidebar = ref<InstanceType<typeof ChatSidebar> | null>(null)
const sidebarOpen = computed(() => chatSidebar.value?.isOpen ?? false)

const avatarExplaining = '/teacher_explaining.svg'
const avatarListening = '/teacher_listening.svg'
const avatarThinking = '/teacher_thinking.svg'

function showPractice() {
  practiceVisible.value = true
  inputVisible.value = false
  chatSidebar.value?.close()
}

function showGuide() {
  practiceVisible.value = false
  inputVisible.value = true
  fabVisible.value = true
  chatSidebar.value?.open()
}

async function startGuide() {
  practiceVisible.value = false
  guideStarted.value = true
  fabVisible.value = true
  inputVisible.value = true
  guideStore.history = []
  if (guideStore.currentScenes.length > 0) {
    guideStore.showScene(guideStore.currentScenes[0].name)
  }
  let prompt = '请开始引导学生解题。先简单介绍这道题的核心考查点，然后提出第一个引导问题。'
  if (guideStore.gradeContext) {
    prompt = '学生刚刚做了这道题的批改，以下是学生的作答和批改结果，请根据批改中发现的问题，有针对性地引导学生理解错误并掌握正确解法。\n\n【学生作答】\n' + guideStore.gradeContext.studentAnswer + '\n\n【批改结果】\n' + guideStore.gradeContext.gradeResult
    guideStore.gradeContext = null
  }
  await chat.sendMessage(prompt)
}

async function switchToGuide() {
  practiceVisible.value = false
  inputVisible.value = true
  chatSidebar.value?.open()
  if (guideStore.history.length === 0) {
    await chat.sendMessage('请开始引导学生解题。先简单介绍这道题的核心考查点，然后提出第一个引导问题。')
  }
}

async function onSend(text: string) {
  tts.stopCurrentAudio()
  await chat.sendMessage(text)
}

function goGrade() {
  if (guideStore.currentIndex !== null) {
    guideStore.gradeIndex = guideStore.currentIndex
  }
  guideStore.gradeQuestion = guideStore.currentQuestion
  router.push('/grade')
}

function resetGuide() {
  practiceVisible.value = false
  inputVisible.value = false
  fabVisible.value = false
  guideStarted.value = false
  chatSidebar.value?.close()
}

defineExpose({ startGuide, showPractice, showGuide, resetGuide })
</script>
