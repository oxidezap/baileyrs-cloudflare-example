import { describe, expect, it } from 'vitest'
import type { HostBaileysEventMap } from '@oxidezap/baileyrs/host'
import { replyText } from '../src/bot.ts'
import { createStore } from '../src/persistence.ts'
import { proto } from '@oxidezap/baileyrs/lib/WAProto/runtime.js'

const message = (text: string, fromMe = false, remoteJid = '15551234567@s.whatsapp.net') => ({
  key: { remoteJid, fromMe },
  message: { conversation: text }
}) as HostBaileysEventMap['messages.upsert']['messages'][number]

describe('bot input handling', () => {
  it('replies only to direct incoming ping messages', () => {
    expect(replyText(message(' Ping '))).toBe('pong')
    expect(replyText(message('ping', true))).toBeUndefined()
    expect(replyText(message('ping', false, '123@g.us'))).toBeUndefined()
    expect(replyText(message('ping', false, 'user@hosted.lid'))).toBe('pong')
    expect(replyText(message('pong'))).toBeUndefined()
  })

  it('accepts real protobuf messages with nullable inherited fields', () => {
    const protobuf = proto.Message.fromObject({ conversation: 'ping' })
    expect('protocolMessage' in protobuf).toBe(true)
    expect(protobuf.protocolMessage).toBeNull()
    expect(replyText({ key: { remoteJid: 'opaque@s.whatsapp.net' }, message: protobuf } as unknown as HostBaileysEventMap['messages.upsert']['messages'][number])).toBe('pong')
    expect(replyText({ key: { remoteJid: 'opaque@s.whatsapp.net' }, message: proto.Message.fromObject({ protocolMessage: {} }) } as unknown as HostBaileysEventMap['messages.upsert']['messages'][number])).toBeUndefined()
    expect(replyText({ key: { remoteJid: 'opaque@s.whatsapp.net' }, message: proto.Message.fromObject({ senderKeyDistributionMessage: {} }) } as unknown as HostBaileysEventMap['messages.upsert']['messages'][number])).toBeUndefined()
  })

  it('matches text inside disappearing messages', () => {
    const ephemeral = { key: { remoteJid: '123@s.whatsapp.net' }, message: {
      ephemeralMessage: { message: { extendedTextMessage: { text: 'ping' } } }
    } } as HostBaileysEventMap['messages.upsert']['messages'][number]
    expect(replyText(ephemeral)).toBe('pong')
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
})
