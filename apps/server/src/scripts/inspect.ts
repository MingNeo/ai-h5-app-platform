// 调试用：打印某个应用的状态
import { closeMongo, col, connectMongo } from '../lib/mongo'
import { initStore } from '../lib/store'

const appId = process.argv[2] || 'demo'
initStore()
await connectMongo()
const app = await col.apps.findOne({ _id: appId })
const builds = await col.builds.find({ appId }, { projection: { files: 0 } }).sort({ createdAt: -1 }).limit(3).toArray()
console.log(JSON.stringify({ app, builds: builds.map(b => ({ id: b._id, status: b.status, issues: b.issues })) }, null, 2))
await closeMongo()
process.exit()
