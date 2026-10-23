<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus'
import { onMounted, ref, watch } from 'vue'
import { api } from '../../api'

const status = ref('pending')
const list = ref<Array<{ id: string, appId: string, type: string, key: string, status: string, reason: string, requestedByName: string, createdAt: string, reviewNote?: string }>>([])

async function load() {
  list.value = await api('/grants', { query: { status: status.value } })
}

async function review(id: string, approve: boolean) {
  let note = ''
  if (!approve) {
    const res = await ElMessageBox.prompt('驳回原因', '驳回申请', { inputPattern: /\S/, inputErrorMessage: '请填写原因' })
    note = res.value
  }
  await api(`/grants/${id}/review`, { body: { approve, note } })
  ElMessage.success(approve ? '已通过' : '已驳回')
  await load()
}

async function revoke(id: string) {
  await ElMessageBox.confirm('撤销后应用将无法再调用该能力，确定撤销？', '撤销授权', { type: 'warning' })
  await api(`/grants/${id}/revoke`, { body: {} })
  await load()
}

watch(status, load)
onMounted(load)
</script>

<template>
  <div class="max-w-1100px mx-auto p-6">
    <div class="bg-white rounded-xl p-5 border border-[var(--border)]">
      <div class="flex items-center mb-4">
        <span class="font-600 flex-1">能力审批</span>
        <el-radio-group v-model="status" size="small">
          <el-radio-button value="pending">
            待审批
          </el-radio-button>
          <el-radio-button value="approved">
            已开通
          </el-radio-button>
          <el-radio-button value="all">
            全部
          </el-radio-button>
        </el-radio-group>
      </div>
      <el-table :data="list" size="small" empty-text="没有记录">
        <el-table-column label="应用" prop="appId" width="150" />
        <el-table-column label="能力" width="200">
          <template #default="{ row }">
            <el-tag size="small" class="mr-1">
              {{ row.type === 'biz' ? '业务接口' : '平台能力' }}
            </el-tag>{{ row.key }}
          </template>
        </el-table-column>
        <el-table-column label="理由" prop="reason" show-overflow-tooltip />
        <el-table-column label="申请人" prop="requestedByName" width="100" />
        <el-table-column label="时间" width="160">
          <template #default="{ row }">
            {{ new Date(row.createdAt).toLocaleString('zh-CN') }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="140">
          <template #default="{ row }">
            <template v-if="row.status === 'pending'">
              <el-button size="small" link type="success" @click="review(row.id, true)">
                通过
              </el-button>
              <el-button size="small" link type="danger" @click="review(row.id, false)">
                驳回
              </el-button>
            </template>
            <el-button v-else-if="row.status === 'approved'" size="small" link type="warning" @click="revoke(row.id)">
              撤销
            </el-button>
            <span v-else class="text-12px text-[var(--muted)]">{{ row.reviewNote }}</span>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>
