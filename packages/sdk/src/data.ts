import { api, rawApi } from './http'

type Primitive = string | number | boolean | null
type Where = Record<string, unknown>

interface QueryState {
  where?: Where
  orderBy: Array<[string, 'asc' | 'desc']>
  limit?: number
  skip?: number
  fields?: string[]
  mine: boolean
}

const enc = encodeURIComponent

class Query {
  constructor(protected name: string, protected state: QueryState = { orderBy: [], mine: false }) {}

  protected next(patch: Partial<QueryState>): Query {
    return new Query(this.name, { ...this.state, ...patch })
  }

  where(where: Where) {
    return this.next({ where: this.state.where ? { $and: [this.state.where, where] } : where })
  }

  orderBy(field: string, direction: 'asc' | 'desc' = 'asc') {
    return this.next({ orderBy: [...this.state.orderBy, [field, direction]] })
  }

  limit(n: number) {
    return this.next({ limit: n })
  }

  skip(n: number) {
    return this.next({ skip: n })
  }

  fields(fields: string[]) {
    return this.next({ fields })
  }

  mine() {
    return this.next({ mine: true })
  }

  get() {
    return api<{ list: unknown[], hasMore: boolean }>(`/db/${enc(this.name)}/query`, { method: 'POST', body: this.state })
  }

  async count() {
    const res = await api<{ count: number }>(`/db/${enc(this.name)}/count`, { method: 'POST', body: this.state })
    return res.count
  }

  async groupCount(field: string) {
    const res = await api<{ groups: Array<{ value: Primitive, count: number }> }>(`/db/${enc(this.name)}/group`, {
      method: 'POST',
      body: { ...this.state, field },
    })
    return res.groups
  }
}

class Collection extends Query {
  add(data: unknown) {
    return api(`/db/${enc(this.name)}`, { method: 'POST', body: { data } })
  }

  doc(id: string) {
    const path = `/db/${enc(this.name)}/${enc(id)}`
    return {
      get: async () => {
        try {
          return await api(path)
        }
        catch (e: any) {
          if (e?.code === 'NOT_FOUND')
            return null
          throw e
        }
      },
      update: (patch: unknown) => api(path, { method: 'PATCH', body: { data: patch } }),
      remove: async () => {
        await api(path, { method: 'DELETE' })
      },
    }
  }
}

export const db = {
  collection(name: string) {
    return new Collection(name)
  },
}

export const kv = {
  user: {
    async get(key: string) {
      const res = await api<{ value: unknown }>(`/kv/user/${enc(key)}`)
      return res.value ?? null
    },
    async set(key: string, value: unknown) {
      await api(`/kv/user/${enc(key)}`, { method: 'PUT', body: { value } })
    },
    async remove(key: string) {
      await api(`/kv/user/${enc(key)}`, { method: 'DELETE' })
    },
  },
  app: {
    async get(key: string) {
      const res = await rawApi<{ value: unknown }>(`/kv/app/${enc(key)}`)
      return res.value ?? null
    },
  },
}

export const files = {
  upload(file: Blob, options: { public?: boolean, name?: string } = {}) {
    return api<{ fileId: string, url: string, size: number, mime: string }>('/files', {
      method: 'POST',
      rawBody: (() => {
        const fd = new FormData()
        fd.append('public', options.public === false ? '0' : '1')
        fd.append('file', file, options.name ?? (file as File).name ?? 'file')
        return fd
      })(),
    })
  },
}
