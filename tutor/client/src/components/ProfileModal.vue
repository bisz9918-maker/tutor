<template>
  <div class="profile-overlay" @click.self="$emit('close')">
    <div class="profile-card">
      <h2>个人设置</h2>

      <div class="pf-field">
        <span class="pf-label">昵称</span>
        <input class="pf-input" v-model="form.nickname" placeholder="输入昵称" maxlength="30" />
      </div>

      <div class="pf-field">
        <span class="pf-label">年级</span>
        <div class="pf-chips">
          <span
            v-for="g in grades" :key="g"
            class="pf-chip" :class="{ selected: form.grade === g }"
            @click="form.grade = g"
          >{{ g }}</span>
        </div>
      </div>

      <div class="pf-field">
        <span class="pf-label">擅长科目</span>
        <div class="pf-chips">
          <span
            v-for="s in subjects" :key="s"
            class="pf-chip" :class="{ selected: form.favoriteSubjects.includes(s) }"
            @click="toggleSubject(s)"
          >{{ s }}</span>
        </div>
      </div>

      <div class="pf-field">
        <span class="pf-label">自评水平</span>
        <div class="pf-chips">
          <span
            v-for="l in levels" :key="l"
            class="pf-chip" :class="{ selected: form.selfLevel === l }"
            @click="form.selfLevel = l"
          >{{ l }}</span>
        </div>
      </div>

      <div class="pf-field">
        <span class="pf-label">辅导风格</span>
        <div class="pf-chips">
          <span
            v-for="st in styles" :key="st"
            class="pf-chip" :class="{ selected: form.guidingStyle === st }"
            @click="form.guidingStyle = st"
          >{{ st }}</span>
        </div>
      </div>

      <div class="pf-field">
        <span class="pf-label">学习目标</span>
        <textarea class="pf-textarea" v-model="form.learningGoal" placeholder="例如：期末数学提分到90+" maxlength="100" @input="goalLen = form.learningGoal.length"></textarea>
        <span class="pf-char-count">{{ goalLen }}/100</span>
      </div>

      <div class="pf-actions">
        <button class="btn btn-outline" @click="$emit('close')">取消</button>
        <button class="btn btn-primary" @click="save" :disabled="saving">{{ saving ? '保存中...' : '保存' }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { useAuthStore } from '../stores/auth'
import { apiFetch } from '../utils/api'

const authStore = useAuthStore()

const grades = ['初一', '初二', '初三', '高一', '高二', '高三']
const subjects = ['数学', '物理', '化学', '生物', '语文', '英语']
const levels = ['基础薄弱', '中等', '较好', '优秀']
const styles = ['详细讲解', '简洁直接', '苏格拉底式追问', '鼓励式']

const form = reactive({
  nickname: '',
  grade: '',
  favoriteSubjects: [] as string[],
  selfLevel: '',
  guidingStyle: '',
  learningGoal: '',
})
const goalLen = ref(0)
const saving = ref(false)
const emit = defineEmits<{ close: [] }>()

function toggleSubject(s: string) {
  const i = form.favoriteSubjects.indexOf(s)
  if (i >= 0) form.favoriteSubjects.splice(i, 1)
  else form.favoriteSubjects.push(s)
}

onMounted(async () => {
  try {
    const resp = await apiFetch('api/profile')
    if (resp.ok) {
      const p = await resp.json()
      form.nickname = p.nickname || ''
      form.grade = p.grade || ''
      form.favoriteSubjects = p.favoriteSubjects || []
      form.selfLevel = p.selfLevel || ''
      form.guidingStyle = p.guidingStyle || ''
      form.learningGoal = p.learningGoal || ''
      goalLen.value = form.learningGoal.length
    }
  } catch {}
})

async function save() {
  saving.value = true
  try {
    const resp = await apiFetch('api/profile', {
      method: 'PUT',
      body: JSON.stringify({ ...form }),
    })
    if (resp.ok) {
      const data = await resp.json()
      authStore.userProfile = data.profile || {}
      authStore.userProfile.nickname = form.nickname
      authStore.userProfile.grade = form.grade
      emit('close')
    } else {
      alert('保存失败，请重试')
    }
  } catch {
    alert('保存失败，请重试')
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.profile-overlay {
  position: fixed; inset: 0; z-index: 1100;
  background: rgba(10,10,40,.45);
  display: flex; align-items: center; justify-content: center;
}
</style>
