<script setup lang="ts">
import { onMounted, ref } from 'vue'

const user = ref(platform.auth.user)

onMounted(async () => {
  await platform.ready()
  user.value = platform.auth.user
  platform.auth.onChange((u) => {
    user.value = u
  })
})

async function login() {
  try {
    await platform.auth.login()
  }
  catch {}
}
</script>

<template>
  <div class="min-h-screen flex flex-col items-center justify-center gap-4 p-6 bg-gray-50">
    <h1 class="text-2xl font-bold text-gray-800">
      新应用
    </h1>
    <p class="text-gray-500 text-sm">
      在后台对话框里描述你想要的功能，AI 会帮你生成页面。
    </p>
    <div v-if="user" class="flex items-center gap-2">
      <img :src="user.avatar" class="w-8 h-8 rounded-full" alt="">
      <span>{{ user.nickname }}</span>
    </div>
    <van-button v-else type="primary" round @click="login">
      登录
    </van-button>
  </div>
</template>
