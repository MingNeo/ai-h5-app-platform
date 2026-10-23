# manifest.json 参考

## 它是干嘛的

`manifest.json` 是应用的配置文件，放在应用根目录。它不是页面，也不执行代码；平台在构建、发布和运行时读取它，用它决定：

- 应用叫什么、简介、横屏还是竖屏（后台列表和应用外壳使用）
- 打开应用是否必须先登录（`requireLogin`）
- 应用有哪些数据集合、每个集合的读写权限（ACL）、字段结构、索引、写入限制、内容审核
- 需要调用哪些业务接口前缀、申请哪些平台能力（都要后台审批）

平台据此做四件事：

1. **写入校验**：字段、类型、必填、长度、枚举，未声明字段直接拒绝
2. **服务端鉴权**：读哪些数据、能不能新增/修改/删除，全在网关上按 ACL 执行，改前端代码绕不过去
3. **数据能力**：排序/计数/分组要求对应索引；按人/按设备的条数和频率限制；公开文本的内容审核
4. **后台与发布**：后台数据台按字段渲染表格和表单；发布时对比新旧 manifest，提示删除集合、删字段、放宽 ACL、取消强制登录等风险

**先声明再使用**：SDK 只能访问 manifest 里声明过的集合和字段。没声明会报 `NOT_FOUND`；声明了但字段不对，写入会被拒绝。

## 生效方式

- **开发预览（dev）**：直接读草稿，改完立刻生效
- **测试版 / 线上（beta / prod）**：构建时把这份文件快照进版本，发布后才生效
- 后台设置页的「必须登录」开关，改的就是本文件的 `requireLogin`（写草稿，随发布生效）
- manifest 缺失或 JSON 非法会让构建失败，后台会显示具体错误
- 从集合里删掉的字段/集合，线上历史数据会保留，只是应用不能再访问
- ACL 放宽、取消强制登录等变更，发布时需要负责人确认

## 完整示例

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

示例只演示结构，不代表只能做投票类应用。集合名、字段、ACL 按实际需求设计。

## 顶层字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 应用名称，1–40 字 |
| `description` | 否 | 简介，最多 200 字 |
| `requireLogin` | 否 | 默认 `false`。`true` 时打开应用先登录；`false` 时游客可浏览，只有需要身份的操作遇到 401 才会拉起登录 |
| `orientation` | 否 | `portrait`（默认）/ `landscape` / `auto` |
| `capabilities` | 否 | 平台能力 key，最多 20 个；注册表当前为空，暂时不能声明，保持 `[]` |
| `bizApis` | 否 | 业务接口路径前缀，最多 50 个，例如 `"/api/coupon/"`；需后台申请并审批 |
| `dependencies` | 否 | 保留字段，当前没有可用依赖，保持 `[]` |
| `collections` | 否 | 数据集合定义，见下 |

顶层不允许出现未知字段（schema 是 strict 的），写错会直接报错。

## collections

集合名：小写字母开头，只能包含字母、数字、下划线，最长 48 位。

```json
"collections": {
  "signups": {
    "acl": "public_submit",
    "description": "活动报名",
    "fields": { "name": { "type": "string", "required": true }, "mobile": "string" },
    "indexes": [{ "fields": { "_createdAt": -1 } }],
    "limits": { "perUserDocs": 1, "writesPerMinute": 10 },
    "moderate": ["name"]
  }
}
```

### acl（必填）

| ACL | 读 | 新增 | 修改 / 删除 | 典型场景 |
|---|---|---|---|---|
| `private` | 本人 | 登录用户 | 本人 | 个人记录、记账、存档 |
| `public_read` | 所有人（含游客） | 登录用户 | 本人 | 留言、成绩、晒图、排行榜 |
| `submit_only` | 本人 | 登录用户 | 不能改删 | 报名、问卷、征集、投稿 |
| `public_submit` | 本人（游客按设备） | 游客可提交 | 不能改删 | 活动报名、抽奖、投票（不登录） |
| `public_write` | 所有人（含游客） | 游客可提交 | 本人（游客按设备） | 留言墙、晒图、接龙、公开投票 |
| `readonly` | 所有人 | 仅后台 | 仅后台 | 活动配置、内容、名额 |
| `admin_only` | 不可读 | 仅后台 | 仅后台 | 敏感收集 |

游客身份说明（`public_submit` / `public_write`）：

- 未登录也能写，数据归属 `_owner = vid:<app_vid cookie>`，可以读回、改删自己设备提交的内容
- `perUserDocs`、唯一索引、写入限流都按设备生效，能做「每台设备一次/一票」
- 游客身份是弱身份：清 cookie、换浏览器、换设备就是新身份；游客提交后再登录，两段数据不会合并
- 需要真实身份、防刷、跨设备同步时，用 `submit_only` / `public_read` / `private`，由登录用户提交
- 公开可写的集合建议配 `limits` 和 `moderate`

### fields

字段名 → 类型或字段定义：

```json
{
  "title": "string",
  "count": "integer",
  "price": "number",
  "active": "boolean",
  "tags": { "type": "array", "items": "string", "maxItems": 20 },
  "meta": "object"
}
```

对象形式支持的约束：`type`、`required`、`maxLength`、`minLength`、`min`、`max`、`enum`、`items`、`maxItems`。

- 写入数据只能包含声明过的字段，多传会被拒绝（`additionalProperties: false`）
- string 默认最长 2000，array 默认最多 200 项
- 单条数据最大 16KB
- 不要声明 `_` 开头的字段；系统字段 `_id`、`_owner`、`_ownerProfile`、`_createdAt`、`_updatedAt` 由平台维护
- 字段名以字母开头，只能包含字母、数字、下划线，最长 64 位；不能以 `$` 开头或包含 `.`

### indexes

最多 8 个。`{ "fields": { "score": -1, "_createdAt": -1 } }`。

- 排序字段、分组字段、`count()` 的筛选字段都必须建索引；线上缺索引会直接报错，开发预览只提示
- `"unique": true` 实现唯一约束，违反时接口报 `DUPLICATE`
- 可以给系统字段建索引，例如 `{ "_owner": 1 }` 做「一人一条」
- 新增唯一索引时如果线上已有重复数据，建索引会失败，需要先清理

### limits

| 字段 | 说明 |
|---|---|
| `perUserDocs` | 每个身份最多多少条；登录用户按 uid，游客按设备 |
| `writesPerMinute` | 每个身份每分钟最多写入次数；另有平台级总限流 |

### moderate

需要内容安全审核的字符串字段名数组，例如 `["name", "comment"]`。审核在新增和修改时执行，未通过会报 `VALIDATION_FAILED`。后台可配内容安全服务，未配置时按关键词拦截。

### description

可选的集合说明，显示在后台数据台。

## 和其他文件的关系

- `index.html` / `src/**/*.js`：应用代码，通过 `platform` 读写这里声明的数据
- `admin.json`：运营后台视图，引用的集合和字段必须与 manifest 一致；改 manifest 后同步更新
- 平台在返回页面时自动注入 SDK、Tailwind、样式，不需要在 HTML 里引用
- manifest 修改不会自动同步到 `admin.json`，两边都由你在草稿里维护

## 不要做的事

- 不要声明用不到的集合或字段，字段越多写入校验越严
- 不要把 `_owner`、`_createdAt` 之类的系统字段写进 `fields`
- 不要用未声明的字段排序/筛选/搜索（应用端会报错，后台会拒绝）
- 不要在 `bizApis` 里写没有在平台登记的前缀
- 不要手工改 `requireLogin` 之外的后台设置期望；后台只提供「必须登录」开关，其余配置以本文件为准
