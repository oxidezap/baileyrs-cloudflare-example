import type { HostStoreCallbacks } from '@oxidezap/baileyrs/host'

export const createStore = (storage: DurableObjectStorage): HostStoreCallbacks => ({
  async get(namespace, key) {
    return (await storage.get<Uint8Array>(`${namespace}:${key}`)) ?? null
  },
  async set(namespace, key, value) {
    await storage.put(`${namespace}:${key}`, value)
  },
  async delete(namespace, key) {
    await storage.delete(`${namespace}:${key}`)
  },
  async setMany(namespace, entries) {
    await storage.put(Object.fromEntries(entries.map(([key, value]) => [`${namespace}:${key}`, value])))
  },
  async getMany(namespace, keys) {
    const values = await storage.get<Uint8Array>(keys.map(key => `${namespace}:${key}`))
    return keys.flatMap(key => {
      const value = values.get(`${namespace}:${key}`)
      return value ? [[key, value] as [string, Uint8Array]] : []
    })
  },
  async listKeys(namespace, prefix = '') {
    const values = await storage.list({ prefix: `${namespace}:${prefix}` })
    return [...values.keys()].map(key => key.slice(namespace.length + 1))
  }
})

export const serialize = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item instanceof Uint8Array ? { $bytes: Array.from(item) } : item
)

export const deserialize = <T>(value: string): T => JSON.parse(value, (_key, item: unknown) => {
  if (typeof item !== 'object' || item === null || !('$bytes' in item)) return item
  const bytes = item.$bytes
  if (!Array.isArray(bytes) || !bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    throw new Error('Invalid persisted byte array')
  }
  return new Uint8Array(bytes)
}) as T
