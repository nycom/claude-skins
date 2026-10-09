import type { UsageSnap } from '../types'
import type { Palette } from './skin'
import { escape, FONT, still } from './svg-kit'

// The band above the prompt: how full the context window is and how much of each plan
// limit is spent, as rings that fill in when they draw.

const RING_R = 8

// The band sits in the desktop's rounded row above the prompt, which adds about 2pt of padding.
// 23 + 2 matches the PR status rows and the input box beside it (25pt each).
export const BAND_H = 23
const CY = BAND_H / 2
const ITEM_W = 132

export type Meter = { label: string; percent: number }

// How long after a new reading the rings grow; past it they are drawn settled.
export const SETTLE_MS = 1200

// A ring grows from the reading it last showed, not from empty. The band is one image, so a
// new reading on any ring redraws them all: the rings that moved grow from where they were,
// the rest are drawn already full. A redraw at the same readings keeps the same starts, so it
// draws the same image and nothing replays, until SETTLE_MS have passed: from then on the
// rings are drawn settled, so an image the surface builds again has no growth left to play.
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

export function metersOf(usage: UsageSnap): Meter[] {
  return [
    ...(usage.context === null ? [] : [{ label: 'context', percent: usage.context }]),
    ...usage.limits.map(limit => ({ label: limit.label, percent: limit.percent })),
  ].map(meter => ({ ...meter, percent: Math.max(0, Math.min(100, Math.round(meter.percent))) }))
}

// Accent while there is room; the warning colour from 80 %, the error colour from 95 %.
export const meterColor = (percent: number, palette: Palette): string =>
  percent >= 95 ? palette.err : percent >= 80 ? palette.warn : palette.user

// The track is a faint guide; the fill carries the reading, at 3:1 against the track and
// the page alike in every skin.
export const TRACK_OPACITY = 0.2

// A soft halo that breathes out from the context ring while the band nudges to compact.
const PULSE = '@keyframes pulse{50%{stroke-width:6px;stroke-opacity:.35}}'

// `starts` is where each ring's fill starts growing from, in percent, one per meter; empty by default.
export function usageSvg(meters: readonly Meter[], palette: Palette, starts: readonly number[] = [], isPulsing = false): { source: string; width: number; height: number; alt: string } {
  const width = meters.length * ITEM_W
  const height = BAND_H
  const circumference = 2 * Math.PI * RING_R

  const ramps: string[] = []
  const items = meters
    .map((meter, i) => {
      const x = i * ITEM_W + RING_R + 4
      const filled = (circumference * meter.percent) / 100
      const start = (circumference * (starts[i] ?? 0)) / 100
      const color = meterColor(meter.percent, palette)
      // Each ring has its own keyframes, from where it was to where it is; none when it did not move.
      const grow = start === filled ? '' : ` style="animation:fill${i} .9s cubic-bezier(.2,.8,.2,1)"`
      ramps.push(start === filled ? '' : `@keyframes fill${i}{from{stroke-dasharray:${start} ${circumference}}}`)

      const halo = isPulsing && meter.label === 'context'
        ? `<circle cx="${x}" cy="${CY}" r="${RING_R}" fill="none" stroke="${color}" stroke-opacity="0" stroke-width="2.5" style="animation:pulse 2s ease-in-out infinite"/>`
        : ''

      return [
        halo,
        `<circle cx="${x}" cy="${CY}" r="${RING_R}" fill="none" stroke="${palette.muted}" stroke-opacity="${TRACK_OPACITY}" stroke-width="2.5"/>`,
        `<circle class="fill" cx="${x}" cy="${CY}" r="${RING_R}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="${filled} ${circumference}" transform="rotate(-90 ${x} ${CY})"${grow}/>`,
        `<text x="${x + RING_R + 7}" y="${CY + 4}" font-size="12"><tspan style="fill:${palette.fg};font-weight:600">${meter.percent}%</tspan><tspan style="fill:${palette.muted}"> ${escape(meter.label)}</tspan></text>`,
      ].join('')
    })
    .join('')

  const style = [
    `text{font-family:${FONT}}`,
    ...ramps,
    ...(isPulsing ? [PULSE] : []),
    still(),
  ].join('')

  return {
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><style>${style}</style>${items}</svg>`,
    width,
    height,
    alt: meters.map(meter => `${meter.label} ${meter.percent}%`).join(', '),
  }
}

// The terminal's version: one line of block meters.
export function usageLine(meters: readonly Meter[]): { label: string; bar: string; percent: number }[] {
  return meters.map(meter => {
    const filled = Math.round(meter.percent / 12.5)

    return { label: meter.label, bar: '▰'.repeat(filled) + '▱'.repeat(8 - filled), percent: meter.percent }
  })
}
