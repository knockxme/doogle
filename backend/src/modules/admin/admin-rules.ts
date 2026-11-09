export class LastAdminError extends Error {
  code = 'LAST_ADMIN' as const
  constructor() {
    super('At least one active admin must remain.')
  }
}

/** Throws LAST_ADMIN when the target is the only active admin left. */
export function assertNotLastAdmin(activeAdminCount: number, target: { role: string; status: string }): void {
  if (target.role === 'admin' && target.status === 'active' && activeAdminCount <= 1) throw new LastAdminError()
}
