import type { UsageSnap } from '../types'
import { compactCount, resetLabel } from './format'
import { channels } from './light'
import type { Palette, Slot } from './skin'
import { escape, FONT, loopSource, measure, still } from './svg-kit'

// The band above the prompt: how full the context window is and how much of each plan
// limit is spent, as rings that fill in when they draw, and what fills the context, as a bar.
// Each ring is an image of its own, apart from its text and the bar: the desktop draws an
// Svg as an image of its source, and a changed source is a new image whose loops start
// over, so a ring's source holds only what its ring shows: its reading, colours and growth.

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

// How long after a new reading the rings grow; past it they are drawn settled.
export const SETTLE_MS = 1200

// A ring grows from the reading it last showed, not from empty. A new reading on any ring
// redraws the band: the rings that moved grow from where they were, the rest are drawn already
// full. A redraw at the same readings keeps the same starts, so it draws the same images and
// nothing replays, until SETTLE_MS have passed: from then on the rings are drawn settled, so
// an image the surface builds again has no growth left to play.
export function rampFrom(): (meters: readonly Meter[], now: number) => readonly number[] {
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

    return starts
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

// `now` places each reset as a time today, tomorrow or on a weekday further off.
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

// On a skin where two or more parts share one colour exactly, as noir does, the parts step
// down in opacity in part order so they still tell apart; the first three hold 3:1 on the
// track and the page. Colours that are only near each other stay at full strength.
const STEPS = [1, 0.8, 0.62, 0.48, 0.38]
const partOpacities = (parts: readonly Part[], palette: Palette): number[] => {
  const colours = parts.map(part => channels(palette[part.slot]).join())
  const isShared = new Set(colours).size < colours.length

  return parts.map((_, i) => (isShared ? (STEPS[Math.min(i, STEPS.length - 1)] ?? 1) : 1))
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

// A ring's image: square, centred on its ring, the text's image right after it.
export const RING_W = RING_R * 2 + 8
const RX = RING_W / 2
const CIRCUMFERENCE = 2 * Math.PI * RING_R
const SEGMENT = CIRCUMFERENCE / SEGMENTS
// Room between a ring and its text.
const TEXT_X = 3

type Image = { source: string; width: number; alt: string }

const image = (width: number, style: string, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${BAND_H}" viewBox="0 0 ${width} ${BAND_H}"><style>${style}</style>${body}</svg>`

// One ring, its fill grown from `start` percent: every input is a reading or a colour, so the
// same reading draws the same image and its chase runs on through any redraw.
function ringSvg(isContext: boolean, percent: number, start: number, palette: Palette): string {
  const jog = (isContext ? JOG_TIERS : PLAN_TIERS).find(tier => percent >= tier.from)
  const color = jog === undefined ? meterColor(percent, palette) : palette[jog.slot]

  return loopSource(`ring:${isContext}:${percent}:${start}:${color}:${palette.muted}`, () => {
    const filled = (CIRCUMFERENCE * percent) / 100
    const from = (CIRCUMFERENCE * start) / 100
    const isDim = jog !== undefined && isContext && percent >= JOG_DIM
    // The fill grows from where it was to where it is; not at all when it did not move.
    const moves = [...(from === filled ? [] : ['fill .9s cubic-bezier(.2,.8,.2,1)']), ...(isDim ? [`dim ${jog.seconds}s ease-in-out infinite`] : [])]
    const grow = moves.length === 0 ? '' : ` style="animation:${moves.join(',')}"`
    const style: string[] = from === filled ? [] : [`@keyframes fill{from{stroke-dasharray:${from} ${CIRCUMFERENCE}}}`]

    // A jog ring, masked to twelve segments by an 8° gap centred on every hour. Its arc ends
    // square: a round cap would poke past a gap into the next segment.
    const ring = [
      `<mask id="jog" maskUnits="userSpaceOnUse" x="0" y="${CY - 12}" width="24" height="24"><circle cx="${RX}" cy="${CY}" r="${RING_R}" fill="none" stroke="#fff" stroke-width="3" stroke-dasharray="${(SEGMENT * 22) / 30} ${(SEGMENT * 8) / 30}" transform="rotate(-86 ${RX} ${CY})"/></mask><g mask="url(#jog)">`,
      `<circle cx="${RX}" cy="${CY}" r="${RING_R}" fill="none" stroke="${palette.muted}" stroke-opacity="${TRACK_OPACITY}" stroke-width="2.5"/>`,
      `<circle class="fill" cx="${RX}" cy="${CY}" r="${RING_R}" fill="none" stroke="${color}" stroke-width="2.5" stroke-dasharray="${filled} ${CIRCUMFERENCE}" transform="rotate(-90 ${RX} ${CY})"${grow}/>`,
    ]

    if (jog !== undefined) {
      // A segment is unlit while the arc covers less than half of it; the last one always counts.
      const first = Math.min(SEGMENTS - 1, Math.round((percent * SEGMENTS) / 100))
      const count = SEGMENTS - first
      // Each lights a tenth of a cycle after the one before, closer when that would run past the cycle.
      const step = Math.min(jog.seconds / 10, (jog.seconds * 0.55) / Math.max(1, count - 1))
      style.push(`@keyframes jog{0%,45%,100%{opacity:0}18%{opacity:${jog.peak}}}`, isDim ? '@keyframes dim{50%{opacity:.6}}' : '')
      // Held still, only the next segment up shows, at .4.
      ring.push(
        ...Array.from({ length: count }, (_, n) =>
          `<circle cx="${RX}" cy="${CY}" r="${RING_R}" fill="none" stroke="${color}" stroke-width="2.5" stroke-dasharray="${SEGMENT} ${CIRCUMFERENCE}" opacity="${n === 0 ? 0.4 : 0}" transform="rotate(${(first + n) * 30 - 90} ${RX} ${CY})" style="animation:jog ${jog.seconds}s ease-in-out ${Math.round(n * step * 1000)}ms infinite"/>`,
        ),
      )
    }

    ring.push('</g>')

    return image(RING_W, [...style, still()].join(''), ring.join(''))
  })
}

// A ring's reading and note, after its ring, with the room before the next ring.
function textSvg(meter: Meter, palette: Palette): Image {
  const width = TEXT_X + Math.ceil(measure(meterText(meter), false, 12)) + ITEM_GAP
  const body = `<text x="${TEXT_X}" y="${CY + 4}" font-size="12"><tspan style="fill:${palette.fg};font-weight:600">${meter.percent}%</tspan><tspan style="fill:${palette.muted}"> ${escape(meter.label)}${meter.note === undefined ? '' : ` · ${escape(meter.note)}`}</tspan></text>`

  return {
    source: image(width, `text{font-family:${FONT}}`, body),
    width,
    alt: meter.note === undefined ? '' : meter.label === 'context' ? `${meter.note} tokens` : `resets ${meter.note.replace(/^tmrw/, 'tomorrow')}`,
  }
}

// What fills the context, as a bar after the rings; it never animates.
function barSvg(parts: readonly Part[], palette: Palette): Image {
  const top = CY - BAR_H / 2
  const opacities = partOpacities(parts, palette)
  // A 1px gap parts the segments, so they read apart even where a skin gives them one colour.
  const segments = partSpans(parts, BAR_W)
    .map((span, i) => ({ ...span, i }))
    .filter(span => span.to - span.from > 1)
    .map(span => `<rect class="part" x="${4 + span.from}" y="${top}" width="${span.to - span.from - (span.to === BAR_W ? 0 : 1)}" height="${BAR_H}" fill="${palette[span.part.slot]}" fill-opacity="${opacities[span.i]}"/>`)

  return {
    source: image(BAR_W + 8, '', [`<rect x="4" y="${top}" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}" fill="${palette.muted}" fill-opacity="${TRACK_OPACITY}"/>`, ...segments].join('')),
    width: BAR_W + 8,
    alt: `context holds ${parts.map(part => `${part.label} ${part.share}%`).join(', ')}`,
  }
}

// The band's images, in order: each ring, RING_W wide, then its text; then the breakdown bar,
// when there are parts. `starts` is where each ring's fill starts growing from, in percent,
// one per meter; empty by default. `width` is all of them side by side. A ring's alt reads
// its reading, its text's the note, the bar's every part.
export function usageSvg(
  meters: readonly Meter[],
  palette: Palette,
  starts: readonly number[] = [],
  parts: readonly Part[] = [],
): { rings: { ring: Image; text: Image }[]; bar?: Image; width: number } {
  const rings = meters.map((meter, i) => ({
    ring: { source: ringSvg(meter.label === 'context', meter.percent, starts[i] ?? 0, palette), width: RING_W, alt: `${meter.label} ${meter.percent}%` },
    text: textSvg(meter, palette),
  }))
  const bar = parts.length > 0 ? barSvg(parts, palette) : undefined

  return {
    rings,
    ...(bar === undefined ? {} : { bar }),
    width: rings.reduce((sum, { text }) => sum + RING_W + text.width, 0) + (bar?.width ?? 0),
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
