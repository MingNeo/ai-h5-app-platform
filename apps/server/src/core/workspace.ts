import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { createRequire } from 'node:module'
import { TEMPLATE_FILES_DIR, TEMPLATE_NODE_MODULES } from '@app-platform/app-template'
import { blobs } from '../lib/blob'
import type { SnapshotFile } from '../lib/mongo'

const require = createRequire(import.meta.url)
const SDK_DTS = join(dirname(require.resolve('@app-platform/sdk/package.json')), 'platform.d.ts')

/** 平台锁定文件的内容（随应用变化的部分由调用方传入） */
export function lockedFiles(generated: Record<string, string> = {}): Record<string, string> {
  return {
    'tsconfig.json': readFileSync(join(TEMPLATE_FILES_DIR, 'tsconfig.json'), 'utf8'),
    'src/env.d.ts': readFileSync(join(TEMPLATE_FILES_DIR, 'src/env.d.ts'), 'utf8'),
    'src/platform.d.ts': readFileSync(SDK_DTS, 'utf8'),
    ...generated,
  }
}

const KEEP = new Set(['node_modules', '.vite', '.tsbuildinfo'])

function walkFiles(dir: string, base = dir, out: string[] = []) {
  if (!existsSync(dir))
    return out
  for (const name of readdirSync(dir)) {
    if (dir === base && KEEP.has(name))
      continue
    const p = join(dir, name)
    const st = lstatSync(p)
    if (st.isDirectory())
      walkFiles(p, base, out)
    else out.push(relative(base, p).split('\\').join('/'))
  }
  return out
}

/** 把文件集合写入磁盘目录（预览、检查、构建共用），并链接平台预装依赖 */
export async function materialize(dir: string, files: SnapshotFile[], generated: Record<string, string> = {}) {
  mkdirSync(dir, { recursive: true })
  const wanted = new Set(files.map(f => f.path))
  const locked = lockedFiles(generated)
  for (const p of Object.keys(locked))
    wanted.add(p)
  for (const existing of walkFiles(dir)) {
    if (!wanted.has(existing))
      rmSync(join(dir, existing), { force: true })
  }
  for (const f of files)
    await writeWorkspaceFile(dir, f.path, f.hash)
  for (const [p, content] of Object.entries(locked)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true })
    writeFileSync(join(dir, p), content)
  }
  const nm = join(dir, 'node_modules')
  if (!existsSync(nm))
    symlinkSync(TEMPLATE_NODE_MODULES, nm, 'dir')
}

export async function writeWorkspaceFile(dir: string, path: string, hash: string) {
  const data = await blobs.get(hash)
  if (!data)
    throw new Error(`blob 丢失：${hash}`)
  const target = join(dir, path)
  mkdirSync(dirname(target), { recursive: true })
  if (existsSync(target)) {
    const cur = readFileSync(target)
    if (cur.equals(data))
      return
  }
  writeFileSync(target, data)
}

export function removeWorkspaceFile(dir: string, path: string) {
  rmSync(join(dir, path), { force: true })
}

/** 覆盖写入平台生成的文件（业务接口类型随授权变化，每次打开工作区都刷新） */
export function writeGeneratedFiles(dir: string, generated: Record<string, string>) {
  for (const [path, content] of Object.entries(generated)) {
    const target = join(dir, path)
    mkdirSync(dirname(target), { recursive: true })
    if (existsSync(target) && readFileSync(target, 'utf8') === content)
      continue
    writeFileSync(target, content)
  }
}
