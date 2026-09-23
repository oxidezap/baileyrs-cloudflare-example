import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { HostBaileysEventMap, HostStoreCallbacks } from '@oxidezap/baileyrs/host'

const host = vi.hoisted(() => ({
  on: vi.fn(),
  makeSocket: vi.fn(),
  authenticate: vi.fn()
}))

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(public ctx: DurableObjectState, public env: unknown) {}
  }
}))
vi.mock('../src/bridge.wasm', () => ({ default: new Uint8Array() }))
vi.mock('@oxidezap/whatsapp-rust-bridge/host', () => ({ initSync: vi.fn() }))
vi.mock('@oxidezap/baileyrs/host', () => ({
  default: host.makeSocket,
  createAuthenticationState: host.authenticate
}))

import { Bot } from '../src/index.ts'

const request = (path: '/start' | '/status', method: 'GET' | 'POST' = 'GET') =>
  new Request(`https://bot${path}`, { method })

const createStorage = (values = new Map<string, unknown>()) => ({
  values,
  get: async (key: string) => values.get(key),
  put: async (key: string, value: unknown) => { values.set(key, value) },
  deleteAll: vi.fn(async () => { values.clear() })
})

const createContext = (storage: ReturnType<typeof createStorage>) => ({
  storage,
  blockConcurrencyWhile: async (callback: () => Promise<void>) => callback()
}) as unknown as DurableObjectState

const createEnv = () => ({ ADMIN_TOKEN: 'test', BOT: {} as DurableObjectNamespace<Bot> })

const latestConnectionUpdate = () => host.on.mock.calls
  .filter(([event]) => event === 'connection.update')
  .at(-1)?.[1] as (event: HostBaileysEventMap['connection.update']) => Promise<void> | void

afterEach(() => vi.restoreAllMocks())

beforeEach(() => {
  vi.resetAllMocks()
  host.makeSocket.mockReturnValue({ ev: { on: host.on } })
  host.authenticate.mockResolvedValue({ creds: { registered: false } })
})

it('restores persisted credentials on a new instance without requiring POST /start', async () => {
  host.authenticate.mockImplementation(async (store: HostStoreCallbacks) => ({
    creds: { registered: Boolean(await store.get('auth', 'registered')) }
  }))
  const storage = createStorage()
  const ctx = createContext(storage)
  const env = createEnv()
  const first = new Bot(ctx, env)

  expect(await (await first.fetch(request('/status'))).json()).toEqual({ state: 'stopped' })
  expect(host.makeSocket).not.toHaveBeenCalled()

  await first.fetch(request('/start', 'POST'))
  await latestConnectionUpdate()({ qr: 'pairing-qr' })
  expect(await (await first.fetch(request('/status'))).json()).toEqual({ state: 'waiting_for_qr', qr: 'pairing-qr' })
  await storage.put('auth:registered', new Uint8Array([1])) // pairing persisted credentials in the shared durable store
  await latestConnectionUpdate()({ connection: 'open' })
  expect(await (await first.fetch(request('/status'))).json()).toEqual({ state: 'connected' })

  const restarted = new Bot(ctx, env)
  expect(await (await restarted.fetch(request('/status'))).json()).toEqual({ state: 'connecting' })
  expect(host.authenticate).toHaveBeenCalledTimes(3)
  expect(host.makeSocket).toHaveBeenCalledTimes(2)
  expect(await (await restarted.fetch(request('/status'))).json()).toEqual({ state: 'connecting' })
  expect(host.makeSocket).toHaveBeenCalledTimes(2)
})

it('retries a closed authenticated socket on status after a cooldown, without duplicate starts', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
  host.authenticate.mockResolvedValue({ creds: { registered: true } })
  const bot = new Bot(createContext(createStorage()), createEnv())
  await bot.fetch(request('/status'))
  expect(host.makeSocket).toHaveBeenCalledTimes(1)

  await latestConnectionUpdate()({ connection: 'close', lastDisconnect: {
    date: new Date(), error: new Error('temporary disconnect')
  } })
  await bot.fetch(request('/status'))
  expect(host.makeSocket).toHaveBeenCalledTimes(1)

  now.mockReturnValue(1_031_000)
  const [first, second] = await Promise.all([
    bot.fetch(request('/status')),
    bot.fetch(request('/status'))
  ])
  expect(await first.json()).toEqual({ state: 'connecting' })
  expect(await second.json()).toEqual({ state: 'connecting' })
  expect(host.makeSocket).toHaveBeenCalledTimes(2)
})

it('bounds repeated /start attempts when socket creation fails', async () => {
  host.makeSocket.mockImplementationOnce(() => { throw new Error('temporary socket failure') })
  const bot = new Bot(createContext(createStorage()), createEnv())
  await expect(bot.fetch(request('/start', 'POST'))).rejects.toThrow('temporary socket failure')
  expect(await (await bot.fetch(request('/start', 'POST'))).json()).toEqual({
    state: 'closed', error: 'Could not start WhatsApp connection'
  })
  expect(host.makeSocket).toHaveBeenCalledOnce()
})

it('clears revoked credentials before allowing a new pairing attempt', async () => {
  const values = new Map<string, unknown>([['device:device', new Uint8Array([1])]])
  host.authenticate.mockResolvedValue({ creds: { registered: true } })
  const storage = createStorage(values)
  const bot = new Bot(createContext(storage), createEnv())
  await bot.fetch(request('/status'))
  await latestConnectionUpdate()({ connection: 'close', lastDisconnect: {
    date: new Date(), error: Object.assign(new Error('logged out'), { output: { statusCode: 401 } })
  } })
  expect(storage.deleteAll).toHaveBeenCalledOnce()
  expect(values.size).toBe(0)
  expect(await (await bot.fetch(request('/status'))).json()).toEqual({ state: 'logged_out' })
  await bot.fetch(request('/start', 'POST'))
  expect(host.authenticate).toHaveBeenCalledTimes(2)
  expect(host.makeSocket).toHaveBeenCalledTimes(2)
})

it('passes native credentials to the socket without a stale snapshot', async () => {
  host.authenticate.mockResolvedValue({ creds: { registered: true } })
  const bot = new Bot(createContext(createStorage()), createEnv())
  await bot.fetch(request('/status'))
  expect(host.makeSocket.mock.calls[0]?.[0].auth.creds.registered).toBe(true)
})
