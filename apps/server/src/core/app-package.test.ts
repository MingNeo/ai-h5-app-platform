import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import * as yauzl from 'yauzl'
import * as yazl from 'yazl'
import {
  PACKAGE_FORMAT,
  PACKAGE_VERSION,
  parsePackageManifest,
  sha256Hex,
  validateDataDoc,
  validateFileMeta,
  validateKvDoc,
  validatePackageEntry,
  validateSessionDoc,
  validateTurnDoc,
  validateEventDoc,
} from './app-package'

const limits = { maxDocBytes: 16 * 1024, maxUploadBytes: 5 * 1024 * 1024, maxKvBytes: 64 * 1024 }
const html = Buffer.from('<!doctype html><title>x</title>')

function validPackage(over: Record<string, unknown> = {}) {
  return {
    format: PACKAGE_FORMAT,
    version: PACKAGE_VERSION,
    exportedAt: '2026-01-01T00:00:00.000Z',
    source: { baseDomain: 'test.example.test', appId: 'demo-app', urls: { prod: '', beta: '', dev: '' } },
    app: { name: '演示应用', description: '', icon: '', schedule: null },
    files: [{ path: 'index.html', size: html.length, sha256: sha256Hex(html) }],
    grants: [],
    ...over,
  }
}

describe('应用包 app.json', () => {
  it('解析合法包并丢弃未知顶层字段', () => {
    const pkg = parsePackageManifest(JSON.stringify(validPackage({ extra: 1 })), limits)
    expect(pkg.source.appId).toBe('demo-app')
    expect(pkg.app.name).toBe('演示应用')
    expect(pkg.files).toHaveLength(1)
    expect(pkg.grants).toEqual([])
    expect('extra' in pkg).toBe(false)
  })

  it('拒绝错误的 format / version', () => {
    expect(() => parsePackageManifest(JSON.stringify(validPackage({ format: 'x' })), limits)).toThrow('不是本平台的应用包')
    expect(() => parsePackageManifest(JSON.stringify(validPackage({ version: 1 })), limits)).toThrow('不支持的应用包版本')
  })

  it('拒绝路径穿越和平台禁止的文件', () => {
    for (const path of ['../secret', 'src/../../x', '/etc/passwd', 'package.json', 'node_modules/x']) {
      const pkg = validPackage({ files: [{ path, size: 1, sha256: sha256Hex(Buffer.from('x')) }] })
      expect(() => parsePackageManifest(JSON.stringify(pkg), limits), path).toThrow()
    }
  })

  it('拒绝重复文件路径', () => {
    const file = { path: 'index.html', size: html.length, sha256: sha256Hex(html) }
    expect(() => parsePackageManifest(JSON.stringify(validPackage({ files: [file, file] })), limits)).toThrow('文件路径重复')
  })

  it('拒绝超过 2MB 的草稿文件声明', () => {
    const file = { path: 'index.html', size: 2 * 1024 * 1024 + 1, sha256: sha256Hex(html) }
    expect(() => parsePackageManifest(JSON.stringify(validPackage({ files: [file] })), limits)).toThrow('超过 2MB')
  })

  it('拒绝 __proto__ 和非法数据文档键', () => {
    const text = JSON.stringify(validPackage()).replace('"format"', '"__proto__":{"polluted":true},"format"')
    expect(() => parsePackageManifest(text, limits)).toThrow('非法字段名')

    expect(() => validateDataDoc(JSON.parse('{"$set":1}'), limits)).toThrow()
    expect(() => validateDataDoc({ 'a.b': 1 }, limits)).toThrow()
    expect(() => validateDataDoc({ _id: 'x', ok: 1 }, limits)).not.toThrow()
  })

  it('拒绝超过 16KB 的数据文档', () => {
    expect(() => validateDataDoc({ text: 'x'.repeat(17 * 1024) }, limits)).toThrow('单条数据文档')
  })

  it('校验 KV 文档', () => {
    expect(validateKvDoc({ _id: 'key:1', value: 1 }, limits, false)).toEqual({ _id: 'key:1', value: 1 })
    expect(() => validateKvDoc({ _id: 'bad key', value: 1 }, limits, false)).toThrow()
    expect(validateKvDoc({ _id: 'u1:k', uid: 'u1', key: 'k', value: 2 }, limits, true)).toMatchObject({ key: 'k' })
    expect(() => validateKvDoc({ _id: 'u1:k', uid: 'u2', key: 'k', value: 2 }, limits, true)).toThrow()
  })

  it('校验上传文件元数据', () => {
    const meta = { _id: 'f1', owner: 'u1', name: 'a.png', mime: 'image/png', size: 3, hash: sha256Hex(Buffer.from('abc')), public: true, createdAt: 1 }
    expect(validateFileMeta(meta, limits)).toMatchObject({ hash: meta.hash })
    expect(() => validateFileMeta({ ...meta, mime: 'text/html' }, limits)).toThrow('mime')
    expect(() => validateFileMeta({ ...meta, size: 6 * 1024 * 1024 }, limits)).toThrow('大小')
  })

  it('解析会话历史索引，拒绝错误路径和超量', () => {
    const history = {
      sessions: { count: 1, file: 'history/sessions.ndjson' },
      turns: { count: 2, file: 'history/turns.ndjson' },
      events: { count: 3, file: 'history/events.ndjson' },
    }
    const pkg = parsePackageManifest(JSON.stringify(validPackage({ history })), limits)
    expect(pkg.history?.turns.count).toBe(2)
    const badPath = { ...history, turns: { count: 1, file: 'history/x.ndjson' } }
    expect(() => parsePackageManifest(JSON.stringify(validPackage({ history: badPath })), limits)).toThrow('history.turns.file')
    const tooMany = { ...history, events: { count: 500_001, file: 'history/events.ndjson' } }
    expect(() => parsePackageManifest(JSON.stringify(validPackage({ history: tooMany })), limits)).toThrow('history.events.count')
  })

  it('校验会话、轮次、事件并归一化状态', () => {
    const session = validateSessionDoc({ _id: 's1', title: '会话', createdBy: 'u1', createdAt: '2026-01-01T00:00:00.000Z', eventSeq: 10 })
    expect(session.updatedAt).toBeInstanceOf(Date)
    const turn = validateTurnDoc({ _id: 't1', sessionId: 's1', status: 'running', message: 'hi', createdAt: '2026-01-01T00:00:00.000Z', snapshotBefore: 'old' })
    expect(turn.status).toBe('stopped')
    expect('snapshotBefore' in turn).toBe(false)
    expect(() => validateTurnDoc({ _id: 't2', sessionId: '', message: 'x', createdAt: '2026-01-01T00:00:00.000Z' })).toThrow()
    const ev = validateEventDoc({ sessionId: 's1', turnId: 't1', seq: 1, ts: 1, type: 'text.delta', text: 'x' })
    expect(ev).toMatchObject({ seq: 1, turnId: 't1', type: 'text.delta' })
    expect(() => validateEventDoc({ sessionId: 's1', turnId: 't1', seq: -1 })).toThrow()
  })
})

