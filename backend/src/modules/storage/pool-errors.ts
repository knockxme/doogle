export class PoolError extends Error {
  constructor(public readonly code: 'NO_ACCOUNT_WITH_ENOUGH_SPACE' | 'USER_STORAGE_LIMIT_REACHED', message: string, public readonly status: number) {
    super(message)
  }
}
