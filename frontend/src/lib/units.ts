const GB = 1024 ** 3

/** GB typed in the UI to a byte string for the API. Blank means null (no limit/cap). Returns undefined when the text is not a valid number. */
export function gbToBytesString(input: string): string | null | undefined {
  const text = input.trim()
  if (text === '') return null
  const value = Number(text)
  if (!Number.isFinite(value) || value < 0) return undefined
  return BigInt(Math.round(value * GB)).toString()
}

export function bytesToGbText(bytes: string | null | undefined) {
  if (bytes === null || bytes === undefined) return ''
  const gb = Number(bytes) / GB
  return Number.isFinite(gb) ? String(Math.round(gb * 100) / 100) : ''
}
