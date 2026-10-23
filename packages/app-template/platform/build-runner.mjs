// 子进程构建入口：node build-runner.mjs '<json>'
// 输出最后一行 JSON：{ ok, errors, files }
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { build, createPlatformViteConfig } from './index.mjs'

const opts = JSON.parse(process.argv[2])
const errors = []
const logger = {
  hasWarned: false,
  info() {},
  warn(msg) { if (!String(msg).includes('chunks are larger') && !String(msg).includes('__platform/boot.js')) errors.push({ severity: 'warning', message: strip(msg) }) },
  warnOnce(msg) { this.warn(msg) },
  error(msg) { errors.push({ severity: 'error', message: strip(msg) }) },
  clearScreen() {},
  hasErrorLogged() { return false },
}

function strip(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\x1B\[[0-9;]*m/g, '').slice(0, 4000)
}

function listFiles(dir) {
  const out = []
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      const st = statSync(p)
      if (st.isDirectory())
        walk(p)
      else out.push({ path: relative(dir, p).split('\\').join('/'), size: st.size })
    }
  }
  walk(dir)
  return out
}

try {
  await build({
    ...createPlatformViteConfig({ ...opts, command: 'build', customLogger: logger, logLevel: 'warn' }),
  })
  process.stdout.write(`\n${JSON.stringify({ ok: true, errors, files: opts.outDir ? listFiles(opts.outDir) : [] })}\n`)
}
catch (e) {
  const message = strip(e?.message || e)
  const loc = e?.loc ? { file: e.loc.file ? relative(opts.root, e.loc.file) : e.id ? relative(opts.root, e.id) : undefined, line: e.loc.line } : (e?.id ? { file: relative(opts.root, e.id) } : {})
  errors.push({ severity: 'error', message, ...loc })
  process.stdout.write(`\n${JSON.stringify({ ok: false, errors, files: [] })}\n`)
  process.exitCode = 1
}
