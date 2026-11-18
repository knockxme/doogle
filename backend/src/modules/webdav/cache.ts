/**
 * Small LRU cache of decrypted pieces.
 *
 * Why: Jellyfin/ffprobe and rclone read the same areas of a file many times
 * (start of the file, the index at the end, then sequential playback). Without
 * a cache every small read would fetch and decrypt a full 8 MB piece from Google.
 * Concurrent requests for the same piece share one fetch.
 */
export class PieceCache {
  private map = new Map<string, Buffer>()
  private bytes = 0
  private inflight = new Map<string, Promise<Buffer>>()

  constructor(private readonly maxBytes: number) {}

  async get(key: string, load: () => Promise<Buffer>): Promise<Buffer> {
    const hit = this.map.get(key)
    if (hit) {
      this.map.delete(key)
      this.map.set(key, hit) // mark as recently used
      return hit
    }
    const pending = this.inflight.get(key)
    if (pending) return pending
    const p = load()
      .then((buf) => {
        this.put(key, buf)
        return buf
      })
      .finally(() => this.inflight.delete(key))
    this.inflight.set(key, p)
    return p
  }

  /** Start loading a piece in the background if it is not cached or loading. */
  prefetch(key: string, load: () => Promise<Buffer>): void {
    if (this.maxBytes <= 0 || this.map.has(key) || this.inflight.has(key)) return
    this.get(key, load).catch(() => undefined)
  }

  invalidateFile(fileId: string): void {
    const prefix = `${fileId}:`
    for (const [k, v] of this.map) {
      if (k.startsWith(prefix)) {
        this.map.delete(k)
        this.bytes -= v.length
      }
    }
  }

  private put(key: string, buf: Buffer): void {
    if (buf.length > this.maxBytes) return
    const old = this.map.get(key)
    if (old) this.bytes -= old.length
    this.map.set(key, buf)
    this.bytes += buf.length
    while (this.bytes > this.maxBytes) {
      const first = this.map.entries().next().value as [string, Buffer] | undefined
      if (!first) break
      this.map.delete(first[0])
      this.bytes -= first[1].length
    }
  }
}
