/**
 * The contract between the WebDAV layer and Family Drive. The WebDAV code never touches MySQL,
 * providers or encryption directly; family-ports.ts implements these with the existing services.
 */

/** Throw this from any port to send a specific HTTP status to the client. */
export class DavError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
  }
}

export type DavNodeType = 'file' | 'folder'

export interface DavNode {
  id: string
  type: DavNodeType
  name: string
  parentId: string | null
  /** Real (decrypted) size in bytes. 0 for folders. */
  size: number
  mimeType: string
  createdAt: Date
  /** Last content change. Never changes on move or rename: rclone compares it to its cache. */
  modifiedAt: Date
}

export interface DavUser {
  id: string
  email: string
}

export interface UploadSession {
  /** Called in order (0, 1, 2 ...). Every piece is exactly `pieceSize` bytes except the last. */
  writePiece(index: number, data: Buffer): Promise<void>
  /** All pieces written and both copies complete: return the stored file. */
  commit(): Promise<DavNode>
  /** Upload failed: free the reservation and delete partial blobs now. */
  abort(reason: string): Promise<void>
}

export interface DavPorts {
  /** Plain-text size of one encrypted upload chunk. */
  pieceSize: number
  /** Email + API key with WebDAV access. null when wrong, disabled, revoked or not allowed. */
  authenticate(email: string, apiKey: string): Promise<DavUser | null>
  rootFolder(user: DavUser): Promise<DavNode>
  /** Child of `parentId` named exactly `name`, or null. A folder wins over a file; the newest file wins. */
  child(user: DavUser, parentId: string, name: string): Promise<DavNode | null>
  /** All children of a folder, one per exact name (same rule as `child`). */
  children(user: DavUser, folderId: string): Promise<DavNode[]>
  createFolder(user: DavUser, parentId: string, name: string): Promise<DavNode>
  /** Start an upload of known size. Throws DavError(507) when the pool or the user's limit is full. */
  beginUpload(user: DavUser, args: { parentId: string; name: string; size: number; mimeType: string; modifiedAt?: Date }): Promise<UploadSession>
  /** Piece `index` of a file, decrypted, with copy failover. */
  readPiece(user: DavUser, fileId: string, index: number): Promise<Buffer>
  /** Delete a file, or a folder with everything in it, for good. Frees the user's space at once. */
  remove(user: DavUser, nodeId: string): Promise<void>
  /** Move and/or rename. Keeps `modifiedAt`. */
  move(user: DavUser, nodeId: string, newParentId: string, newName: string): Promise<DavNode>
  /** In one transaction: delete `existingId` (if any) and move `nodeId` into its place. */
  replace(user: DavUser, nodeId: string, existingId: string | null, parentId: string, name: string): Promise<DavNode>
  quota(user: DavUser): Promise<{ usedBytes: number; availableBytes: number | null }>
}
