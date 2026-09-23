import { beforeEach, expect, it, vi } from 'vitest'
import type { HostBaileysEventMap } from '@oxidezap/baileyrs/host'

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

beforeEach(() => {
  vi.resetAllMocks()
  host.makeSocket.mockReturnValue({ ev: { on: host.on } })
  host.authenticate.mockResolvedValue({ creds: { registered: true } })
})

it('keeps connection status with the socket across object restarts', async () => {
  const values = new Map<string, unknown>()
  const storage = {
    get: async (key: string) => values.get(key),
    put: async (key: string, value: unknown) => { values.set(key, value) }
  }
  const ctx = { storage } as unknown as DurableObjectState
  const env = { ADMIN_TOKEN: 'test', BOT: {} as DurableObjectNamespace<Bot> }
  const first = new Bot(ctx, env)
  await first.fetch(new Request('https://bot/start', { method: 'POST' }))
  const update = host.on.mock.calls.find(([event]) => event === 'connection.update')?.[1] as
    (event: HostBaileysEventMap['connection.update']) => Promise<void> | void
  await update({ connection: 'open' })
  expect(await (await first.fetch(new Request('https://bot/status'))).json()).toEqual({ state: 'connected' })
  const restarted = new Bot(ctx, env)
  expect(await (await restarted.fetch(new Request('https://bot/status'))).json()).toEqual({ state: 'stopped' })
})

it('clears revoked credentials before allowing a new pairing attempt', async () => {
  const values = new Map<string, unknown>([['device:device', new Uint8Array([1])]])
  const storage = {
    get: async (key: string) => values.get(key),
    deleteAll: vi.fn(async () => { values.clear() })
  }
  const bot = new Bot({ storage } as unknown as DurableObjectState, {
    ADMIN_TOKEN: 'test', BOT: {} as DurableObjectNamespace<Bot>
  })
  await bot.fetch(new Request('https://bot/start', { method: 'POST' }))
  const update = host.on.mock.calls.find(([event]) => event === 'connection.update')?.[1] as
    (event: HostBaileysEventMap['connection.update']) => Promise<void>
  await update({ connection: 'close', lastDisconnect: {
    date: new Date(), error: Object.assign(new Error('logged out'), { output: { statusCode: 401 } })
  } })
  expect(storage.deleteAll).toHaveBeenCalledOnce()
  expect(values.size).toBe(0)
  expect(await (await bot.fetch(new Request('https://bot/status'))).json()).toEqual({ state: 'logged_out' })
  await bot.fetch(new Request('https://bot/start', { method: 'POST' }))
  expect(host.authenticate).toHaveBeenCalledTimes(2)
})

it('passes native credentials to the socket without a stale snapshot', async () => {
  const storage = {
    get: async () => JSON.stringify({ registered: false }),
    put: vi.fn()
  }
  const bot = new Bot({ storage } as unknown as DurableObjectState, {
    ADMIN_TOKEN: 'test', BOT: {} as DurableObjectNamespace<Bot>
  })
  await bot.fetch(new Request('https://bot/start', { method: 'POST' }))
  expect(host.makeSocket.mock.calls[0]?.[0].auth.creds.registered).toBe(true)
})
