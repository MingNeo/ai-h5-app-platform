import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = join(dirname(fileURLToPath(import.meta.url)), '../docs')
const read = (name: string) => readFileSync(join(dir, `${name}.md`), 'utf8')

export const DOC_TOPICS = {
  rules: '平台开发规范（技术栈、依赖白名单、目录、样式与资源、安全约束、工作方式）',
  sdk: '平台 SDK 用法（登录、数据库、KV、文件、业务接口、错误处理、常见模式）',
  manifest: 'manifest.json 参考（集合、ACL、字段、索引、限制）',
} as const

export type DocTopic = keyof typeof DOC_TOPICS

export function loadDoc(topic: DocTopic): string {
  return read(topic)
}
