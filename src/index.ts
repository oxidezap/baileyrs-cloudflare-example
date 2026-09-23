import makeWASocket, { createAuthenticationState } from '@oxidezap/baileyrs/host'
import type { HostWASocket } from '@oxidezap/baileyrs/host'
import wasm from './bridge.wasm'
import { initSync } from '@oxidezap/whatsapp-rust-bridge/host'
import { DurableObject } from 'cloudflare:workers'
import { handleMessages, type BotStatus } from './bot.ts'
import { createStore, deserialize, serialize } from './persistence.ts'

interface Env {
  BOT: DurableObjectNamespace<Bot>
  ADMIN_TOKEN: string
}

export class Bot extends DurableObject<Env> {
  private socket?: HostWASocket

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/start') {
      await this.start()
      return Response.json(await this.status())
    }
    if (request.method === 'GET' && url.pathname === '/status') return Response.json(await this.status())
    return new Response('Not found', { status: 404 })
  }

  private async status(): Promise<BotStatus> {
    return (await this.ctx.storage.get<BotStatus>('status')) ?? { state: 'stopped' }
  }

  private async updateStatus(status: BotStatus): Promise<void> {
    await this.ctx.storage.put('status', status)
  }

  private async start(): Promise<void> {
    if (this.socket) return
    initSync({ module: wasm })
    const store = createStore(this.ctx.storage)
    const auth = await createAuthenticationState(store)
    const creds = await this.ctx.storage.get<string>('creds')
    if (creds) Object.assign(auth.creds, deserialize<Record<string, unknown>>(creds))
    const socket = makeWASocket({ auth, logger: undefined })
    this.socket = socket
    socket.ev.on('creds.update', async update => {
      Object.assign(auth.creds, update)
      await this.ctx.storage.put('creds', serialize(auth.creds))
    })
    socket.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
      if (qr) await this.updateStatus({ state: 'waiting_for_qr', qr })
      else if (connection === 'open') await this.updateStatus({ state: 'connected' })
      else if (connection === 'connecting') await this.updateStatus({ state: 'connecting' })
      else if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as (Error & { output?: { statusCode?: number } }) | undefined)?.output?.statusCode
        const loggedOut = statusCode === 401
        await this.updateStatus({
          state: loggedOut ? 'logged_out' : 'closed',
          error: lastDisconnect?.error?.message
        })
        this.socket = undefined
      }
    })
    socket.ev.on('messages.upsert', event => {
      void handleMessages(socket, event).catch(error => console.error('Message reply failed', error))
    })
    await this.updateStatus({ state: 'connecting' })
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


