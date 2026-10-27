# 应用后台视图（admin.json）参考

`admin.json` 放在应用根目录，描述**运营在看什么数据、怎么筛、能做什么操作**。平台后台按它渲染，不会执行任何应用代码。

## 什么时候需要写

- 用户说「要个后台」「运营怎么看数据」「做个统计」「审核一下报名」→ 生成 `admin.json`
- 应用的集合面向运营而不是终端用户（报名、征集、打卡、订单、审核等）→ 必须有；这里只是举例，任何收集数据的应用都适用
- 纯工具类、没有数据集合的应用可以没有

## 文件规则

- 结构由平台校验（schema 见 [shared/admin-view.ts](../../shared/src/admin-view.ts)），字段写错会被拒绝
- 引用的 `collection` 必须在 `manifest.json` 里声明；`field` / `columns` / `orderBy` / `filters` / `search.fields` 必须是该集合 `fields` 里声明过的字段（`_createdAt`、`_updatedAt`、`_owner` 这类系统字段可以直接用）
- `admin.json` 不通过应用域名对外提供，只有管理端能读
- 随草稿和发布一起版本化：`env=dev` 看草稿，`env=prod` 看线上版本的快照
- 后台页面上有「AI 生成」：写一句需求就能生成，也可以直接编辑 JSON

## 数据来源与权限

- `dev` 看开发数据（草稿集合、预览里提交的数据），`prod` 看线上数据，两边独立，互不影响
- 查看数据：`viewer` 即可；新增/编辑/删除：`dev` 需要 `developer`，`prod` 需要 `owner`
- 导出 CSV：仅 `owner`，包含 `_id`、`_owner`、声明字段、`_createdAt`，最多 5 万行
- 后台是管理视角，不受集合 ACL 限制：`admin_only` 的数据也能看，`public_write` 的游客提交也在列表里
- 游客提交的记录 `_owner` 是 `vid:<设备标识>`，`_ownerProfile.nickname` 显示「游客」；运营可以直接编辑或删除

## 顶层结构

```json
{
  "title": "报名后台",
  "description": "运营查看报名、导出名单",
  "pages": [
    { "title": "概览", "blocks": [] },
    { "title": "报名管理", "blocks": [] }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `title` | 后台标题，可选 |
| `description` | 一句话说明给谁用，可选 |
| `pages` | 1–10 页，每页有 `title` 和 `blocks`（最多 30 个） |

## 区块：stat（数字卡片）

```json
{ "type": "stat", "title": "报名人数", "collection": "signups" }
{ "type": "stat", "title": "总金额", "collection": "orders", "agg": "sum", "field": "amount", "unit": "元" }
{ "type": "stat", "title": "今日新增", "collection": "signups", "where": { "_createdAt": { "$gte": 1735660800000 } }, "hint": "按天统计" }
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `title` | 是 | 卡片标题 |
| `collection` | 是 | 统计的集合 |
| `agg` | 否 | `count`（默认）/ `sum` / `avg` |
| `field` | sum/avg 时必填 | 数值字段 |
| `where` | 否 | 过滤条件，DSL 同 SDK（`$eq $ne $gt $gte $lt $lte $in $nin $exists`，支持 `$and/$or`） |
| `unit` | 否 | 单位，如 `元`、`人` |
| `hint` | 否 | 卡片下方小字 |

## 区块：chart（图表）

**分类分布（柱状 / 饼图）**

```json
{ "type": "chart", "title": "各渠道报名", "collection": "signups", "chart": "bar", "field": "channel", "limit": 10 }
{ "type": "chart", "title": "票数占比", "collection": "votes", "chart": "pie", "field": "option" }
```

**按时间趋势（折线）**

```json
{ "type": "chart", "title": "每日报名", "collection": "signups", "chart": "line", "timeField": "_createdAt", "interval": "day" }
```

| 字段 | 说明 |
|---|---|
| `chart` | `bar`（默认）/ `pie` / `line` |
| `field` | bar、pie 的分类字段（必填） |
| `timeField` | line 的时间字段，默认 `_createdAt`，也支持 `_updatedAt` 或已声明的数字时间戳字段 |
| `interval` | line 的粒度：`day`（默认）/ `hour` |
| `limit` | bar / pie 最多几项，默认 12 |
| `where` | 过滤条件 |

## 区块：table（数据表格）

