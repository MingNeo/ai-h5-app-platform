# 平台 SDK（全局对象 `platform`，无需 import）

`platform` 是应用和平台之间唯一的通道：登录、数据、KV、上传、业务接口、埋点都在这里。平台会自动注入每个页面，不要自己引用 `/__platform/boot.js`。

## 身份与登录

- 页面默认对游客开放；manifest 的 `requireLogin: true` 才会在启动时强制登录
- 未登录时，调用需要身份的数据操作会返回 401，SDK 自动拉起一次登录并在成功后重放请求，不需要每个请求手动判断
- `public_submit` / `public_write` 集合允许游客写：`_owner` 是设备标识 `vid:<app_vid>`，`mine()` 按设备查自己的数据
- 游客身份是弱身份：清 cookie、换设备就是新身份；需要可靠身份时用登录用户（`submit_only` / `private` / `public_read`）

```ts
// 初始化（含一次登录状态检查）。需要立刻知道登录状态的地方先 await
await platform.ready()

// ---------- 登录 ----------
platform.auth.user            // { uid, nickname, avatar } | null
platform.auth.isLogin         // boolean
await platform.auth.login()   // 拉起全局登录；用户取消时抛 PlatformError，code 为 'LOGIN_CANCELLED'
const off = platform.auth.onChange(user => { /* 登录状态变化 */ })
await platform.auth.logout()

// ---------- 数据库（集合需先在 manifest.json 声明） ----------
// 未声明的集合/字段会报 NOT_FOUND；权限、字段校验、索引、限流都由网关按 manifest 执行。
const votes = platform.db.collection<{ option: string }>('votes')
const doc = await votes.add({ option: 'a' })          // 能否游客写入由集合 ACL 决定；返回带系统字段的文档
const { list, hasMore } = await votes
  .where({ option: 'a', score: { $gte: 60 } })         // 操作符：$eq $ne $gt $gte $lt $lte $in $nin $exists，支持 $and/$or
  .orderBy('score', 'desc')                            // 排序字段必须在 manifest 的 indexes 中声明
  .skip(0).limit(20)                                   // limit 最大 100
  .get()
const n = await votes.where({ option: 'a' }).count()
const groups = await votes.groupCount('option')       // [{ value: 'a', count: 12 }, ...]
const mine = await votes.mine().get()                  // 只查自己创建的；游客按设备（public_submit / public_write）
const one = await votes.doc(id).get()                  // 不存在返回 null
await votes.doc(id).update({ option: 'b' })            // 只能改自己创建的
await votes.doc(id).remove()

// 每条文档都有系统字段：
// _id: string, _owner: string（登录用户是 uid，游客是 vid:<设备标识>）,
// _ownerProfile: { nickname, avatar }, _createdAt / _updatedAt: 毫秒时间戳

// ---------- 键值存储 ----------
await platform.kv.user.set('save', { level: 3 })      // 当前用户私有（需要登录），适合游戏存档、偏好设置
const save = await platform.kv.user.get('save')        // 不存在返回 null
const cfg = await platform.kv.app.get('config')        // 应用级只读配置，由运营在后台数据台维护

// ---------- 文件 ----------
const { url } = await platform.files.upload(file, { public: true })  // 需要登录；图片/音频/视频，≤5MB；url 可直接用于 <img src>

// ---------- 业务接口（需在 manifest.bizApis 声明前缀并经后台审批） ----------
// 请求经平台同源代理（/__platform/api/biz/*）转发到上游，不需要考虑 CORS，也不要直接 fetch 上游地址。
// 返回的是上游的完整响应体。主站统一信封是 { error_code, error_msg, data }：
// error_code 非 0 或未登录时 SDK 会抛 PlatformError（需要登录会自动拉起登录并重试），
// 所以拿到返回值时一定是成功响应，按文档里的结构取字段即可。
// 已登记的接口会按路径推断返回类型（src/biz-api.d.ts 由平台生成）；参数与返回以 read_biz_api 读到的文档为准。
const res = await platform.biz.request('/api/v1/home/questions', { method: 'POST' })
const questions = res.data.questions
const created = await platform.biz.request('/api/coupon', { method: 'POST', data: { title: 'x' } })  // 其余方法：data 作为 JSON body

// ---------- 其他 ----------
platform.env        // { inApp, container: string（配置的容器 id，如 app-a / app-b；普通浏览器为 'browser'）, os }
platform.app        // { appId, channel: 'prod' | 'beta' | 'dev', version }
platform.track('click_vote', { option: 'a' })   // 自定义埋点
platform.isPlatformError(e)                      // 判断是否平台错误
```

## 错误处理
所有方法失败时抛 `PlatformError`，`e.code` 取值：
`LOGIN_REQUIRED`、`LOGIN_CANCELLED`（用户关掉登录框，通常静默处理即可）、`FORBIDDEN`、`NOT_FOUND`、`DUPLICATE`（违反唯一约束，如重复投票）、
`VALIDATION_FAILED`（数据不符合 schema，`e.message` 有原因）、`RATE_LIMITED`、`QUOTA_EXCEEDED`（如超过每人条数上限）、
`CAPABILITY_NOT_GRANTED`、`UPSTREAM_ERROR`、`NETWORK_ERROR`。

```ts
import { showToast } from 'vant'
try {
  await votes.add({ option })
}
catch (e) {
  if (platform.isPlatformError(e)) {
    if (e.code === 'LOGIN_CANCELLED') return
    if (e.code === 'DUPLICATE') return showToast('你已经投过票了')
    return showToast(e.message)
  }
  throw e
}
```

## 常见模式

下面只是数据建模的常见组合，不是活动形态清单。打卡、签到、接龙、预约、征集、摊主申请、抽签分组等，都是按同样的集合 + 唯一索引思路自己组合出来的。

- 一人一票 / 一人一次报名：集合加唯一索引 `{ "fields": { "_owner": 1 }, "unique": true }`；按选项各一票：`{ "fields": { "_owner": 1, "itemId": 1 }, "unique": true }`。
- 点赞：单独建 `likes` 集合（唯一索引 `_owner + postId`），用 `where({ postId }).count()` 统计。
- 排行榜：`public_read` 集合存成绩，`orderBy('score', 'desc').limit(50)`，score 必须声明索引；每人只保留最好成绩时，先 `mine()` 查到自己的记录再 `update`。游客也能参与就用 `public_write`。
- 报名/问卷：`submit_only` 集合，用户提交后只能看到自己的，运营在后台导出。活动页要求不登录也能提交时用 `public_submit`（游客按设备归属，同样能读自己的）；还要展示所有人内容（留言墙、晒图、排行榜、公开投票）就用 `public_write`。
- 每日打卡/签到：`private` 或 `submit_only` 集合，唯一索引 `_owner + day`（`day` 存 `YYYY-MM-DD`），用 `where({ _owner })` 查自己的记录算连续天数。不登录的签到用 `public_submit`（按设备区分）。
- 接龙/名额：`public_read`（或游客参与用 `public_write`）集合存参与记录，另建 `readonly` 集合存名额和截止时间；提交前用 `count()` 判断是否满员。
- 活动配置（标题、时间、奖项说明）：`readonly` 集合或 `platform.kv.app`，由运营在后台维护。
