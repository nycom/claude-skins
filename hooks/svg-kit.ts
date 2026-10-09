import type { Palette } from './skin'

// What every vector card shares: fonts, text measuring and fitting, escaping, and the
// card shell. Cards have no background of their own: the desktop draws an Svg as an
// image, so the page shows through, and bands are faint tints of the text colour.

export const FONT = `ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Inter, sans-serif`
export const MONO = `ui-monospace, 'Cascadia Code', 'JetBrains Mono', Consolas, monospace`

export const escape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Width of a string in pixels, close enough to lay out a card without a renderer.
export function measure(text: string, isMono: boolean, size: number): number {
  if (isMono) {
    return [...text].length * size * 0.6
  }

  return [...text].reduce((sum, char) => {
    if ('iljtf.,:;|!\'` '.includes(char)) {
      return sum + size * 0.3
    }

    if ('mwMW@%'.includes(char)) {
      return sum + size * 0.82
    }

    return sum + (char >= 'A' && char <= 'Z' ? size * 0.64 : size * 0.54)
  }, 0)
}

// Keeps the characters that fit with an ellipsis after them, at least one; one pass, so a
// long line costs no more than its length.
export function fitText(text: string, width: number, isMono: boolean, size: number): string {
  if (measure(text, isMono, size) <= width) {
    return text
  }

  const room = width - measure('…', isMono, size)
  let used = 0
  let kept = ''

  for (const char of text) {
    used += measure(char, isMono, size)

    if (used > room && kept !== '') {
      break
    }

    kept += char
  }

  return `${kept}…`
}

// Alt text for a card that holds a whole file or block: a reader gets the first MAX_ALT
// characters, the clipboard the rest.
export const MAX_ALT = 4000

export const capAlt = (text: string): string => (text.length > MAX_ALT ? `${text.slice(0, MAX_ALT)}…` : text)

// The room a reply gives a card, from the width the desktop reports in cells of its code
// font, kept to a range a card reads well at. The reported width runs wider than the
// reply column, so this errs small: a card that fits beats one that runs off the edge.
export const PX_PER_COLUMN = 6.4

export const cardWidth = (columns: number, min = 480, max = 1600): number =>
  Math.round(Math.min(max, Math.max(min, columns * PX_PER_COLUMN)))

// Rows that rise in one after another; `still()` holds them for reduced motion. Rows are
// visible by default: the animation's `both` fill hides one only while its delay runs.
export const MOTION = [
  '.rise{animation:rise .45s cubic-bezier(.2,.8,.2,1) both}',
  '.card{animation:fade .3s ease-out}',
  '@keyframes rise{from{opacity:0;transform:translateY(5px)}to{opacity:1}}',
  '@keyframes fade{from{opacity:0}to{opacity:1}}',
].join('')

// However many rows a card has, the last starts rising within this of the first.
const MAX_STAGGER_MS = 250

export const staggerMs = (index: number, stepMs: number): number => Math.min(index * stepMs, MAX_STAGGER_MS)

// ponytail: module state, set from Claude Code's Reduce motion setting each time it is read,
// so every card and icon drawn after holds still; a per-render flag would thread through
// every builder.
let isStill = false
let isRedraw = false

export const holdStill = (on: boolean): void => {
  isStill = on
}

// A surface swaps a card's image whenever its row is drawn again (a setting, a theme poll,
// the host's own repaint), and a new image plays its rise-in again. So a row animates on
// its first draw only; `draw` builds the card held still when this is a redraw.
export function drawOnce<T>(redraws: boolean, draw: () => T): T {
  const was = isRedraw
  isRedraw = was || redraws
  try {
    return draw()
  } finally {
    isRedraw = was
  }
}

const HOLD = '*{animation:none!important}'
const SYSTEM_HOLD = `@media (prefers-reduced-motion:reduce){${HOLD}}`

// Holds every animation still: always under Claude Code's Reduce motion, else when the
// system asks for reduced motion, and on a redraw all but the `moving` elements, such as
// a table's rows that streamed in since its last draw.
export const still = (moving?: string): string =>
  isStill || (isRedraw && moving === undefined)
    ? HOLD
    : isRedraw
      ? `:not(${moving}){animation:none!important}${SYSTEM_HOLD}`
      : SYSTEM_HOLD

// A looping animation's delay. An image drawn again is a new image, which starts its
// animations over; given when it is drawn (`now`, in ms), a loop starts where it would be
// had it run since the epoch, so a redraw carries on mid-cycle. `offset` is how far it
// lags the loop's start, in seconds. Held still, or with no `now`, the delay is the offset,
// so the image holds no time.
export function loopDelay(now: number | undefined, seconds: number, offset = 0): string {
  if (now === undefined || isStill) {
    return `${Math.round(offset * 1000)}ms`
  }

  const into = (((now / 1000 - offset) % seconds) + seconds) % seconds

  return `${-Math.round(into * 1000)}ms`
}

export const riseDelay = (index: number, stepMs: number, startMs = 80): string =>
  `style="animation-delay:${startMs + staggerMs(index, stepMs)}ms"`

const RADIUS = 12

// The room a card leaves at the right end of its header row for the Copy button laid
// over it: the one-glyph icon and a gap.
export const CONTROL_SLOT = 44

// Where a header's labels centre: the line the Copy button laid over a card sits on,
// one text row down from the card's top edge.
export const HEADER_MID = 29

// The card: a rounded hairline outline, with everything inside clipped to its corners.
export function svgCard(width: number, height: number, palette: Palette, style: string, body: string, moving?: string): string {
  // Unique per size, so cards placed together in one document keep their own corners.
  const clip = `corners-${width}x${height}`

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<defs><clipPath id="${clip}"><rect width="${width}" height="${height}" rx="${RADIUS}"/></clipPath></defs>`,
    // Sans for text that names no font of its own: a CSS rule on all text would beat the
    // monospace attribute on code, paths and output.
    `<style>text{fill:${palette.fg}}text:not([font-family]){font-family:${FONT}}${MOTION}${style}${still(moving)}</style>`,
    `<g class="card"><g clip-path="url(#${clip})">${body}</g>`,
    `<rect x=".5" y=".5" width="${width - 1}" height="${height - 1}" rx="${RADIUS - 0.5}" fill="none" stroke="${palette.fg}" stroke-opacity=".3"/></g>`,
    `</svg>`,
  ].join('')
}

// A band behind a row, as a faint tint of the text colour, so it reads on any page.
export const tint = (palette: Palette, y: number, width: number, height: number, opacity = 0.05): string =>
  `<rect y="${y}" width="${width}" height="${height}" fill="${palette.fg}" fill-opacity="${opacity}"/>`

// A small rounded label, such as `exit 0` or `new file`, right-aligned at `right`.
export function pill(right: number, y: number, text: string, color: string, palette: Palette): string {
  const width = Math.ceil(measure(text, true, 11) + 16)
  const left = right - width

  return `<rect x="${left}" y="${y}" width="${width}" height="20" rx="10" fill="${color}" fill-opacity=".14"/><text x="${left + width / 2}" y="${y + 14}" text-anchor="middle" font-family="${MONO}" font-size="11" style="fill:${color}">${escape(text)}</text>`
}

export const strokeIcon = (path: string, x: number, y: number, size: number, color: string): string =>
  `<g transform="translate(${x} ${y}) scale(${size / 24})" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</g>`
