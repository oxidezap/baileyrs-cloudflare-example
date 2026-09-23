import { copyFile } from 'node:fs/promises'

await copyFile(
  'node_modules/@oxidezap/whatsapp-rust-bridge/dist/whatsapp_rust_bridge_bg.wasm',
  'src/bridge.wasm'
)
