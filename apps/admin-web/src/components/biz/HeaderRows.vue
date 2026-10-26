<script setup lang="ts">
export interface HeaderRow { name: string, value: string }

const props = defineProps<{ secretNames?: string[] }>()
const rows = defineModel<HeaderRow[]>({ required: true })

function kindOf(value: string): 'value' | 'env' | 'secret' {
  if (value.startsWith('env:'))
    return 'env'
  if (value.startsWith('secret:'))
    return 'secret'
  return 'value'
}
function subValue(value: string) {
  const kind = kindOf(value)
  return kind === 'value' ? value : value.slice(kind.length + 1)
}
function setKind(row: HeaderRow, kind: string) {
  const v = subValue(row.value)
  row.value = kind === 'value' ? v : `${kind}:${v}`
}
function setSubValue(row: HeaderRow, v: string) {
  const kind = kindOf(row.value)
  row.value = kind === 'value' ? v : `${kind}:${v}`
}
function add() {
  rows.value = [...rows.value, { name: '', value: '' }]
}
function remove(i: number) {
  rows.value = rows.value.filter((_, idx) => idx !== i)
}
</script>

<template>
  <div class="space-y-2">
    <div v-for="(row, i) in rows" :key="i" class="flex items-center gap-2">
      <el-input v-model="row.name" placeholder="请求头名，如 X-Token" size="small" class="w-160px" />
      <el-select :model-value="kindOf(row.value)" size="small" class="w-100px" @update:model-value="(v: string) => setKind(row, v)">
        <el-option label="固定值" value="value" />
        <el-option label="密钥" value="secret" />
        <el-option label="环境变量" value="env" />
      </el-select>
      <el-select
        v-if="kindOf(row.value) === 'secret'" :model-value="subValue(row.value)" size="small" class="flex-1"
        placeholder="选择密钥" filterable allow-create default-first-option
        @update:model-value="(v: string) => setSubValue(row, v)"
      >
        <el-option v-for="n in props.secretNames ?? []" :key="n" :label="n" :value="n" />
      </el-select>
      <el-input
        v-else :model-value="subValue(row.value)" size="small" class="flex-1"
        :placeholder="kindOf(row.value) === 'env' ? '环境变量名，如 COUPON_TOKEN' : '值'"
        @update:model-value="(v: string) => setSubValue(row, v)"
      />
      <el-button size="small" link type="danger" @click="remove(i)">
        删除
      </el-button>
    </div>
    <el-button size="small" @click="add">
      + 添加请求头
    </el-button>
  </div>
</template>
