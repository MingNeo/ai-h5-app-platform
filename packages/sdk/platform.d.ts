// 平台 SDK 全局类型声明（由平台维护，应用不可修改）
// 运行时由平台在 index.html 中注入 /__platform/boot.js，挂载为全局变量 `platform`。

declare global {
  const platform: AppPlatform.Platform
  interface Window {
    platform: AppPlatform.Platform
  }

  // 全局命名空间：应用里的 src/biz-api.d.ts（平台生成）通过声明合并补充 BizApiResults
  namespace AppPlatform {
    interface User {
      uid: string
      nickname: string
      avatar: string
    }

    type ErrorCode =
      | 'LOGIN_REQUIRED'
      | 'LOGIN_CANCELLED'
      | 'FORBIDDEN'
      | 'NOT_FOUND'
      | 'DUPLICATE'
      | 'VALIDATION_FAILED'
      | 'RATE_LIMITED'
      | 'QUOTA_EXCEEDED'
      | 'CAPABILITY_NOT_GRANTED'
      | 'UPSTREAM_ERROR'
      | 'NETWORK_ERROR'
      | 'INTERNAL_ERROR'

    interface PlatformError extends Error {
      name: 'PlatformError'
      code: ErrorCode
      status: number
      /** 业务接口返回的原始 error_code */
      upstreamCode?: number | string
    }

    type Primitive = string | number | boolean | null
    type Operator = '$eq' | '$ne' | '$gt' | '$gte' | '$lt' | '$lte' | '$in' | '$nin' | '$exists'
    type FieldCondition = Primitive | Partial<Record<Operator, Primitive | Primitive[]>>
    interface Where {
      $and?: Where[]
      $or?: Where[]
      [field: string]: FieldCondition | Where[] | undefined
    }

    /** 每条数据都带的系统字段 */
    interface SystemFields {
      _id: string
      /** 创建者 uid */
      _owner: string
      /** 创建者昵称、头像（写入时的快照） */
      _ownerProfile?: { nickname: string, avatar: string }
      /** 毫秒时间戳 */
      _createdAt: number
      _updatedAt: number
    }

    type Doc<T = Record<string, any>> = T & SystemFields

    interface QueryResult<T> {
      list: Doc<T>[]
      hasMore: boolean
    }

    interface Query<T> {
      where(where: Where): Query<T>
      orderBy(field: string, direction?: 'asc' | 'desc'): Query<T>
      limit(n: number): Query<T>
      skip(n: number): Query<T>
      /** 只返回这些字段 */
      fields(fields: string[]): Query<T>
      /** 只查当前用户自己创建的数据（需要登录） */
      mine(): Query<T>
      get(): Promise<QueryResult<T>>
      count(): Promise<number>
      /** 按字段分组计数，例如投票统计 */
      groupCount(field: string): Promise<Array<{ value: Primitive, count: number }>>
    }

    interface DocRef<T> {
      get(): Promise<Doc<T> | null>
      update(patch: Partial<T>): Promise<Doc<T>>
      remove(): Promise<void>
    }

    interface Collection<T = Record<string, any>> extends Query<T> {
      add(data: T): Promise<Doc<T>>
      doc(id: string): DocRef<T>
    }

    interface BizRequestOptions {
      method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
      /** GET 时作为 query，其余方法作为 JSON body */
      data?: Record<string, any>
      query?: Record<string, string | number | boolean | undefined>
      headers?: Record<string, string>
    }

    /** 已登记业务接口的返回类型，由平台按接口目录生成到 src/biz-api.d.ts */
    interface BizApiResults {}

    interface Platform {
      /** 初始化完成（包括自动登录检查） */
      ready(): Promise<void>
      app: {
        appId: string
        channel: 'prod' | 'beta' | 'dev'
        version: string
      }
      env: {
        inApp: boolean
        /** 宿主 App 容器标识（由平台配置），普通浏览器为 browser */
        container: string
        os: 'ios' | 'android' | 'harmony' | 'other'
      }
      auth: {
        readonly user: User | null
        readonly isLogin: boolean
        /** 拉起全局登录；用户取消时 reject，错误码 LOGIN_CANCELLED */
        login(): Promise<User>
        logout(): Promise<void>
        /** 用户登录状态变化时回调，返回取消监听函数 */
        onChange(cb: (user: User | null) => void): () => void
      }
      db: {
        collection<T = Record<string, any>>(name: string): Collection<T>
      }
      kv: {
        /** 当前用户私有的键值存储（需要登录） */
        user: {
          get<T = any>(key: string): Promise<T | null>
          set(key: string, value: unknown): Promise<void>
          remove(key: string): Promise<void>
        }
        /** 应用级只读配置（在后台数据台维护） */
        app: {
          get<T = any>(key: string): Promise<T | null>
        }
      }
      files: {
        /** 上传文件（需要登录），返回可直接用于 <img src> 的 url */
        upload(file: Blob, options?: { public?: boolean, name?: string }): Promise<{ fileId: string, url: string, size: number, mime: string }>
      }
      biz: {
        /**
         * 调用已授权的业务接口，自动处理未登录。
         * 已登记的接口按 path 推断返回类型（见 src/biz-api.d.ts）；需要自定义时传 T。
         */
        request<T = never, P extends string = string>(path: P, options?: BizRequestOptions): Promise<[T] extends [never] ? (P extends keyof BizApiResults ? BizApiResults[P] : any) : T>
      }
      /** 自定义埋点 */
      track(event: string, props?: Record<string, unknown>): void
      isPlatformError(e: unknown): e is PlatformError
    }
  }
}

export {}
