import type { HostBaileysEventMap, HostWASocket } from '@oxidezap/baileyrs/host'

export type BotStatus = {
  state: 'stopped' | 'connecting' | 'waiting_for_qr' | 'connected' | 'logged_out' | 'closed'
  qr?: string
  error?: string
}

export const replyText = (message: HostBaileysEventMap['messages.upsert']['messages'][number]): string | undefined => {
  const jid = message.key.remoteJid
  if (message.key.fromMe || !jid || !/^[^@]+@(s\.whatsapp\.net|c\.us|lid|hosted)$/.test(jid)) return
  const content = message.message
  if (!content || typeof content !== 'object' || 'protocolMessage' in content || 'senderKeyDistributionMessage' in content) return
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
  if (event.type !== 'notify') return
  for (const message of event.messages) {
    const jid = message.key.remoteJid
    const text = replyText(message)
    if (!jid || !text) continue
    await socket.sendMessage(jid, { text })
  }
}
