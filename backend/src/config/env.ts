import dotenv from 'dotenv'
import { z } from 'zod'
import { parseMasterKey } from '../modules/crypto/keys.js'

dotenv.config()

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_PORT: z.coerce.number().default(4000),
  FRONTEND_URL: z.string().url(),
  JWT_ACCESS_SECRET: z.string().min(32),
  TOKEN_ENCRYPTION_KEY: z.string().min(32),
  FILE_MASTER_KEY: z.string().refine((v) => {
    try {
      parseMasterKey(v)
      return true
    } catch {
      return false
    }
  }, 'FILE_MASTER_KEY must be 32 bytes, base64-encoded'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),
  MAX_UPLOAD_BYTES: z.coerce.number().default(5 * 1024 * 1024 * 1024),
})

export const env = envSchema.parse(process.env)
