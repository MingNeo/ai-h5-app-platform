<script setup lang="ts">
export interface FieldRow {
  name: string
  type: 'string' | 'integer' | 'number' | 'boolean'
  required: boolean
  description?: string
  in?: 'query' | 'path' | 'header'
}

const props = defineProps<{ showIn?: boolean }>()
const rows = defineModel<FieldRow[]>({ required: true })

function add() {
  rows.value = [...rows.value, { name: '', type: 'string', required: false, description: '', ...(props.showIn ? { in: 'query' as const } : {}) }]
}
function remove(i: number) {
  rows.value = rows.value.filter((_, idx) => idx !== i)
}
function onInChange(row: FieldRow) {
  if (row.in === 'path')
    row.required = true
}
</script>

<template>
  <div class="space-y-2">
    <div v-for="(row, i) in rows" :key="i" class="flex items-center gap-2">
      <el-input v-model="row.name" placeholder="名称" size="small" class="w-120px" />
      <el-select v-if="showIn" v-model="row.in" size="small" class="w-90px" @change="onInChange(row)">
        <el-option label="query" value="query" />
        <el-option label="path" value="path" />
        <el-option label="header" value="header" />
      </el-select>
      <el-select v-model="row.type" size="small" class="w-100px">
        <el-option label="string" value="string" />
        <el-option label="integer" value="integer" />
        <el-option label="number" value="number" />
        <el-option label="boolean" value="boolean" />
      </el-select>
      <el-checkbox v-model="row.required" :disabled="row.in === 'path'" size="small">
        必填
      </el-checkbox>
      <el-input v-model="row.description" placeholder="说明（可选）" size="small" class="flex-1" />
      <el-button size="small" link type="danger" @click="remove(i)">
        删除
      </el-button>
    </div>
    <el-button size="small" @click="add">
      + 添加字段
    </el-button>
  </div>
</template>
