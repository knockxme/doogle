export function createLoginLimiter(max: number, windowMs: number) {
  const entries = new Map<string, { count: number; windowStart: number }>()
  return {
    /** Records an attempt for the key and returns false once it exceeds the limit within the window. */
    check(key: string, now: number): boolean {
      const entry = entries.get(key)
      if (!entry || now - entry.windowStart >= windowMs) {
        entries.set(key, { count: 1, windowStart: now })
        return true
      }
      entry.count += 1
      return entry.count <= max
    },
    reset(key: string): void {
      entries.delete(key)
    },
  }
}
