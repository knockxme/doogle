import { app } from './app.js'
import { env } from './config/env.js'
import { resumeRepairOnBoot } from './modules/admin/repair.js'
import { assertMasterKeyMatches } from './modules/crypto/file-keys.js'

async function main() {
  await assertMasterKeyMatches()
  app.listen(env.APP_PORT, () => {
    console.log(`Backend running on http://localhost:${env.APP_PORT}`)
  })
  void resumeRepairOnBoot().catch((error) => console.error('Repair resume failed:', error instanceof Error ? error.name : 'unknown error'))
}

main().catch((error) => {
  console.error('Startup failed:', error instanceof Error ? error.message : 'unknown error')
  process.exit(1)
})
