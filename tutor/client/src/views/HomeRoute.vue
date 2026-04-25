<template>
  <div class="view active home-view" id="view-home">
    <div class="home-welcome">
      <h1>AI 讲题助手</h1>
      <p>智能引导解题，让每道题都成为进步的阶梯</p>
    </div>
    <div class="home-cards">
      <div class="home-btn" @click="$router.push('/guide')">
        <img src="/teacher_explaining.svg" class="home-btn-icon" />
        <span class="home-btn-label">AI 引导讲题</span>
      </div>
      <div class="home-btn" @click="$router.push('/grade')">
        <img src="/question_answer.svg" class="home-btn-icon" />
        <span class="home-btn-label">拍照批改</span>
      </div>
      <div class="home-btn" @click="$router.push('/similar')">
        <img src="/exercise.svg" class="home-btn-icon" />
        <span class="home-btn-label">刷题练习</span>
      </div>
      <div class="home-btn" @click="$router.push('/mistakes')">
        <img src="/revision.svg" class="home-btn-icon" />
        <span class="home-btn-label">错题本</span>
      </div>
    </div>
  </div>
</template>
