# manifest.json 参考（开发者）

每个应用根目录下的 `manifest.json` 是平台读取的配置，不是运行时代码。构建、发布、网关鉴权和后台数据台都以它为准。

- 生效渠道：`dev` 直接读草稿；`beta` / `prod` 读对应构建快照
- 校验时机：`check`、构建、应用启动时都会解析；非法 JSON 或 schema 错误会阻断构建
- 后台设置页的「必须登录」开关改的就是这里的 `requireLogin`，写草稿，随发布生效
- 同一份文件也用于后台数据和 `admin.json` 的集合/字段校验

```json
{
  "name": "春季活动报名",
  "description": "报名 + 留言墙",
  "requireLogin": false,
  "orientation": "portrait",
  "capabilities": [],
  "bizApis": [],
  "dependencies": [],
  "collections": {
    "signups": {
      "acl": "submit_only",
      "description": "报名记录",
      "fields": {
        "name": { "type": "string", "required": true, "maxLength": 40 },
        "mobile": { "type": "string", "required": true },
        "channel": { "type": "string", "enum": ["douyin", "weibo", "other"] }
      },
      "indexes": [
        { "fields": { "_owner": 1 }, "unique": true },
        { "fields": { "channel": 1 } }
      ],
      "limits": { "perUserDocs": 1, "writesPerMinute": 10 },
      "moderate": ["name"]
    },
    "messages": {
      "acl": "public_write",
      "fields": { "content": { "type": "string", "required": true, "maxLength": 200 } },
      "indexes": [{ "fields": { "_createdAt": -1 } }],
      "moderate": ["content"]
    }
  }
}
```

## 顶层字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string，必填 | 1–40 字，后台和应用占位页使用 |
| `description` | string | 最多 200 字 |
| `requireLogin` | boolean，默认 `false` | `true` 时打开应用先登录；`false` 时游客可访问，需要身份的接口遇 401 才拉起登录 |
| `orientation` | `portrait` / `landscape` / `auto` | 默认 `portrait` |
| `capabilities` | string[]，≤20 | 平台能力 key；注册表当前为空，暂时不能声明任何能力，保持 `[]` |
| `bizApis` | string[]，≤50 | 业务接口前缀，如 `"/api/coupon/"`；必须已在平台目录登记并审批 |
| `dependencies` | string[] | 保留字段，当前无可用依赖，保持空数组 |
| `collections` | object | 集合定义，见下 |

schema 是 strict 的：顶层出现未知字段直接报错。

## collections

```json
"collections": {
  "signups": {
    "acl": "submit_only",
    "description": "报名记录",
    "fields": { "name": "string" },
    "indexes": [{ "fields": { "_owner": 1 }, "unique": true }],
    "limits": { "perUserDocs": 1, "writesPerMinute": 10 },
    "moderate": ["name"]
  }
}
```

- 集合名：`^[a-z][a-zA-Z0-9_]{0,47}$`
- 只声明用得到的集合；未声明的集合在 SDK 里访问会报 `NOT_FOUND`

### acl

服务端强制，前端改代码无法绕过。`读`/`写` 指应用端能做什么；后台管理视角不受 ACL 限制。

| ACL | 读 | 新增 | 修改/删除 | 建议场景 |
|---|---|---|---|---|
| `private` | 本人 | 登录用户 | 本人 | 个人存档、设置 |
| `public_read` | 所有人（含游客） | 登录用户 | 本人 | 留言、成绩、晒图 |
| `submit_only` | 本人 | 登录用户 | 不能 | 报名、问卷、投稿（需要登录） |
| `public_write` | 所有人（含游客） | 游客 | 本人（游客按设备） | 留言墙、晒图、接龙、公开投票 |
| `readonly` | 所有人 | 仅后台 | 仅后台 | 活动配置、名额 |
| `admin_only` | 不可读 | 仅后台 | 仅后台 | 敏感收集 |

设计原则：按用户隔离数据（只能读回自己提交的）必须要求登录，不允许靠游客设备身份免登录隔离。`public_submit` 已废弃，服务端解析时等同 `submit_only`（游客提交会被要求登录），管理后台也不再允许新选它（历史配置仍兼容显示）。

`public_write` 的游客实现：

