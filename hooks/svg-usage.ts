import type { UsageSnap } from '../types'
import { compactCount, resetLabel } from './format'
import type { Palette, Slot } from './skin'
import { escape, FONT, loopDelay, measure, still } from './svg-kit'

// The band above the prompt: how full the context window is and how much of each plan
// limit is spent, as rings that fill in when they draw, and what fills the context, as a bar.

const RING_R = 8

// The band sits in the desktop's rounded row above the prompt, which adds about 2pt of padding.
// 23 + 2 matches the PR status rows and the input box beside it (25pt each).
export const BAND_H = 23
const CY = BAND_H / 2
// Room after a ring's text, before the next ring.
const ITEM_GAP = 20
const BAR_W = 64
const BAR_H = 4

// `note` follows the reading: the context's tokens, or when a plan limit resets.
export type Meter = { label: string; percent: number; note?: string }

// One part of what fills the context, as its share of it in percent.
export type Part = { label: string; share: number; slot: Slot }

// The breakdown bar, and whether its largest parts are named after it.
export type Breakdown = { parts: readonly Part[]; isLabelled: boolean }

// How long after a new reading the rings grow; past it they are drawn settled.
export const SETTLE_MS = 1200

// A ring grows from the reading it last showed, not from empty. The band is one image, so a
// new reading on any ring redraws them all: the rings that moved grow from where they were,
// the rest are drawn already full. A redraw at the same readings keeps the same starts, so it
// draws the same image and nothing replays, until SETTLE_MS have passed: from then on the
// rings are drawn settled, so an image the surface builds again has no growth left to play.
// `since` is when the readings changed: a band still growing is drawn as of then, so its
// moving parts keep the same delays and its redraws stay the same image.
export function rampFrom(): (meters: readonly Meter[], now: number) => { starts: readonly number[]; since: number } {
  const shown = new Map<string, number>()
  let key = ''
  let changedAt = 0
  let starts: readonly number[] = []

  return (meters, now) => {
    const next = meters.map(meter => `${meter.label}:${meter.percent}`).join(',')

    if (next !== key) {
      starts = meters.map(meter => shown.get(meter.label) ?? 0)
      meters.forEach(meter => shown.set(meter.label, meter.percent))
      key = next
      changedAt = now
    } else if (now - changedAt >= SETTLE_MS) {
      starts = meters.map(meter => meter.percent)
    }

    return { starts, since: changedAt }
  }
}

// `five_hour` reads as `5h`, `seven_day` as `7d`; any other kind as its own name.
export function limitLabel(kind: string): string {
  const name = kind.toLowerCase()

  if (name.includes('five') || name.includes('5h') || name.includes('5_h')) {
    return '5h'
  }

  if (name.includes('seven') || name.includes('7d') || name.includes('week')) {
    return '7d'
  }

  return name.replace(/_/g, ' ')
}

// `now` places each reset as a time today or a weekday further off.
export function metersOf(usage: UsageSnap, now: number): Meter[] {
  const tokens = usage.tokens === undefined || usage.window === undefined ? undefined : `${compactCount(usage.tokens)}/${compactCount(usage.window)}`

  return [
    ...(usage.context === null ? [] : [{ label: 'context', percent: usage.context, note: tokens }]),
    ...usage.limits.map(limit => ({ label: limit.label, percent: limit.percent, note: resetLabel(limit.resetsAt, now) })),
  ].map(({ note, ...meter }) => ({
    ...meter,
    percent: Math.max(0, Math.min(100, Math.round(meter.percent))),
    ...(note === undefined ? {} : { note }),
  }))
}

// The parts /context names, in a word each and a skin colour each; any other is `other`.
// Cosmetic only: `kind` decides used or free, and a name not listed falls back to `other`.
const PARTS: Readonly<Record<string, { label: string; slot: Slot }>> = {
  Messages: { label: 'msgs', slot: 'user' },
  'System tools': { label: 'tools', slot: 'run' },
  'System prompt': { label: 'sys', slot: 'read' },
  'Memory files': { label: 'memory', slot: 'write' },
  'MCP tools': { label: 'mcp', slot: 'mcp' },
  Skills: { label: 'skills', slot: 'search' },
  'Custom agents': { label: 'agents', slot: 'web' },
}

export const PART_SLOTS: readonly Slot[] = [...Object.values(PARTS).map(part => part.slot), 'other']

