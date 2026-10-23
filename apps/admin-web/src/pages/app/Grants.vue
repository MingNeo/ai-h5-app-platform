<script setup lang="ts">
import { ElMessage } from 'element-plus'
import { computed, onMounted, ref } from 'vue'
import { api } from '../../api'
import { useAppStore } from '../../stores/app'

const store = useAppStore()
const appId = store.app!.appId
const catalog = ref<{ capabilities: Array<{ key: string, label: string }>, bizApis: Array<{ prefix: string, title: string, description: string, operations: number }> }>({ capabilities: [], bizApis: [] })
const applying = ref<{ type: 'capability' | 'biz', key: string, label: string } | null>(null)
const reason = ref('')

const grants = computed(() => store.app?.grants ?? [])
const manifest = computed(() => store.app?.manifest)

function grantOf(type: string, key: string) {
  return grants.value.find(g => g.type === type && g.key === key && g.status !== 'rejected') ?? grants.value.find(g => g.type === type && g.key === key)
}

function statusText(type: string, key: string) {
  const g = grantOf(type, key)
  if (!g)
    return { text: '未开通', type: 'info' }
  return ({ pending: { text: '审批中', type: 'warning' }, approved: { text: '已开通', type: 'success' }, rejected: { text: '已驳回', type: 'danger' } } as Record<string, { text: string, type: string }>)[g.status]!
}

function declared(type: string, key: string) {
  if (type === 'capability')
    return manifest.value?.capabilities?.includes(key)
  return manifest.value?.bizApis?.some((p: string) => p.startsWith(key))
}

async function apply() {
  if (reason.value.trim().length < 2)
    return ElMessage.warning('请填写申请理由')
  await api(`/apps/${appId}/grants`, { body: { type: applying.value!.type, key: applying.value!.key, reason: reason.value } })
  ElMessage.success('已提交申请，平台管理员审批后生效')
  applying.value = null
  reason.value = ''
  await store.load(appId)
}

onMounted(async () => {
  catalog.value = await api('/catalog')
  await store.load(appId)
})
</script>

<template>
  <div class="max-w-960px mx-auto p-6 flex flex-col gap-5">
    <el-alert type="info" :closable="false" title="登录、数据库、键值存储、文件上传为基础能力，默认开通。下面的平台能力和业务接口需要申请，并在 manifest.json 中声明后才能使用（可以直接让 AI 帮你声明）。" />
    <div class="bg-white rounded-xl p-5 border border-[var(--border)]">
      <div class="font-600 mb-3">
        平台能力
      </div>
      <div v-for="c in catalog.capabilities" :key="c.key" class="flex items-center gap-3 py-2.5 border-b border-gray-100 last:border-0">
        <div class="flex-1">
          <div>{{ c.label }} <span class="text-12px text-[var(--muted)]">{{ c.key }}</span></div>
          <div class="text-12px text-[var(--muted)]">
            {{ declared('capability', c.key) ? 'manifest 已声明' : 'manifest 未声明' }}
            <template v-if="grantOf('capability', c.key)?.reviewNote">
              · 审批意见：{{ grantOf('capability', c.key)?.reviewNote }}
            </template>
          </div>
        </div>
        <el-tag :type="statusText('capability', c.key).type as any" size="small">
          {{ statusText('capability', c.key).text }}
        </el-tag>
        <el-button
          v-if="!grantOf('capability', c.key) || grantOf('capability', c.key)?.status === 'rejected'"
          size="small" :disabled="!store.canEdit()" @click="applying = { type: 'capability', key: c.key, label: c.label }"
        >
          申请
        </el-button>
      </div>
      <el-empty v-if="!catalog.capabilities.length" description="暂无可申请的平台能力" :image-size="60" />
    </div>
    <div class="bg-white rounded-xl p-5 border border-[var(--border)]">
      <div class="font-600 mb-3">
        业务接口
      </div>
      <div v-for="b in catalog.bizApis" :key="b.prefix" class="flex items-center gap-3 py-2.5 border-b border-gray-100 last:border-0">
        <div class="flex-1">
          <div>{{ b.title }} <span class="text-12px text-[var(--muted)] font-mono">{{ b.prefix }}</span></div>
          <div class="text-12px text-[var(--muted)]">
            {{ b.description }} · {{ b.operations ? `${b.operations} 个接口` : '暂无接口文档' }} · {{ declared('biz', b.prefix) ? 'manifest 已声明' : 'manifest 未声明' }}
          </div>
        </div>
        <el-tag :type="statusText('biz', b.prefix).type as any" size="small">
          {{ statusText('biz', b.prefix).text }}
        </el-tag>
        <el-button
          v-if="!grantOf('biz', b.prefix) || grantOf('biz', b.prefix)?.status === 'rejected'"
          size="small" :disabled="!store.canEdit()" @click="applying = { type: 'biz', key: b.prefix, label: b.title }"
        >
          申请
        </el-button>
      </div>
      <el-empty v-if="!catalog.bizApis.length" description="平台管理员还没有登记业务接口" :image-size="60" />
    </div>

    <el-dialog :model-value="!!applying" :title="`申请：${applying?.label}`" width="480px" @close="applying = null">
      <el-input v-model="reason" type="textarea" :rows="4" placeholder="说明用途、预估调用量" maxlength="500" />
      <template #footer>
        <el-button @click="applying = null">
          取消
        </el-button>
        <el-button type="primary" @click="apply">
          提交申请
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>
