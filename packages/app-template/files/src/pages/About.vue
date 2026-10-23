<template>
  <div class="p-6 flex flex-col gap-3">
    <h1 class="text-xl font-bold">
      关于
    </h1>
    <p class="text-sm text-gray-500">
      这是子路由页面：路径 <code>/about</code>，由布局路由下的 <code>children</code> 渲染。
    </p>
    <RouterLink to="/" class="text-blue-600 text-sm">
      返回首页
    </RouterLink>
  </div>
</template>
