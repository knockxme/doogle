const forgetters = new Set<() => void>()

/** Registers a cache to clear when access changes. Returns the unregister function. */
export function onForgetDavLogins(forget: () => void): () => void {
  forgetters.add(forget)
  return () => forgetters.delete(forget)
}

/** Call when an API key is revoked, a user is disabled or deleted, or WebDAV access is turned off. */
export function forgetDavLogins(): void {
  for (const forget of forgetters) forget()
}
