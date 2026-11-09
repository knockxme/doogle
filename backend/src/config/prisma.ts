import { PrismaClient } from '@prisma/client'

// Wrapped keys and the BigInt encrypted size stay out of every row by default, so routes that
// spread a row into JSON cannot leak them. Internal code opts in with `omit: { wrappedFileKey: false }`.
export const prisma = new PrismaClient({
  omit: {
    file: { wrappedFileKey: true, encryptedSizeBytes: true },
    uploadSession: { wrappedFileKey: true },
  },
})
