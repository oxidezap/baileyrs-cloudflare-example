import makeWASocket, { createAuthenticationState } from '@oxidezap/baileyrs/host'
import type { HostWASocket } from '@oxidezap/baileyrs/host'
import wasm from './bridge.wasm'
import { initSync } from '@oxidezap/whatsapp-rust-bridge/host'
import { DurableObject } from 'cloudflare:workers'
import { handleMessages, type BotStatus } from './bot.ts'
import { createStore } from './persistence.ts'

interface Env {
  BOT: DurableObjectNamespace<Bot>
  ADMIN_TOKEN: string
}

export class Bot extends DurableObject<Env> {
  private socket?: HostWASocket
  private status: BotStatus = { state: 'stopped' }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/start') {
      await this.start()
      return Response.json(this.status)
    }
    if (request.method === 'GET' && url.pathname === '/status') return Response.json(this.status)
    return new Response('Not found', { status: 404 })
  }

  private async start(): Promise<void> {
    if (this.socket) return
    initSync({ module: wasm })
    const store = createStore(this.ctx.storage)
    const auth = await createAuthenticationState(store)
    // Retain the explicit protocol version used when WhatsApp rejected the former preview's default.
    const socket = makeWASocket({ auth, version: [2, 3000, 1043857760], logger: undefined })
    this.socket = socket
    socket.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
      if (qr) this.status = { state: 'waiting_for_qr', qr }
      else if (connection === 'open') this.status = { state: 'connected' }
      else if (connection === 'connecting') this.status = { state: 'connecting' }
      else if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as (Error & { output?: { statusCode?: number } }) | undefined)?.output?.statusCode
        if (statusCode === 401) {
          this.status = { state: 'closed' }
          try {
            await this.ctx.storage.deleteAll()
            this.status = { state: 'logged_out' }
          } catch (error) {
            console.error('Could not clear logged-out credentials', error)
            this.status = { state: 'closed', error: 'Could not clear logged-out credentials' }
          }
        } else {
          this.status = { state: 'closed', error: lastDisconnect?.error?.message }
        }
        this.socket = undefined
      }
    })
    socket.ev.on('messages.upsert', event => {
      void handleMessages(socket, event).catch(error => console.error('Message reply failed', error))
    })
    this.status = { state: 'connecting' }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== '/start' && url.pathname !== '/status') return new Response('Not found', { status: 404 })
    if (!env.ADMIN_TOKEN) return new Response('Admin token is not configured', { status: 503 })
    if (request.headers.get('authorization') !== `Bearer ${env.ADMIN_TOKEN}`) {
      return new Response('Unauthorized', { status: 401 })
    }
    const id = env.BOT.idFromName('whatsapp-bot')
    return env.BOT.get(id).fetch(`https://bot${url.pathname}`, { method: request.method })
  }
} satisfies ExportedHandler<Env>
