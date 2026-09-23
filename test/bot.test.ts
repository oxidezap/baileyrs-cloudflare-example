import { describe, expect, it } from 'vitest'
import type { HostBaileysEventMap } from '@oxidezap/baileyrs/host'
import { replyText } from '../src/bot.ts'
import { createStore, deserialize, serialize } from '../src/persistence.ts'

const message = (text: string, fromMe = false, remoteJid = '15551234567@s.whatsapp.net') => ({
  key: { remoteJid, fromMe },
  message: { conversation: text }
}) as HostBaileysEventMap['messages.upsert']['messages'][number]

describe('bot input handling', () => {
  it('replies only to direct incoming ping messages', () => {
    expect(replyText(message(' Ping '))).toBe('pong')
    expect(replyText(message('ping', true))).toBeUndefined()
    expect(replyText(message('ping', false, '123@g.us'))).toBeUndefined()
    expect(replyText(message('pong'))).toBeUndefined()
  })

  it('reads auth keys after a Durable Object restart', async () => {
    const values = new Map<string, unknown>()
    const storage = {
      get: async (key: string) => values.get(key),
      put: async (key: string | Record<string, unknown>, value?: unknown) => {
        if (typeof key === 'string') values.set(key, value)
        else for (const [entry, item] of Object.entries(key)) values.set(entry, item)
      },
      delete: async (key: string) => values.delete(key),
      list: async ({ prefix }: { prefix: string }) => new Map([...values].filter(([key]) => key.startsWith(prefix)))
    } as unknown as DurableObjectStorage
    const firstBoot = createStore(storage)
    await firstBoot.set('session', 'key', new Uint8Array([7, 8]))
    const nextBoot = createStore(storage)
    expect(await nextBoot.get('session', 'key')).toEqual(new Uint8Array([7, 8]))
  })

  it('keeps typed byte arrays intact in persisted credentials', () => {
    const credentials = { identity: new Uint8Array([0, 3, 255]) }
    expect(deserialize<typeof credentials>(serialize(credentials))).toEqual(credentials)
  })
})
