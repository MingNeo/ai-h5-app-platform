<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router'
</script>

<template>
  <div class="min-h-screen flex flex-col bg-gray-50">
    <main class="flex-1">
      <RouterView />
    </main>
    <nav class="sticky bottom-0 flex border-t border-gray-200 bg-white pb-[env(safe-area-inset-bottom)]">
      <RouterLink to="/" class="flex-1 py-3 text-center text-sm text-gray-600" active-class="text-blue-600 font-600">
        首页
      </RouterLink>
      <RouterLink to="/about" class="flex-1 py-3 text-center text-sm text-gray-600" active-class="text-blue-600 font-600">
        关于
      </RouterLink>
    </nav>
  </div>
</template>
