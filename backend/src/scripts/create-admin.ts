import readline from 'node:readline'
import { parseArgs } from 'node:util'
import { prisma } from '../config/prisma.js'
import { hashPassword } from '../utils/password.js'

// Reads a line from the terminal without echoing it. The password never goes through argv.
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    const out = rl as unknown as { _writeToOutput: (text: string) => void }
    let muted = false
    const original = out._writeToOutput.bind(rl)
    out._writeToOutput = (text) => {
      if (!muted) original(text)
    }
    rl.question(question, (answer) => {
      rl.close()
      process.stdout.write('\n')
      resolve(answer)
    })
    muted = true
  })
}

async function main() {
  const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' } } })
  if (!values.email || !values.name) throw new Error('Usage: npm run admin:create -- --email <email> --name <name>')
  const password = await promptHidden('Password (min 8 chars): ')
  if (password.length < 8) throw new Error('Password must be at least 8 characters.')
  const passwordHash = await hashPassword(password)
  const user = await prisma.user.upsert({
    where: { email: values.email },
    create: { email: values.email, name: values.name, passwordHash, role: 'admin', mustChangePassword: false },
    update: { name: values.name, passwordHash, role: 'admin', status: 'active', mustChangePassword: false },
  })
  console.log(`Admin ready: ${user.email}`)
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
