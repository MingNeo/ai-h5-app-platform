// 初始化本地演示数据：开发者账号 + demo 投票应用（生成测试版并上线）
import { config } from '../config'
import { initDraft, writeDraft } from '../core/drafts'
import { MANIFEST, VOTE_PAGE } from '../lib/llm-mock'
import { closeMongo, col, connectMongo } from '../lib/mongo'
import { initStore } from '../lib/store'
import { newId } from '../lib/tokens'
import { kickBuilds, release, requestBuild } from '../modules/build/service'

const APP_ID = process.argv[2] || 'demo'

async function main() {
  initStore()
  await connectMongo()
  let user = await col.adminUsers.findOne({ feishuOpenId: 'dev:本地开发者' })
  if (!user) {
    user = { _id: newId(), feishuOpenId: 'dev:本地开发者', name: '本地开发者', avatar: '', email: '', isPlatformAdmin: true, createdAt: new Date(), lastLoginAt: new Date() }
    await col.adminUsers.insertOne(user)
  }
  const existing = await col.apps.findOne({ _id: APP_ID })
  if (existing?.prodBuildId) {
    console.log(`应用 ${APP_ID} 已存在，跳过`)
  }
  else if (existing) {
    // 上次初始化中断：重新生成测试版并上线
    await col.builds.updateMany({ appId: APP_ID, status: 'running' }, { $set: { status: 'failed' } })
    const build = await requestBuild(APP_ID, user._id)
    let done = await col.builds.findOne({ _id: build._id })
    for (let i = 0; i < 180 && done && ['queued', 'running'].includes(done.status); i++) {
      void kickBuilds()
      await new Promise(r => setTimeout(r, 1000))
      done = await col.builds.findOne({ _id: build._id })
    }
    if (done?.status === 'success') {
      await release(APP_ID, build._id, user._id, '初始化演示数据', 'release')
      console.log(`已上线：https://${APP_ID}.${config.baseDomain}/`)
    }
    else {
      console.error('构建失败', done?.issues)
      process.exitCode = 1
    }
  }
  else {
    const now = new Date()
    await col.apps.insertOne({ _id: APP_ID, name: '方案投票（演示）', description: '平台自带的演示应用：投票 + 登录拦截', icon: '', status: 'active', createdBy: user._id, createdAt: now, updatedAt: now })
    await col.members.insertOne({ _id: newId(), appId: APP_ID, userId: user._id, role: 'owner', createdAt: now })
    await initDraft(APP_ID, '方案投票（演示）', user._id)
    await writeDraft(APP_ID, 'manifest.json', `${JSON.stringify({ ...MANIFEST, name: '方案投票（演示）' }, null, 2)}\n`, { userId: user._id })
    await writeDraft(APP_ID, 'src/pages/Home.vue', VOTE_PAGE, { userId: user._id })
    console.log(`已创建应用 ${APP_ID}，正在生成测试版…`)
    const build = await requestBuild(APP_ID, user._id)
    let done = await col.builds.findOne({ _id: build._id })
    for (let i = 0; i < 180 && done && ['queued', 'running'].includes(done.status); i++) {
      void kickBuilds()
      await new Promise(r => setTimeout(r, 1000))
      done = await col.builds.findOne({ _id: build._id })
    }
    if (done?.status !== 'success') {
      console.error('构建失败', done?.issues)
      process.exitCode = 1
    }
    else {
      await release(APP_ID, build._id, user._id, '初始化演示数据', 'release')
      console.log(`已上线：https://${APP_ID}.${config.baseDomain}/`)
    }
  }
  await new Promise(r => setTimeout(r, 500))
  await closeMongo()
  process.exit()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
