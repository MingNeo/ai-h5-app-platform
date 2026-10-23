# manifest.json 参考

```json
{
  "name": "春季好物投票",
  "description": "可选，应用简介",
  "requireLogin": false,
  "orientation": "portrait",
  "capabilities": [],
  "bizApis": [],
  "dependencies": [],
  "collections": {
    "votes": {
      "acl": "public_read",
      "description": "投票记录",
      "fields": {
        "option": { "type": "string", "required": true, "enum": ["a", "b", "c"] },
        "comment": { "type": "string", "maxLength": 200 },
        "score": "number"
      },
      "indexes": [
        { "fields": { "option": 1 } },
        { "fields": { "_owner": 1 }, "unique": true }
      ],
      "limits": { "perUserDocs": 1, "writesPerMinute": 10 },
      "moderate": ["comment"]
    }
  }
}
```

## 字段说明
- `requireLogin`: true 时打开应用必须先登录（适合个人工具）；活动页一般用 false，需要时再拉起登录。
- `orientation`: `portrait` | `landscape` | `auto`。
- `capabilities`: 平台能力 key 列表，当前注册表为空；声明后还需在后台「能力」页申请并通过审批。
- `bizApis`: 业务接口路径前缀，例如 `"/api/coupon/"`，需在后台申请。
- `dependencies`: 保留字段，当前没有可用依赖（应用是纯 HTML + 原生 JS，没有 npm 包），保持为空数组。

## collections
集合名：小写字母开头，只能包含字母、数字、下划线。

`acl`（必填，选一种）：
| 预设 | 读 | 写 | 场景 |
|---|---|---|---|
| `private` | 本人 | 本人增删改 | 个人记录、记账、存档 |
| `public_read` | 所有人（含游客） | 本人增删改 | 留言、成绩、投票 |
| `submit_only` | 本人 | 只能新增 | 报名、问卷 |
| `readonly` | 所有人 | 仅后台 | 活动配置、内容 |
| `admin_only` | 不可读 | 仅后台 | 敏感收集 |

`fields`：字段名 → 类型（`string` `number` `integer` `boolean` `object` `array`），或对象
`{ "type", "required", "maxLength", "minLength", "min", "max", "enum", "items", "maxItems" }`。
**写入的数据只能包含声明过的字段**（未声明的字段会被拒绝），string 默认最长 2000。
不要声明 `_` 开头的字段，系统字段（`_id`、`_owner`、`_ownerProfile`、`_createdAt`、`_updatedAt`）由平台自动维护。

`indexes`：最多 8 个。用于排序、计数、分组的字段都要建索引；`"unique": true` 实现唯一约束（违反时报 `DUPLICATE`）。
可以对系统字段建索引，例如 `{ "_owner": 1 }`。

`limits`：`perUserDocs` 每人最多条数，`writesPerMinute` 每人每分钟写入次数。

`moderate`：需要内容安全审核的字符串字段（公开展示的用户输入建议都加上）。
