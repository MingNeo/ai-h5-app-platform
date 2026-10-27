import { mkdirSync } from 'node:fs'
import { buildApp } from './app'
import { config } from './config'
import { closeMongo, connectMongo } from './lib/mongo'
import { initStore, store } from './lib/store'
import { recoverTurns } from './modules/agent/runner'
import { syncPlatformAdmins } from './modules/admin/auth'
import { startBuildWorker } from './modules/build/service'

async function main() {
  mkdirSync(config.dataDir, { recursive: true })
  initStore()
  await connectMongo()
  await syncPlatformAdmins()
  const app = await buildApp()
  await app.listen({ port: config.port, host: config.host })
  app.log.info(`平台服务已启动 :${config.port}，基础域名 ${config.baseDomain}，登录模式 ${config.auth.provider}，模型 ${config.llm.provider}`)

  if (config.roles.has('build'))
    await startBuildWorker()
  if (config.roles.has('api'))
    await recoverTurns()

  const shutdown = async (signal: string) => {
    app.log.info(`收到 ${signal}，正在关闭`)
    const timer = setTimeout(() => process.exit(1), 10_000)
    await app.close().catch(() => {})
    await store.close()
    await closeMongo()
    clearTimeout(timer)
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