// The parts that hold tokens, largest first, each as its share of them all.
export function partsOf(parts: readonly { name: string; tokens: number }[]): Part[] {
  const total = parts.reduce((sum, part) => sum + Math.max(0, part.tokens), 0)

  return parts
    .filter(part => part.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .map(part => ({
      label: PARTS[part.name]?.label ?? part.name.toLowerCase(),
      share: Math.round((part.tokens / total) * 100),
      slot: PARTS[part.name]?.slot ?? 'other',
    }))
}

// The largest parts, named: `msgs 61%`.
export const NAMED_PARTS = 3
export const partNames = (parts: readonly Part[]): string[] => parts.slice(0, NAMED_PARTS).map(part => `${part.label} ${part.share}%`)

// Where each part starts and ends along a bar `width` long.
function partSpans(parts: readonly Part[], width: number): { part: Part; from: number; to: number }[] {
  const total = parts.reduce((sum, part) => sum + part.share, 0)
  let done = 0

  return parts.map(part => {
    const from = Math.round((width * done) / total)
    done += part.share
    return { part, from, to: Math.round((width * done) / total) }
  })
}

// Accent while there is room; the warning colour from 80 %, the error colour from 95 %.
export const meterColor = (percent: number, palette: Palette): string =>
  percent >= 95 ? palette.err : percent >= 80 ? palette.warn : palette.user

// The track is a faint guide; the fill carries the reading, at 3:1 against the track and
// the page alike in every skin.
export const TRACK_OPACITY = 0.2

// From this full, the band offers Compact; below it the button stays hidden.
export const COMPACT_SHOW = 50

// From this full, the band suggests compacting and makes it the main action.
export const COMPACT_NUDGE = 70

// The context ring is a CDJ's jog ring: twelve segments, and the unlit ones up to 12 o'clock
// light one after another, like a deck's track-end warning, faster and brighter as the context
// fills. From 90% only the last is left, blinking; from 97% the arc dims on the same beat.
const SEGMENTS = 12
type JogTier = { from: number; slot: 'user' | 'warn' | 'err'; seconds: number; peak: number }
const JOG_TIERS: readonly JogTier[] = [
  { from: 90, slot: 'err', seconds: 1.2, peak: 0.75 },
  { from: COMPACT_NUDGE, slot: 'warn', seconds: 2.4, peak: 0.75 },
  { from: COMPACT_SHOW, slot: 'user', seconds: 3, peak: 0.5 },
  { from: 0, slot: 'user', seconds: 4, peak: 0.35 },
]
const JOG_DIM = 97

// The plan limits share the segments but hold still until near the limit: a slow chase in the
// warning colour from 80%, and from 95% the last segment blinking in the error colour, where
// meterColor turns too.
const PLAN_TIERS: readonly JogTier[] = [
  { from: 95, slot: 'err', seconds: 1.2, peak: 0.75 },
  { from: 80, slot: 'warn', seconds: 3, peak: 0.5 },
]

const meterText = (meter: Meter): string => `${meter.percent}% ${meter.label}${meter.note === undefined ? '' : ` · ${meter.note}`}`

// `starts` is where each ring's fill starts growing from, in percent, one per meter; empty by default.
// The breakdown bar follows the rings; it never animates. `now` is when the band is drawn, in
// ms: a redraw is a new image, so the chases and the dim pick up where they were (see loopDelay).
export function usageSvg(meters: readonly Meter[], palette: Palette, starts: readonly number[] = [], breakdown?: Breakdown, now?: number): { source: string; width: number; height: number; alt: string } {
  const height = BAND_H
  const circumference = 2 * Math.PI * RING_R
  const lefts: number[] = []
  let width = 0

  for (const meter of meters) {
    lefts.push(width)
    width += RING_R * 2 + 4 + 7 + Math.ceil(measure(meterText(meter), false, 12)) + ITEM_GAP
  }

  const ramps: string[] = []
  const items = meters
    .map((meter, i) => {
      const x = (lefts[i] ?? 0) + RING_R + 4
      const filled = (circumference * meter.percent) / 100
      const start = (circumference * (starts[i] ?? 0)) / 100
      const isContext = meter.label === 'context'
      const jog = (isContext ? JOG_TIERS : PLAN_TIERS).find(tier => meter.percent >= tier.from)
      const color = jog === undefined ? meterColor(meter.percent, palette) : palette[jog.slot]
      // Each ring has its own keyframes, from where it was to where it is; none when it did not move.
      const moves = [
        ...(start === filled ? [] : [`fill${i} .9s cubic-bezier(.2,.8,.2,1)`]),
        ...(jog !== undefined && isContext && meter.percent >= JOG_DIM ? [`dim ${jog.seconds}s ease-in-out ${loopDelay(now, jog.seconds)} infinite`] : []),
      ]
      const grow = moves.length === 0 ? '' : ` style="animation:${moves.join(',')}"`
      ramps.push(start === filled ? '' : `@keyframes fill${i}{from{stroke-dasharray:${start} ${circumference}}}`)

      // Every ring is a jog ring, masked to twelve segments by an 8° gap centred on every hour.
      // Its arc ends square: a round cap would poke past a gap into the next segment.
      const segment = circumference / SEGMENTS
      const ring = [
        `<mask id="jog${i}" maskUnits="userSpaceOnUse" x="${x - 12}" y="${CY - 12}" width="24" height="24"><circle cx="${x}" cy="${CY}" r="${RING_R}" fill="none" stroke="#fff" stroke-width="3" stroke-dasharray="${(segment * 22) / 30} ${(segment * 8) / 30}" transform="rotate(-86 ${x} ${CY})"/></mask><g mask="url(#jog${i})">`,
        `<circle cx="${x}" cy="${CY}" r="${RING_R}" fill="none" stroke="${palette.muted}" stroke-opacity="${TRACK_OPACITY}" stroke-width="2.5"/>`,
        `<circle class="fill" cx="${x}" cy="${CY}" r="${RING_R}" fill="none" stroke="${color}" stroke-width="2.5" stroke-dasharray="${filled} ${circumference}" transform="rotate(-90 ${x} ${CY})"${grow}/>`,
      ]

      if (jog !== undefined) {
        // A segment is unlit while the arc covers less than half of it; the last one always counts.
        const first = Math.min(SEGMENTS - 1, Math.round((meter.percent * SEGMENTS) / 100))
        const count = SEGMENTS - first
        // Each lights a tenth of a cycle after the one before, closer when that would run past the cycle.
        const step = Math.min(jog.seconds / 10, (jog.seconds * 0.55) / Math.max(1, count - 1))
        // Each ring has its own chase keyframes, as their peaks differ.
        ramps.push(`@keyframes jog${i}{0%,45%,100%{opacity:0}18%{opacity:${jog.peak}}}`, isContext && meter.percent >= JOG_DIM ? '@keyframes dim{50%{opacity:.6}}' : '')
        // Held still, only the next segment up shows, at .4.
        ring.push(
          ...Array.from({ length: count }, (_, n) =>
            `<circle cx="${x}" cy="${CY}" r="${RING_R}" fill="none" stroke="${color}" stroke-width="2.5" stroke-dasharray="${segment} ${circumference}" opacity="${n === 0 ? 0.4 : 0}" transform="rotate(${(first + n) * 30 - 90} ${x} ${CY})" style="animation:jog${i} ${jog.seconds}s ease-in-out ${loopDelay(now, jog.seconds, n * step)} infinite"/>`,
          ),
        )
      }

      ring.push('</g>')

      return [
        ...ring,
        `<text x="${x + RING_R + 7}" y="${CY + 4}" font-size="12"><tspan style="fill:${palette.fg};font-weight:600">${meter.percent}%</tspan><tspan style="fill:${palette.muted}"> ${escape(meter.label)}${meter.note === undefined ? '' : ` · ${escape(meter.note)}`}</tspan></text>`,
      ].join('')
    })
    .join('')

  let bar = ''

  if (breakdown !== undefined && breakdown.parts.length > 0) {
    const left = width + 4
    const top = CY - BAR_H / 2
    // A 1px gap parts the segments, so they read apart even where a skin gives them one colour.
    const segments = partSpans(breakdown.parts, BAR_W)
      .filter(span => span.to - span.from > 1)
      .map(span => `<rect class="part" x="${left + span.from}" y="${top}" width="${span.to - span.from - (span.to === BAR_W ? 0 : 1)}" height="${BAR_H}" fill="${palette[span.part.slot]}"/>`)
    const names = breakdown.isLabelled
      ? `<text x="${left + BAR_W + 8}" y="${CY + 4}" font-size="12">${partNames(breakdown.parts)
          .map((name, i) => `${i === 0 ? '' : `<tspan style="fill:${palette.muted}"> · </tspan>`}<tspan style="fill:${palette[breakdown.parts[i]?.slot ?? 'other']}">${escape(name)}</tspan>`)
          .join('')}</text>`
      : ''

    bar = [
      `<rect x="${left}" y="${top}" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}" fill="${palette.muted}" fill-opacity="${TRACK_OPACITY}"/>`,
      ...segments,
      names,
    ].join('')
    width = left + BAR_W + (breakdown.isLabelled ? 8 + Math.ceil(measure(partNames(breakdown.parts).join(' · '), false, 12)) : 0) + 4
  }

  const style = [
    `text{font-family:${FONT}}`,
    ...ramps,
    still(),
  ].join('')

  return {
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><style>${style}</style>${items}${bar}</svg>`,
    width,
    height,
    alt: [
      meters.map(meter => `${meter.label} ${meter.percent}%${meter.note === undefined ? '' : meter.label === 'context' ? ` (${meter.note} tokens)` : ` (resets ${meter.note})`}`).join(', '),
      ...(bar === '' || breakdown === undefined ? [] : [`context holds ${partNames(breakdown.parts).join(', ')}`]),
    ].join('; '),
  }
}

// The terminal's version: one line of block meters, and the breakdown as a bar of cells.
export function usageLine(meters: readonly Meter[]): { text: string; bar: string }[] {
  return meters.map(meter => {
    const filled = Math.round(meter.percent / 12.5)

    return { bar: '▰'.repeat(filled) + '▱'.repeat(8 - filled), text: ` ${meterText(meter)}` }
  })
}

export const partCells = (parts: readonly Part[]): { slot: Slot; cells: string }[] =>
  partSpans(parts, 8)
    .filter(span => span.to > span.from)
    .map(span => ({ slot: span.part.slot, cells: '■'.repeat(span.to - span.from) }))
