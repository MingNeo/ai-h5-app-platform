import type { FastifyInstance } from 'fastify'
import { ok } from '../../lib/http'
import { col } from '../../lib/mongo'
import { requirePerm } from './auth'

export function registerMonitorRoutes(app: FastifyInstance) {
  app.get('/admin-api/apps/:appId/stats', async (req) => {
    const { appId } = req.params as { appId: string }
    await requirePerm(req, appId, 'console.view')
    const days = Math.min(Number((req.query as { days?: string }).days ?? 7), 30)
    const since = new Date(Date.now() - days * 86400_000)
    const match = { appId, channel: 'prod', ts: { $gte: since } }
    const tz = 'Asia/Shanghai'
    const [daily, errors, slowApis, perf] = await Promise.all([
      col.telemetry.aggregate([
        { $match: { ...match, type: { $in: ['pv', 'error'] } } },
        { $group: { _id: { day: { $dateToString: { format: '%m-%d', date: '$ts', timezone: tz } }, type: '$type' }, n: { $sum: 1 }, uv: { $addToSet: '$vid' } } },
        { $project: { _id: 0, day: '$_id.day', type: '$_id.type', n: 1, uv: { $size: '$uv' } } },
        { $sort: { day: 1 } },
      ]).toArray(),
      col.telemetry.aggregate([
        { $match: { ...match, type: 'error' } },
        { $group: { _id: '$data.message', n: { $sum: 1 }, last: { $max: '$ts' }, sample: { $first: '$data' } } },
        { $sort: { n: -1 } },
        { $limit: 20 },
      ]).toArray(),
      col.telemetry.aggregate([
        { $match: { ...match, type: 'api' } },
        { $group: { _id: { url: '$data.url', status: '$data.status' }, n: { $sum: 1 } } },
        { $sort: { n: -1 } },
        { $limit: 20 },
      ]).toArray(),
      col.telemetry.aggregate([
        { $match: { ...match, type: 'perf', 'data.metric': 'LCP' } },
        { $group: { _id: null, values: { $push: '$data.value' } } },
      ]).toArray(),
    ])
    const lcp = (perf[0]?.values as number[] | undefined)?.sort((a, b) => a - b) ?? []
    const p = (q: number) => lcp.length ? lcp[Math.min(lcp.length - 1, Math.floor(lcp.length * q))] : null
    return ok({
      daily,
      errors: errors.map(e => ({ message: e._id, count: e.n, last: e.last, sample: e.sample })),
      apiFailures: slowApis.map(a => ({ url: a._id.url, status: a._id.status, count: a.n })),
      lcp: { p50: p(0.5), p75: p(0.75), p95: p(0.95), samples: lcp.length },
    })
  })
}
