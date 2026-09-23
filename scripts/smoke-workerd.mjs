import { spawn } from 'node:child_process'
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const scratch = await mkdtemp(resolve(root, '.wrangler/workerd-smoke-'))
const config = resolve(scratch, 'wrangler.jsonc')
const token = 'workerd-smoke-token'
const state = resolve(scratch, 'state')
const configData = {
  name: 'baileyrs-workerd-smoke',
  main: '../../src/index.ts',
  compatibility_date: '2026-09-23',
  define: { 'globalThis.process.getBuiltinModule': 'undefined' },
  rules: [{ type: 'CompiledWasm', globs: ['**/*.wasm'], fallthrough: false }],
  durable_objects: { bindings: [{ name: 'BOT', class_name: 'Bot' }] },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['Bot'] }]
}

const getPort = () => new Promise((resolvePort, reject) => {
  const server = net.createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    server.close(error => error ? reject(error) : resolvePort(port))
  })
})

let worker
try {
  await writeFile(config, JSON.stringify(configData, null, 2))
  await copyFile(
    resolve(root, 'node_modules/@oxidezap/whatsapp-rust-bridge/dist/whatsapp_rust_bridge_bg.wasm'),
    resolve(root, 'src/bridge.wasm')
  )

  const port = await getPort()
  const origin = `http://127.0.0.1:${port}`
  worker = spawn(process.execPath, [
    resolve(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--config', config,
    '--ip', '127.0.0.1', '--port', String(port),
    '--persist-to', state, '--var', `ADMIN_TOKEN:${token}`, '--log-level', 'error'
  ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })

  let output = ''
  worker.stdout.on('data', chunk => { output += chunk })
  worker.stderr.on('data', chunk => { output += chunk })
  const getStatus = async headers => {
    const response = await fetch(`${origin}/status`, { headers })
    return { response, body: await response.text() }
  }

  let ready = false
  for (let attempt = 0; attempt < 60; attempt++) {
    if (worker.exitCode !== null) throw new Error(`Wrangler exited early:\n${output}`)
    try {
      const { response, body } = await getStatus()
      if (response.status === 401 && body === 'Unauthorized') ready = true
    } catch {}
    if (ready) break
    await new Promise(resolveDelay => setTimeout(resolveDelay, 500))
  }
  if (!ready) throw new Error(`Wrangler did not become ready:\n${output}`)

  const unauthorized = await getStatus()
  if (unauthorized.response.status !== 401) throw new Error('Unauthenticated /status did not return 401')
  const authorized = await getStatus({ authorization: `Bearer ${token}` })
  if (authorized.response.status !== 200 || authorized.body !== '{"state":"stopped"}') {
    throw new Error(`Authorized Durable Object status was unexpected: ${authorized.response.status} ${authorized.body}`)
  }
  console.log('Packaged /host Worker bundle ran in workerd without nodejs_compat; auth and Durable Object status checks passed.')
} finally {
  if (worker && worker.exitCode === null) {
    worker.kill('SIGTERM')
    await Promise.race([
      new Promise(resolveExit => worker.once('exit', resolveExit)),
      new Promise(resolveDelay => setTimeout(resolveDelay, 5000))
    ])
    if (worker.exitCode === null) worker.kill('SIGKILL')
  }
  await rm(scratch, { recursive: true, force: true })
}
