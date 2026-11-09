export type Candidate = {
  id: string
  provider: string
  createdAt: Date
  capBytes: bigint | null
  appStoredBytes: bigint
  providerFreeBytes: bigint | null
  reservedBytes: bigint
  pausedUntil: Date | null
}

export type RoutingPolicy = {
  mode: 'most_available' | 'round_robin' | 'priority'
  priorityAccountIds: string[]
  cursor: number
}

/** Bytes still usable on an account. null means unlimited. */
export function effectiveFree(c: Candidate): bigint | null {
  const capRoom = c.capBytes === null ? null : (c.capBytes > c.appStoredBytes ? c.capBytes - c.appStoredBytes : 0n)
  let room: bigint | null
  if (capRoom === null) room = c.providerFreeBytes
  else if (c.providerFreeBytes === null) room = capRoom
  else room = capRoom < c.providerFreeBytes ? capRoom : c.providerFreeBytes
  if (room === null) return null
  const left = room - c.reservedBytes
  return left > 0n ? left : 0n
}

function isPaused(c: Candidate, now: Date) {
  return c.pausedUntil !== null && c.pausedUntil.getTime() > now.getTime()
}

function byPriority(items: Candidate[], priorityAccountIds: string[]) {
  const order = new Map(priorityAccountIds.map((id, index) => [id, index]))
  return [...items].sort((a, b) => {
    const aOrder = order.get(a.id)
    const bOrder = order.get(b.id)
    if (aOrder !== undefined && bOrder !== undefined) return aOrder - bOrder
    if (aOrder !== undefined) return -1
    if (bOrder !== undefined) return 1
    return a.createdAt.getTime() - b.createdAt.getTime()
  })
}

// Unlimited S3 sorts first; unlimited non-S3 (unknown quota) sorts after every known amount.
function rank(c: Candidate): { tier: number; free: bigint } {
  const free = effectiveFree(c)
  if (free === null) return { tier: c.provider === 's3' ? 0 : 2, free: 0n }
  return { tier: 1, free }
}

export function pickPair(cs: Candidate[], needBytes: bigint, policy: RoutingPolicy, now: Date): [string, string] | null {
  const eligible = cs.filter((c) => {
    if (isPaused(c, now)) return false
    const free = effectiveFree(c)
    return free === null || free >= needBytes
  })
  if (eligible.length < 2) return null

  if (policy.mode === 'priority') {
    const ordered = byPriority(eligible, policy.priorityAccountIds)
    return [ordered[0].id, ordered[1].id]
  }
  if (policy.mode === 'round_robin') {
    const ordered = byPriority(eligible, policy.priorityAccountIds)
    const start = ((policy.cursor % ordered.length) + ordered.length) % ordered.length
    return [ordered[start].id, ordered[(start + 1) % ordered.length].id]
  }
  const ranked = eligible
    .map((c) => ({ c, ...rank(c) }))
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier
      if (a.free !== b.free) return a.free > b.free ? -1 : 1
      return a.c.createdAt.getTime() - b.c.createdAt.getTime()
    })
  return [ranked[0].c.id, ranked[1].c.id]
}

/** Room for new files: summed free space of unpaused accounts, halved because every file is stored twice. null when any is unlimited. */
export function usablePoolBytes(cs: Candidate[], now: Date): bigint | null {
  let total = 0n
  for (const c of cs) {
    if (isPaused(c, now)) continue
    const free = effectiveFree(c)
    if (free === null) return null
    total += free
  }
  return total / 2n
}
