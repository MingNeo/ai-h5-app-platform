<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, setToken } from '../api'
import { useUserStore } from '../stores/user'

interface DevUser { id: string, name: string, email: string, avatar: string, isPlatformAdmin: boolean }

const route = useRoute()
const router = useRouter()
const user = useUserStore()
const options = ref<{ feishu: boolean, devBypass: boolean, devUsers: DevUser[] } | null>(null)
const devChoice = ref(localStorage.getItem('adm_dev_choice') ?? '')
const loading = ref(false)

const redirect = () => (typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/') ? route.query.redirect : '/')

const LOGIN_TRIED = 'adm_login_tried'

onMounted(async () => {
  if (await user.load())
    return router.replace(redirect())
  options.value = await api('/auth/options')
  // 上次选过的人优先；否则默认最近登录的账号
  if (options.value?.devBypass && !devChoice.value && options.value.devUsers?.length)
    devChoice.value = `u:${options.value.devUsers[0]!.id}`
  // token 只存在内存，刷新后丢一次；先试恢复 cookie 免跳飞书，没有才走飞书静默登录；失败/取消后不再自动跳
  if (options.value?.feishu && !options.value.devBypass && !sessionStorage.getItem(LOGIN_TRIED)) {
    sessionStorage.setItem(LOGIN_TRIED, '1')
    location.href = `/admin-api/auth/resume?next=${encodeURIComponent(redirect())}`
  }
})

function feishuLogin() {
  location.href = `/admin-api/auth/feishu/login?redirect=${encodeURIComponent(redirect())}`
}

function devLabel(u: DevUser) {
  return `${u.name}${u.email ? ` · ${u.email}` : ''}${u.isPlatformAdmin ? ' · 平台管理员' : ''}`
}

async function devLogin() {
  loading.value = true
  try {
    const raw = devChoice.value.trim()
    // u:<id> 选已有账号；其他视为新名字
    const body = raw.startsWith('u:') ? { userId: raw.slice(2) } : { name: raw || '本地开发者' }
    const res = await api<{ token: string }>('/auth/dev-login', { body })
    localStorage.setItem('adm_dev_choice', raw)
    setToken(res.token)
    sessionStorage.removeItem(LOGIN_TRIED)
    await user.load()
    await router.replace(redirect())
  }
  finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="h-full flex items-center justify-center bg-[var(--bg-soft)]">
    <div class="w-380px bg-white rounded-2xl shadow-sm p-10 flex flex-col gap-5">
      <div>
        <div class="text-22px font-600">
          H5 应用平台
        </div>
        <div class="text-[var(--muted)] mt-1">
          用对话生成 H5 应用
        </div>
      </div>
      <template v-if="options">
        <el-button v-if="options.feishu" type="primary" size="large" @click="feishuLogin">
          飞书登录
        </el-button>
        <template v-if="options.devBypass">
          <el-divider v-if="options.feishu">
            本地开发
          </el-divider>
          <el-select
            v-model="devChoice" filterable allow-create default-first-option clearable
            placeholder="选择账号，或输入新名字" size="large" class="w-full"
          >
            <el-option v-for="u in options.devUsers" :key="u.id" :value="`u:${u.id}`" :label="devLabel(u)" />
          </el-select>
          <el-button size="large" :loading="loading" @click="devLogin">
            本地免登进入
          </el-button>
        </template>
        <el-alert v-if="!options.feishu && !options.devBypass" type="warning" :closable="false" title="未配置登录方式" description="请配置 FEISHU_APP_ID，或本地开发时开启 DEV_ADMIN_BYPASS=1" />
      </template>
    </div>
  </div>
</template>
