import type { HostBaileysEventMap, HostWASocket } from '@oxidezap/baileyrs/host'

export type BotStatus = {
  state: 'stopped' | 'connecting' | 'waiting_for_qr' | 'connected' | 'logged_out' | 'closed'
  qr?: string
  error?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const replyText = (message: HostBaileysEventMap['messages.upsert']['messages'][number]): string | undefined => {
  const jid = message.key.remoteJid
  if (message.key.fromMe || !jid || !/^[^@]+@(s\.whatsapp\.net|c\.us|lid|hosted|hosted\.lid)$/.test(jid)) return
  let content = message.message
  if (!content || content.protocolMessage != null || content.senderKeyDistributionMessage != null) return
  const ephemeral = content.ephemeralMessage
  if (isRecord(ephemeral)) {
    content = isRecord(ephemeral.message) ? ephemeral.message : null
  }
  if (!content || typeof content !== 'object' || content.protocolMessage != null || content.senderKeyDistributionMessage != null) return
  const extended = content.extendedTextMessage
  const text = content.conversation ?? (typeof extended === 'object' && extended !== null && 'text' in extended
    ? extended.text
    : undefined)
  if (typeof text !== 'string' || text.trim().toLowerCase() !== 'ping') return
  return 'pong'
}

export const handleMessages = async (
  socket: HostWASocket,
  event: HostBaileysEventMap['messages.upsert']
): Promise<void> => {
  console.log('messages.upsert', JSON.stringify({ type: event.type, count: event.messages.length }))
  if (event.type !== 'notify') return
  for (const message of event.messages) {
    const jid = message.key.remoteJid
    const text = replyText(message)
    console.log('message eligibility', JSON.stringify({ eligible: Boolean(jid && text) }))
    if (!jid || !text) continue
    console.log('reply attempt')
    try {
      await socket.sendMessage(jid, { text })
      console.log('reply outcome', JSON.stringify({ outcome: 'sent' }))
    } catch (error) {
      console.error('reply outcome', JSON.stringify({ outcome: 'failed', errorClass: error instanceof Error ? error.name : typeof error }))
      throw error
    }
  }
}
