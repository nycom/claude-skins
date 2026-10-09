// Plain string helpers behind the row builders.

export const oneLine = (text: string): string =>
  (text.split('\n', 1)[0] ?? '').replace(/\s+/g, ' ').trim()

const slashed = (path: string): string => path.replace(/\\/g, '/')

// A path under the session's directory shows relative to it; any other stays as given.
export function shortenPath(path: string, cwd: string): string {
  const full = slashed(path)
  const root = slashed(cwd).replace(/\/+$/, '')

  if (root === '' || !full.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    return path
  }

  return full.slice(root.length + 1)
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)

  if (seconds < 1) {
    return '<1s'
  }

  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

// A tool call's own time: `340ms`, `2.1s`, `1m 4s`.
export function formatMs(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`
  }

  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : formatDuration(ms)
}

// Lines added and removed, read from an Edit or Write record's patch.
export function diffstat(output: unknown): { added: number; removed: number } | null {
  const patch = (output as { structuredPatch?: unknown } | null)?.structuredPatch

  if (!Array.isArray(patch)) {
    return null
  }

  const lines = patch.flatMap(hunk => {
    const hunkLines = (hunk as { lines?: unknown } | null)?.lines

    return Array.isArray(hunkLines) ? hunkLines.filter(line => typeof line === 'string') : []
  }) as string[]

  return {
    added: lines.filter(line => line.startsWith('+')).length,
    removed: lines.filter(line => line.startsWith('-')).length,
  }
}

// The same seed always picks the same item, so a row keeps its word when it redraws.
export function pick<T>(items: readonly T[], seed: string): T | undefined {
  let hash = 5381

  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 33 + seed.charCodeAt(i)) >>> 0
  }

  return items[hash % items.length]
}

// Keeps the first `head` and last `tail` lines of a long text and names how many it hid.
export function clipLines(text: string, head: number, tail: number): string {
  const lines = text.split('\n')
  const hidden = lines.length - head - tail

  if (hidden <= 1) {
    return text
  }

  return [
    ...lines.slice(0, head),
    `… ${hidden} lines hidden`,
    ...lines.slice(lines.length - tail),
  ].join('\n')
}

// A token count at a glance: `950`, `1.5k`, `96k`, `1.2M`.
export function compactCount(count: number): string {
  const thousands = count / 1000

  if (count < 1000) {
    return String(count)
  }

  if (Math.round(thousands) < 1000) {
    return `${Number(thousands.toFixed(thousands < 10 ? 1 : 0))}k`
  }

  return `${Number((count / 1_000_000).toFixed(1))}M`
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// When a plan limit resets, by local calendar day: the clock time today (`2:40pm`), then
// `tmrw 9:00am`, then the weekday (`Sat 9:00am`), and from a week off, when the weekday is
// today's or past it, `next Fri 9:00am`; so no reset reads as one already gone. From two weeks
// off a weekday would name the wrong week, so the date (`Oct 23 9:00am`). Nothing for a
// missing or unreadable timestamp, or one already past, as the window has since reset.
export function resetLabel(at: string | undefined, now: number): string | undefined {
  const date = new Date(at ?? Number.NaN)

  if (Number.isNaN(date.getTime()) || date.getTime() <= now) {
    return undefined
  }

  const hours = date.getHours()
  const time = `${hours % 12 || 12}:${String(date.getMinutes()).padStart(2, '0')}${hours < 12 ? 'am' : 'pm'}`
  const today = new Date(now)
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)
  const weekOn = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7)
  const twoWeeksOn = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 14)

  if (date.toDateString() === today.toDateString()) {
    return time
  }

  if (date.toDateString() === tomorrow.toDateString()) {
    return `tmrw ${time}`
  }

  if (date >= twoWeeksOn) {
    return `${date.toDateString().slice(4, 7)} ${date.getDate()} ${time}`
  }

  return `${date >= weekOn ? 'next ' : ''}${WEEKDAYS[date.getDay()]} ${time}`
}
