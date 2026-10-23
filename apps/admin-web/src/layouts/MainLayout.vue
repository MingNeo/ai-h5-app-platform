<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '../stores/user'

const user = useUserStore()
const route = useRoute()
const router = useRouter()
const active = computed(() => route.path)

async function logout() {
  await user.logout()
  await router.push('/login')
}
</script>

<template>
  <div class="h-full flex flex-col">
    <header class="h-56px flex items-center px-6 border-b border-[var(--border)] bg-white gap-6">
      <router-link to="/" class="text-16px font-600 text-inherit no-underline">
        H5 应用平台
      </router-link>
      <el-menu mode="horizontal" :default-active="active" router class="flex-1 !border-none" :ellipsis="false">
        <el-menu-item index="/">
          我的应用
        </el-menu-item>
        <template v-if="user.me?.isPlatformAdmin">
          <el-menu-item index="/admin/grants">
            能力审批
          </el-menu-item>
          <el-menu-item index="/admin/biz-apis">
            业务接口目录
          </el-menu-item>
          <el-menu-item index="/admin/audit">
            操作日志
          </el-menu-item>
          <el-menu-item index="/admin/api-clients">
            开放接口
          </el-menu-item>
        </template>
      </el-menu>
      <el-dropdown>
        <div class="flex items-center gap-2 cursor-pointer">
          <el-avatar :size="28" :src="user.me?.avatar">
            {{ user.me?.name?.slice(0, 1) }}
          </el-avatar>
          <span>{{ user.me?.name }}</span>
        </div>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item @click="logout">
              退出登录
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </header>
    <main class="flex-1 overflow-auto bg-[var(--bg-soft)]">
      <router-view />
    </main>
  </div>
</template>
