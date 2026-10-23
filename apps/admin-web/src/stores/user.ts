import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '../api'

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
    await api('/auth/logout', { method: 'POST', body: {} })
    me.value = null
  }

  return { me, loaded, load, logout }
})
