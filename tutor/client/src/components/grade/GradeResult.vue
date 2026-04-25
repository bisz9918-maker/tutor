<template>
  <div class="grade-body" id="grade-body">
    <div v-if="!showInput" class="placeholder" id="grade-placeholder">请输入题目和答案，或检索题目后批改</div>
    <div v-else id="grade-input-wrap" style="display:flex;flex-direction:column;gap:10px;">
      <textarea
        id="grade-input"
        v-model="answer"
        placeholder="在此输入你的解题过程和答案...（可 Ctrl+V 粘贴解题过程截图）"
        @paste="onPasteAnswer"
      ></textarea>
      <div class="topbar-row" style="gap:6px;">
        <label class="btn btn-secondary" style="cursor:pointer;margin:0;">
          📷 拍照识别解题过程
          <input type="file" accept="image/*" capture="environment" style="display:none" @change="onOcrAnswer" />
        </label>
        <span class="status" :class="{ ok: ocrAnsOk }">{{ ocrAnsStatus }}</span>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-success" @click="doGrade" :disabled="grade.streaming.value">提交批改</button>
        <button class="btn btn-secondary" @click="answer = ''">清空</button>
      </div>
      <div class="grade-result" v-if="grade.resultHtml.value" v-html="grade.resultHtml.value"></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useGuideStore } from '../../stores/guide'
import { useGrade } from '../../composables/useGrade'
import { useOCR } from '../../composables/useOCR'
import { useMathJax } from '../../composables/useMathJax'

const props = defineProps<{ showInput: boolean }>()
const emit = defineEmits<{ graded: [result: string] }>()

const gradeStore = useGuideStore()
const grade = useGrade()
const ocr = useOCR()
const { typeset } = useMathJax()

const answer = ref('')
const ocrAnsStatus = ref('')
const ocrAnsOk = ref(false)

async function onPasteAnswer(e: ClipboardEvent) {
  const items = Array.from(e.clipboardData?.items || [])
  const imgItem = items.find(i => i.type.startsWith('image/'))
  if (!imgItem) return
  e.preventDefault()
  const blob = imgItem.getAsFile()
  if (!blob) return
  ocrAnsStatus.value = '识别中...'
  const result = await ocr.ocrImage(blob, 'answer')
  if (result.text) answer.value = answer.value ? answer.value + '\n' + result.text : result.text
  ocrAnsStatus.value = ocr.ocrStatus.value
  ocrAnsOk.value = ocr.ocrOk.value
}

async function onOcrAnswer(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const result = await ocr.ocrImage(file, 'answer')
  if (result.text) answer.value = answer.value ? answer.value + '\n' + result.text : result.text
  ocrAnsStatus.value = ocr.ocrStatus.value
  ocrAnsOk.value = ocr.ocrOk.value
  input.value = ''
}

async function doGrade() {
  const ans = answer.value.trim()
  if (!ans) { alert('请先输入或拍照识别你的答案'); return }
  const hasIndex = gradeStore.gradeIndex !== null
  const hasQuestion = gradeStore.gradeQuestion.trim().length > 0
  if (!hasIndex && !hasQuestion) {
    alert('请先输入或拍照识别题目')
    return
  }
  const body = hasIndex
    ? { index: gradeStore.gradeIndex!, studentAnswer: ans }
    : { question: gradeStore.gradeQuestion, questionImage: gradeStore.gradeQImageB64 || undefined, studentAnswer: ans }
  const result = await grade.gradeAnswer(body)
  if (result) {
    gradeStore.gradeResult = result
    emit('graded', result)
    setTimeout(() => {
      const el = document.querySelector('.grade-result')
      if (el) typeset(el as HTMLElement)
    }, 50)
  }
}
</script>
