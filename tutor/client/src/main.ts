import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import { useAuthStore } from './stores/auth'
import './style.css'

const routes = [
  { path: '/', name: 'home', component: () => import('./views/HomeRoute.vue') },
  { path: '/guide', name: 'guide', component: () => import('./views/GuideRoute.vue') },
  { path: '/grade', name: 'grade', component: () => import('./views/GradeRoute.vue') },
  { path: '/similar', name: 'similar', component: () => import('./views/SimilarRoute.vue') },
  { path: '/mistakes', name: 'mistakes', component: () => import('./views/MistakesRoute.vue') },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach((to) => {
  const auth = useAuthStore()
  if (!auth.loggedIn && to.name !== 'home') {
    return { name: 'home' }
  }
})

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
