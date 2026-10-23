// 初始化本地演示数据：开发者账号 + demo 投票应用（生成测试版并上线）
import { type AppRole, appUrl } from '@app-platform/shared'
import { config } from '../config'
import { initDraft, writeDraft } from '../core/drafts'
import { MANIFEST, VOTE_PAGE } from '../lib/llm-mock'
import { MongoClient } from 'mongodb'
import { closeMongo, col, connectMongo } from '../lib/mongo'
import { initStore } from '../lib/store'
import { newId } from '../lib/tokens'
import { kickBuilds, release, requestBuild } from '../modules/build/service'

const APP_ID = process.argv[2] || 'demo'

/** 演示账号：每个应用角色一个，本地免登下拉里可以直接选来验证权限 */
const DEV_USERS: Array<{ name: string, role: AppRole }> = [
  { name: '演示-只读', role: 'viewer' },
  { name: '演示-运营', role: 'operator' },
  { name: '演示-开发者', role: 'developer' },
  { name: '演示-发布员', role: 'publisher' },
  { name: '演示-数据管理员', role: 'data' },
]

async function ensureUser(name: string, isPlatformAdmin: boolean) {
  const now = new Date()
  const existing = await col.adminUsers.findOne({ feishuOpenId: `dev:${name}` })
  if (existing) {
    await col.adminUsers.updateOne({ _id: existing._id }, { $set: { isPlatformAdmin } })
    return existing._id
  }
  const id = newId()
  await col.adminUsers.insertOne({ _id: id, feishuOpenId: `dev:${name}`, name, avatar: '', email: '', isPlatformAdmin, createdAt: now, lastLoginAt: now })
  return id
}

async function ensureRoleUsers() {
  for (const u of DEV_USERS) {
    const userId = await ensureUser(u.name, false)
    const now = new Date()
    await col.members.updateOne({ appId: APP_ID, userId }, {
      $set: { role: u.role, perms: null },
      $setOnInsert: { _id: newId(), appId: APP_ID, userId, createdAt: now },
    }, { upsert: true })
  }
  console.log(`演示角色账号：${DEV_USERS.map(u => `${u.name}（${u.role}）`).join('、')}`)
}

/** 负责人成员关系要跟着当前账号走；顺带清理指向已删除用户的记录 */
async function ensureOwner(userId: string) {
  const now = new Date()
  await col.members.updateOne({ appId: APP_ID, userId }, {
    $set: { role: 'owner', perms: null },
    $setOnInsert: { _id: newId(), appId: APP_ID, userId, createdAt: now },
  }, { upsert: true })
  const users = await col.adminUsers.find({}, { projection: { _id: 1 } }).toArray()
  await col.members.deleteMany({ appId: APP_ID, userId: { $nin: users.map(u => u._id) } })
}

/**
 * MONGO_URL=memory 时 mongod 固定在 27018。开发服务器已经跑着的情况下，
 * 直接复用它，避免端口冲突（数据目录本来就是同一个）。
 */
async function connectForSeed() {
  if (config.mongoUrl !== 'memory')
    return connectMongo()
  try {
    const probe = new MongoClient('mongodb://127.0.0.1:27018', { serverSelectionTimeoutMS: 800 })
    await probe.connect()
    await probe.db('admin').command({ ping: 1 })
    await probe.close()
    console.log('复用已运行的本地 Mongo（127.0.0.1:27018）')
    return connectMongo('mongodb://127.0.0.1:27018/app_platform')
  }
  catch {
    return connectMongo()
  }
}

async function main() {
  initStore()
  await connectForSeed()
  const ownerId = await ensureUser('本地开发者', true)
  const user = await col.adminUsers.findOne({ _id: ownerId })
  if (!user)
    throw new Error('演示账号创建失败')
  await ensureOwner(ownerId)
  await ensureRoleUsers()
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
      console.log(`已上线：${appUrl(APP_ID, 'prod', config.baseDomain)}`)
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
    await writeDraft(APP_ID, 'admin.json', `${JSON.stringify({
      title: '投票后台',
      description: '查看投票情况、导出投票明细',
      pages: [{
        title: '概览',
        blocks: [
          { type: 'stat', title: '总票数', collection: 'votes', unit: '票' },
          { type: 'chart', title: '各选项占比', collection: 'votes', chart: 'pie', field: 'option' },
          { type: 'chart', title: '每日投票', collection: 'votes', chart: 'line', timeField: '_createdAt', interval: 'day' },
          { type: 'text', content: '每人限投一票，数据实时读取。' },
        ],
      }, {
        title: '投票明细',
        blocks: [
          {
            type: 'table',
            title: '投票记录',
            collection: 'votes',
            columns: ['option'],
            orderBy: [['_createdAt', 'desc']],
            filters: [{ field: 'option', type: 'select', label: '选项' }],
            actions: { detail: true, delete: true },
          },
        ],
      }],
    }, null, 2)}\n`, { userId: user._id })
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
      console.log(`已上线：${appUrl(APP_ID, 'prod', config.baseDomain)}`)
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
