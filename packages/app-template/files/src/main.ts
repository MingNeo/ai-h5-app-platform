import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import 'vant/lib/index.css'
import 'virtual:uno.css'
import './styles/main.css'

createApp(App).use(router).mount('#app')