```json
{
  "type": "table",
  "title": "报名名单",
  "collection": "signups",
  "columns": ["name", "mobile", "channel", "status"],
  "orderBy": [["_createdAt", "desc"]],
  "pageSize": 20,
  "filters": [
    { "field": "status", "type": "select", "label": "状态" },
    { "field": "channel", "type": "select" }
  ],
  "search": { "fields": ["name", "mobile"], "placeholder": "搜索姓名或手机号" },
  "actions": { "detail": true, "edit": true, "delete": true, "create": true }
}
```

| 字段 | 说明 |
|---|---|
| `columns` | 展示哪些字段；不填时展示全部声明字段 |
| `orderBy` | 默认排序，最多 3 个 |
| `pageSize` | 每页条数，1–100，默认 20 |
| `filters` | 顶部筛选器，最多 8 个。`type`: `select` / `input` / `date`；`select` 不填 `options` 时取字段的 `enum` |

`options` 格式：纯值数组（`string` 或 `number`），**不是** `{ label, value }` 对象——平台没有 code/label 映射机制，数组里的值既是筛选条件也是下拉框显示文本，写什么就显示什么：

```json
{ "field": "category", "type": "select", "label": "分类", "options": ["中餐", "面食", "快餐"] }
```

字段本身存的就得是 `"中餐"` 这样的展示文本（manifest 里 `category` 的 `enum` 也要用同样的中文值，见 [manifest.md](manifest.md)），而不是 `chinese` 这类 code；多数情况下不用写 `options`，不填会自动取字段的 `enum`，两边永远一致。
| `search` | 关键字搜索。只对 `fields` 里列出的**字符串字段**做包含匹配，最多 6 个 |
| `actions` | `detail` 查看详情（默认开）、`edit` 编辑、`delete` 删除、`create` 新增 |

说明：

- `edit` / `delete` / `create` 需要后台账号有对应角色（测试数据要 developer，正式数据要 owner），没有权限时按钮不可用
- 编辑表单按 manifest 的字段定义自动生成：`enum` 变下拉、`boolean` 变开关、`number/integer` 变数字框、`array/object` 变 JSON 文本域
- 删除会二次确认

## 区块：text（说明文字）

```json
{ "type": "text", "title": "口径说明", "content": "报名数按提交记录计算，取消报名仍计入。" }
```

用于放统计口径、操作约定、活动规则提醒。最多 2000 字。

## 完整示例（报名类，仅演示结构）

```json
{
  "title": "夏日活动报名后台",
  "description": "运营查看报名、按渠道统计、导出名单",
  "pages": [
    {
      "title": "概览",
      "blocks": [
        { "type": "stat", "title": "总报名", "collection": "signups", "unit": "人" },
        { "type": "stat", "title": "待审核", "collection": "signups", "where": { "status": "pending" }, "unit": "人" },
        { "type": "chart", "title": "渠道分布", "collection": "signups", "chart": "pie", "field": "channel" },
        { "type": "chart", "title": "每日报名", "collection": "signups", "chart": "line", "timeField": "_createdAt", "interval": "day" },
        { "type": "text", "content": "数据实时读取，导出的 CSV 包含全部字段。" }
      ]
    },
    {
      "title": "报名管理",
      "blocks": [
        {
          "type": "table",
          "title": "报名名单",
          "collection": "signups",
          "columns": ["name", "mobile", "channel", "status"],
          "orderBy": [["_createdAt", "desc"]],
          "filters": [
            { "field": "status", "type": "select", "label": "状态" },
            { "field": "channel", "type": "select" }
          ],
          "search": { "fields": ["name", "mobile"], "placeholder": "搜索姓名或手机号" },
          "actions": { "detail": true, "edit": true, "delete": true }
        }
      ]
    }
  ]
}
```

## 设计建议

- **概览页放 3–5 个 stat + 1–2 个 chart**，一屏能看完关键数字
- **管理页一个集合一张表**，加必要的筛选和搜索；表格列控制在 6 列以内
- 状态、渠道、类型这类字段配 `filters`，运营最常用
- 手机号、身份证、评论这类敏感或长文本放详情，不要直接铺在表格里
- 需要「审核」流程时：`status` 用 `enum`（pending/approved/rejected），表格开 `edit`，运营改状态；同时给一个 `stat` 看待审数量
- 不要在一个页面堆超过 8 个区块；用 `pages` 拆开
- 不要写查询语句、SQL、代码；只描述字段和展示方式

## 不要做的事

- 引用未声明的集合或字段（会被拒绝）
- 用 `text` 区块承载大段业务文案（它是给运营看的说明，不是内容管理）
- 依赖 `where` 里的 `$regex`、`$where` 等非白名单操作符（会被拒绝）
- 给 `filters[].options` 传 `{ label, value }` 对象（会被拒绝，只能是纯值数组，见上）
