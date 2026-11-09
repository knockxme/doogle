import { app } from './app.js'
import { env } from './config/env.js'
import { assertMasterKeyMatches } from './modules/crypto/file-keys.js'

async function main() {
  await assertMasterKeyMatches()
  app.listen(env.APP_PORT, () => {
    console.log(`Backend running on http://localhost:${env.APP_PORT}`)
  })
}

main().catch((error) => {
  console.error('Startup failed:', error instanceof Error ? error.message : 'unknown error')
  process.exit(1)
})
