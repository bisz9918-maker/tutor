<template>
  <div class="view active" id="view-guide">
    <GuideTopbar @start-guide="onStartGuide" />
    <GuideBody ref="guideBody" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useGuideStore } from '../stores/guide'
import GuideTopbar from '../components/guide/GuideTopbar.vue'
import GuideBody from '../components/guide/GuideBody.vue'

const route = useRoute()
const guideStore = useGuideStore()
const guideBody = ref<InstanceType<typeof GuideBody> | null>(null)

function onStartGuide() {
  guideBody.value?.startGuide()
}

onMounted(() => {
  // Data already loaded from mistakes/similar — just show the question, don't auto-start
})
</script>
