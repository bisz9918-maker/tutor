<template>
  <div class="view" id="view-grade">
    <GradeTopbar />
    <GradeResult :show-input="showInput" @graded="onGraded" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useGuideStore } from '../stores/guide'
import GradeTopbar from '../components/grade/GradeTopbar.vue'
import GradeResult from '../components/grade/GradeResult.vue'

const guideStore = useGuideStore()
const showInput = ref(false)

onMounted(() => {
  showInput.value = true
})

function onGraded(result: string) {
  guideStore.gradeResult = result
}
</script>
