<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../../api'

const list = ref<Array<{ actorName: string, action: string, appId?: string, detail?: Record<string, unknown>, createdAt: string }>>([])

const ACTION_LABEL: Record<string, string> = {
  'admin.login': '登录后台',
  'app.create': '创建应用',
  'app.update': '修改应用',
  'app.delete': '删除应用',
  'app.release': '上线',
  'app.rollback': '回滚',
  'member.set': '设置成员',
  'member.remove': '移除成员',
  'platform-admin.grant': '设为平台管理员',
  'platform-admin.revoke': '取消平台管理员',
  'draft.restore': '恢复版本',
  'turn.revert': '撤销 AI 改动',
  'turn.rollback': '回滚到某条消息前',
  'grant.request': '申请能力',
  'grant.approve': '通过能力申请',
  'grant.reject': '驳回能力申请',
  'grant.revoke': '撤销能力',
  'data.create': '新增数据',
  'data.update': '修改数据',
  'data.delete': '删除数据',
  'data.export': '导出数据',
  'data.sync': '同步数据到正式环境',
  'kv.set': '修改应用配置',
  'kv.delete': '删除应用配置',
  'api-client.create': '创建开放接口调用方',
  'api-client.revoke': '吊销开放接口 token',
  'api-client.delete': '删除开放接口调用方',
  'openapi.query': '开放接口查询',
  'openapi.stats': '开放接口统计',
  'openapi.get': '开放接口读取单条',
  'openapi.create': '开放接口新增数据',
  'openapi.update': '开放接口修改数据',
  'openapi.delete': '开放接口删除数据',
  'openapi.export': '开放接口导出',
}

onMounted(async () => {
  list.value = await api('/audit')
})
</script>

<template>
  <div class="max-w-1100px mx-auto p-6">
    <div class="bg-white rounded-xl p-5 border border-[var(--border)]">
      <div class="font-600 mb-4">
        操作日志（最近 200 条）
      </div>
      <el-table :data="list" size="small">
        <el-table-column label="时间" width="170">
          <template #default="{ row }">
            {{ new Date(row.createdAt).toLocaleString('zh-CN') }}
          </template>
        </el-table-column>
        <el-table-column label="操作人" prop="actorName" width="120" />
        <el-table-column label="操作" width="160">
          <template #default="{ row }">
            {{ ACTION_LABEL[row.action] ?? row.action }}
          </template>
        </el-table-column>
        <el-table-column label="应用" prop="appId" width="150" />
        <el-table-column label="详情" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="font-mono text-12px">{{ row.detail ? JSON.stringify(row.detail) : '' }}</span>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>
