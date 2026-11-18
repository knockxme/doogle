import cors from 'cors'
import express, { type Request } from 'express'
import { env } from './config/env.js'
import { errorMiddleware } from './middleware/error.middleware.js'
import { authRouter } from './modules/auth/auth.routes.js'
import { providerConfigRouter } from './modules/provider-configs/provider-config.routes.js'
import { connectedAccountRouter } from './modules/connected-accounts/connected-account.routes.js'
import { storageRouter } from './modules/storage/storage.routes.js'
import { uploadRouter } from './modules/uploads/upload.routes.js'
import { fileRouter } from './modules/files/file.routes.js'
import { folderRouter } from './modules/folders/folder.routes.js'
import { publicRouter } from './modules/public/public.routes.js'
import { inviteRouter } from './modules/invites/invite.routes.js'
import { apiKeyRouter } from './modules/api-keys/api-key.routes.js'
import { publicApiRouter } from './modules/public-api/public-api.routes.js'
import { auditLogRouter } from './modules/audit-logs/audit-log.routes.js'
import { adminUsersRouter } from './modules/admin/admin-users.routes.js'
import { adminStorageRouter } from './modules/admin/admin-storage.routes.js'
import { systemRouter } from './modules/system/system.routes.js'
import { createDavHandler } from './modules/webdav/index.js'
import { familyPorts } from './modules/webdav/family-ports.js'

export const app = express()
app.set('trust proxy', env.TRUST_PROXY_HOPS)

// WebDAV for rclone. Mounted before cors() (which would answer OPTIONS itself) and before the JSON parser
// (which would swallow a PUT of a .json file). It has its own Basic auth and its own failed sign-in limit.
if (env.DAV_ENABLED) {
  const dav = createDavHandler(familyPorts, {
    publicPrefix: '/api/dav',
    stripPrefix: '',
    maxFileBytes: env.MAX_UPLOAD_BYTES,
    cacheBytes: env.DAV_CACHE_MB * 1024 * 1024,
    readAheadPieces: env.DAV_READ_AHEAD,
    // req.ip follows `trust proxy`, so a client cannot pick its own address with X-Forwarded-For.
    clientIp: (req) => (req as Request).ip ?? req.socket.remoteAddress ?? 'unknown',
  })
  app.use('/api/dav', (req, res) => void dav(req, res))
}

app.use(cors({ origin: env.FRONTEND_URL }))
app.use(express.json({ limit: '1mb' }))

app.get('/health', (_req, res) => res.json({ status: 'ok' }))
app.use('/api', publicApiRouter)
app.use('/public', publicRouter)
app.use('/auth', authRouter)
app.use('/api-keys', apiKeyRouter)
app.use('/provider-configs', providerConfigRouter)
app.use('/connected-accounts', connectedAccountRouter)
app.use('/storage', storageRouter)
app.use('/uploads', uploadRouter)
app.use('/files', fileRouter)
app.use('/folders', folderRouter)
app.use('/invites', inviteRouter)
app.use('/audit-logs', auditLogRouter)
app.use('/system', systemRouter)
app.use('/admin/users', adminUsersRouter)
app.use('/admin/storage', adminStorageRouter)
app.use(errorMiddleware)
