/** In-memory DavPorts for testing the WebDAV layer without MySQL or providers. */
import { randomUUID } from 'node:crypto'
import { DavError, type DavNode, type DavPorts, type DavUser } from '../src/modules/webdav/ports.js'

interface MemNode extends DavNode {
  pieces: Buffer[]
  ownerId: string
  committed: boolean
}

export function createMemoryPorts(opts: { email: string; apiKey: string; pieceSize?: number }) {
  const pieceSize = opts.pieceSize ?? 1024 * 1024
  const user: DavUser = { id: 'u1', email: opts.email }
  const now = () => new Date()
  const nodes = new Map<string, MemNode>()
  const root: MemNode = { id: 'root', type: 'folder', name: '', parentId: null, size: 0, mimeType: 'httpd/unix-directory', createdAt: now(), modifiedAt: now(), pieces: [], ownerId: user.id, committed: true }
  nodes.set(root.id, root)
  const hooks = { failReplace: false }

  const visible = (n: MemNode | undefined, u: DavUser) => n && n.committed && n.ownerId === u.id
  const strip = ({ pieces: _p, ownerId: _o, committed: _c, ...n }: MemNode): DavNode => ({ ...n })
  const removeTree = (id: string) => {
    for (const c of [...nodes.values()]) if (c.parentId === id) removeTree(c.id)
    nodes.delete(id)
  }

  const ports: DavPorts = {
    pieceSize,
    async authenticate(email, key) {
      return email === opts.email && key === opts.apiKey ? user : null
    },
    async rootFolder() {
      return strip(root)
    },
    async child(u, parentId, name) {
      const n = [...nodes.values()].find((x) => x.parentId === parentId && x.name === name && visible(x, u))
      return n ? strip(n) : null
    },
    async children(u, folderId) {
      return [...nodes.values()].filter((x) => x.parentId === folderId && visible(x, u)).map(strip)
    },
    async createFolder(u, parentId, name) {
      const f: MemNode = { id: randomUUID(), type: 'folder', name, parentId, size: 0, mimeType: 'httpd/unix-directory', createdAt: now(), modifiedAt: now(), pieces: [], ownerId: u.id, committed: true }
      nodes.set(f.id, f)
      return strip(f)
    },
    async beginUpload(u, a) {
      const f: MemNode = { id: randomUUID(), type: 'file', name: a.name, parentId: a.parentId, size: a.size, mimeType: a.mimeType, createdAt: now(), modifiedAt: a.modifiedAt ?? now(), pieces: [], ownerId: u.id, committed: false }
      nodes.set(f.id, f)
      return {
        async writePiece(i, data) {
          if (i !== f.pieces.length) throw new Error(`piece ${i} out of order`)
          f.pieces.push(Buffer.from(data))
        },
        async commit() {
          f.committed = true
          return strip(f)
        },
        async abort() {
          nodes.delete(f.id)
        },
      }
    },
    async readPiece(u, fileId, index) {
      const f = nodes.get(fileId)
      if (!f || f.ownerId !== u.id) throw new DavError(404, 'Not found')
      const p = f.pieces[index]
      if (!p) throw new Error(`missing piece ${index}`)
      return p
    },
    async remove(_u, id) {
      removeTree(id)
    },
    async move(_u, id, parentId, name) {
      const n = nodes.get(id)!
      n.parentId = parentId
      n.name = name
      return strip(n)
    },
    async replace(_u, id, existingId, parentId, name) {
      if (hooks.failReplace) throw new Error('replace failed')
      if (existingId) removeTree(existingId)
      const n = nodes.get(id)!
      n.parentId = parentId
      n.name = name
      return strip(n)
    },
    async quota() {
      const used = [...nodes.values()].filter((n) => n.type === 'file').reduce((s, n) => s + n.size, 0)
      return { usedBytes: used, availableBytes: 10 ** 12 - used }
    },
  }
  return { ports, nodes, hooks }
}