describe('应用包 ZIP 条目名', () => {
  it('接受约定条目', () => {
    expect(validatePackageEntry('app.json')).toEqual({ kind: 'manifest' })
    expect(validatePackageEntry('files/src/app.js')).toEqual({ kind: 'file', path: 'src/app.js' })
    expect(validatePackageEntry('data/dev/votes.ndjson')).toEqual({ kind: 'data', path: 'data/dev/votes.ndjson' })
    expect(validatePackageEntry(`blobs/${'a'.repeat(64)}`)).toEqual({ kind: 'blob', hash: 'a'.repeat(64) })
    expect(validatePackageEntry('history/sessions.ndjson')).toEqual({ kind: 'data', path: 'history/sessions.ndjson' })
    expect(() => validatePackageEntry('history/other.ndjson')).toThrow()
  })

  it('拒绝穿越、反斜杠、绝对路径和未知目录', () => {
    for (const name of ['../x', 'files/../x', 'files\\src\\app.js', '/files/index.html', 'other/x', 'data/dev/../../x']) {
      expect(() => validatePackageEntry(name), name).toThrow()
    }
  })

  it('拒绝非法集合文件名和 blob 哈希', () => {
    expect(() => validatePackageEntry('data/dev/_kv_user.json')).toThrow()
    expect(() => validatePackageEntry('data/dev/Votes.ndjson')).toThrow()
    expect(() => validatePackageEntry('blobs/not-a-hash')).toThrow()
  })
})

describe('ZIP 往返', () => {
  it('文本与二进制条目字节一致', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])
    const ndjson = Buffer.from('{"_id":"1","value":1}\n')
    const zip = new yazl.ZipFile()
    zip.addBuffer(html, 'files/index.html')
    zip.addBuffer(png, 'files/public/logo.png', { compress: false })
    zip.addBuffer(ndjson, 'data/dev/votes.ndjson')
    zip.end()
    const chunks: Buffer[] = []
    for await (const chunk of zip.outputStream as Readable)
      chunks.push(Buffer.from(chunk))
    const buf = Buffer.concat(chunks)

    const zipFile = await yauzl.fromBufferPromise(buf, { lazyEntries: true })
    const got = new Map<string, Buffer>()
    await new Promise<void>((done, fail) => {
      zipFile.on('entry', (entry) => {
        zipFile.openReadStream(entry, (e, stream) => {
          if (e)
            return fail(e)
          const parts: Buffer[] = []
          stream.on('data', (p: Buffer) => parts.push(p))
          stream.on('end', () => {
            got.set(entry.fileName, Buffer.concat(parts))
            zipFile.readEntry()
          })
          stream.on('error', fail)
        })
      })
      zipFile.on('end', () => done())
      zipFile.on('error', fail)
      zipFile.readEntry()
    })

    expect(got.get('files/index.html')?.equals(html)).toBe(true)
    expect(got.get('files/public/logo.png')?.equals(png)).toBe(true)
    expect(got.get('data/dev/votes.ndjson')?.equals(ndjson)).toBe(true)
  })
})
