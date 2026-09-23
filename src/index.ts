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

const RECONNECT_DELAY_MS = 30_000

export class Bot extends DurableObject<Env> {
  private socket?: HostWASocket
  private status: BotStatus = { state: 'stopped' }
  private starting?: Promise<void>
  private retryAt = 0
  private readonly initialization: Promise<void>

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.initialization = this.ctx.blockConcurrencyWhile(async () => {
      try {
        await this.start(false)
      } catch (error) {
        console.error('Could not restore WhatsApp connection', JSON.stringify({ errorClass: error instanceof Error ? error.name : typeof error }))
        this.status = { state: 'closed', error: 'Could not restore stored session' }
        this.retryAt = Date.now() + RECONNECT_DELAY_MS
      }
    })
  }

  async fetch(request: Request): Promise<Response> {
    await this.initialization
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/start') {
      await this.start(true)
      return Response.json(this.status)
    }
    if (request.method === 'GET' && url.pathname === '/status') {
      if (this.status.state === 'closed' && Date.now() >= this.retryAt) {
        try {
          await this.start(false)
        } catch (error) {
          console.error('Could not reconnect WhatsApp session', JSON.stringify({ errorClass: error instanceof Error ? error.name : typeof error }))
          this.status = { state: 'closed', error: 'Could not reconnect stored session' }
          this.retryAt = Date.now() + RECONNECT_DELAY_MS
        }
      }
      return Response.json(this.status)
    }
    return new Response('Not found', { status: 404 })
  }

  private start(allowPairing: boolean): Promise<void> {
    if (this.socket) return Promise.resolve()
    if (this.starting) return this.starting
    if (this.status.state === 'closed' && Date.now() < this.retryAt) return Promise.resolve()

    const starting = this.openSocket(allowPairing).catch(error => {
      this.status = { state: 'closed', error: 'Could not start WhatsApp connection' }
      this.retryAt = Date.now() + RECONNECT_DELAY_MS
      throw error
    })
    this.starting = starting
    return starting.finally(() => {
      if (this.starting === starting) this.starting = undefined
    })
  }

  private async openSocket(allowPairing: boolean): Promise<void> {
    initSync({ module: wasm })
    const store = createStore(this.ctx.storage)
    const auth = await createAuthenticationState(store)
    if (!allowPairing && !auth.creds.registered) {
      if (this.status.state === 'closed') this.status = { state: 'stopped' }
      return
    }

    // Retain the explicit protocol version used when WhatsApp rejected the former preview's default.
    const socket = makeWASocket({ auth, version: [2, 3000, 1043857760], logger: undefined })
    this.socket = socket
    socket.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
      console.log('connection state', connection ?? (qr ? 'qr' : 'updated'))
      if (qr) this.status = { state: 'waiting_for_qr', qr }
      else if (connection === 'open') {
        this.status = { state: 'connected' }
        this.retryAt = 0
      } else if (connection === 'connecting') this.status = { state: 'connecting' }
      else if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as (Error & { output?: { statusCode?: number } }) | undefined)?.output?.statusCode
        this.socket = undefined
        if (statusCode === 401) {
          this.status = { state: 'logged_out' }
          try {
            await this.ctx.storage.deleteAll()
          } catch (error) {
            console.error('Could not clear logged-out credentials', JSON.stringify({ errorClass: error instanceof Error ? error.name : typeof error }))
            this.status = { state: 'closed', error: 'Could not clear logged-out credentials' }
            this.retryAt = Date.now() + RECONNECT_DELAY_MS
          }
        } else {
          this.status = { state: 'closed', error: lastDisconnect?.error?.message }
          this.retryAt = Date.now() + RECONNECT_DELAY_MS
        }
      }
    })
    socket.ev.on('messages.upsert', event => {
      void handleMessages(socket, event).catch(error => console.error('Message handler failed', JSON.stringify({ errorClass: error instanceof Error ? error.name : typeof error })))
    })
    this.status = { state: 'connecting' }
    this.retryAt = 0
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
