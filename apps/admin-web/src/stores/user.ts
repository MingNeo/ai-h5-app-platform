import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api, clearToken } from '../api'

export interface Me {
  id: string
  name: string
  avatar: string
  email: string
  isPlatformAdmin: boolean
}

export const useUserStore = defineStore('user', () => {
  const me = ref<Me | null>(null)
  const loaded = ref(false)

  async function load() {
    try {
      me.value = await api<Me>('/auth/me', { quiet: true })
    }
    catch {
      me.value = null
    }
    loaded.value = true
    return me.value
  }

  async function logout() {
    try {
      await api('/auth/logout', { method: 'POST', body: {} })
    }
    finally {
      clearToken()
      me.value = null
      // 主动登出后不要立刻被登录页的静默 SSO 再登回来
      sessionStorage.setItem('adm_login_tried', '1')
    }
  }

  return { me, loaded, load, logout }
})