- 未登录访问时，网关用 `app_vid` cookie（`boot.js` 首次访问时写入，随机 12 字节，一年有效）生成身份，`_owner = vid:<值>`
- 没有 cookie（例如被禁用）时退回 `ip:<客户端 IP>`，同一出口 IP 的游客会共享身份，慎用「每人一次」类约束
- `mine()`、`perUserDocs`、唯一索引、写入限流都按这个身份生效
- 游客可清 cookie / 换设备变成新身份；游客提交后登录，数据不会迁移到账号。需要强身份时用 `submit_only` / `public_read`，由登录用户提交
- 游客可以改/删自己设备提交的记录

### fields

```json
"fields": {
  "title": "string",
  "count": "integer",
  "price": "number",
  "active": "boolean",
  "tags": { "type": "array", "items": "string", "maxItems": 20 },
  "meta": "object"
}
```

对象形式支持：`type`、`required`、`maxLength`、`minLength`、`min`、`max`、`enum`、`items`、`maxItems`。

- 写入走 AJV，`additionalProperties: false`：未声明字段会被拒绝
- string 默认 `maxLength: 2000`；array 默认 `maxItems: 200`；单条文档上限 16KB
- 字段名：`^[a-zA-Z][a-zA-Z0-9_]{0,63}$`，不能以 `$` 开头或包含 `.`
- 不要声明 `_` 开头的字段。系统字段由网关写入：`_id`、`_owner`、`_ownerProfile`、`_createdAt`、`_updatedAt`

### indexes

最多 8 个，`{ "fields": { "score": -1, "_createdAt": -1 } }`。

- 排序、分组、`count()` 的筛选字段必须建索引。`prod` 缺索引直接报错；`dev` 只上报 `data-warning`
- `"unique": true` 违反时报 `DUPLICATE`；线上已有重复数据时新增唯一索引会失败，需先清理
- 允许系统字段，例如 `{ "_owner": 1 }` 实现一人一条

### limits

| 字段 | 说明 |
|---|---|
| `perUserDocs` | 每个身份的文档上限；登录用户按 uid，游客按设备 |
| `writesPerMinute` | 每个身份每分钟写入次数；另有平台级 `WRITES_PER_MINUTE_PER_USER`（默认 120） |

### moderate

字符串字段名数组。新增/修改时依次过内容审核：配置了 `MODERATION_URL` 调外部服务，否则按关键词拦截；不通过报 `VALIDATION_FAILED`。公开可写集合建议把自由文本字段都列上。

## 变更与发布

- 草稿修改在 `dev` 立即生效；`beta` / `prod` 需要重新构建并发布
- `compareManifest()` 对线上版本做对比，以下变更会要求负责人确认：
  - 删除集合、删除字段
  - ACL 放宽（`ACL_OPENNESS` 变大）
  - `requireLogin` 从 `true` 改为 `false`
- 声明未登记的能力会直接校验失败；未审批的 `bizApis` 只给警告，调用会 403
- 删除集合或字段不会删除线上历史数据，只是应用不能再访问
- 发布时按新 manifest 在 prod 库补建索引，不删除已有索引和数据

## 与 admin.json 的关系

- `admin.json` 里引用的集合、字段必须在 manifest 中声明，否则拒绝写入
- 改 manifest 后同步更新 `admin.json`，两边随同一个草稿和发布版本流转
- `admin.json` 不通过应用路径对外提供；manifest 作为应用文件会随源码返回

## 常见错误

| 现象 | 原因 |
|---|---|
| `NOT_FOUND` | 集合没声明，或当前渠道生效的 manifest 里没有 |
| `VALIDATION_FAILED` | 字段未声明、类型/枚举/长度不符、内容审核不通过 |
| `FORBIDDEN` | ACL 不允许该操作（例如 `readonly` 新增、改别人的数据） |
| `LOGIN_REQUIRED` | 该操作需要登录（例如 `public_read` 新增、`private` 读写） |
| `DUPLICATE` | 违反唯一索引 |
| `QUOTA_EXCEEDED` | 超过 `perUserDocs` |
| `RATE_LIMITED` | 超过集合或平台写入频率 |
| 线上查询报「字段未声明索引」 | `orderBy` / 分组 / `count` 筛选字段没写进 `indexes` |
