import { app } from './app.js'
import { env } from './config/env.js'
import { resumeRepairOnBoot } from './modules/admin/repair.js'
import { assertMasterKeyMatches } from './modules/crypto/file-keys.js'

function warnAboutExampleSecrets() {
  if (env.JWT_ACCESS_SECRET.startsWith('change-this')) {
    console.warn('WARNING: JWT_ACCESS_SECRET is still the example value. Set a long random value; changing it only signs everyone out.')
  }
  if (env.TOKEN_ENCRYPTION_KEY.startsWith('change-this')) {
    console.warn('WARNING: TOKEN_ENCRYPTION_KEY is still the example value. Set a long random value before connecting storage; changing it later means reconnecting every storage account.')
  }
}

async function main() {
  warnAboutExampleSecrets()
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
