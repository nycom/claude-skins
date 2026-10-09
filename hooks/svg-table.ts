import { LINK } from './markdown'
import type { Align, Table } from './markdown'
import type { Palette } from './skin'
import { CONTROL_SLOT, escape, measure as measureAt, MONO, staggerMs, svgCard } from './svg-kit'

// A table as an animated vector card in the skin's colours, with no background of its
// own so the page shows through, for the surfaces that draw `Svg` (the desktop app).
// Long cells wrap onto more lines instead of being cut, so nothing is hidden: the
// desktop draws the card as an image, which cannot show a tooltip on hover.

const SIZE = 15
const LINE_H = 21
const HEADER_H = 58
const HEAD_LINE_H = 16
// The header's 12px capitals with their .1em letter spacing measure about as 14px text.
const HEAD_MEASURE = 14
const ROW_PAD_Y = 12
const MIN_ROW_H = 44
const PAD_X = 24
const COL_GAP = 28
const MIN_COL = 56
const MIN_WIDTH = 420
const MAX_WIDTH = 1600
const STAGGER_MS = 60

export type SvgTable = { source: string; width: number; height: number; alt: string }

type CellKind = 'text' | 'code' | 'number' | 'colour' | 'diff'

const HEX = /^#[0-9a-f]{6}$/i
const DIFF = /^\+(\d+)\s*[−-](\d+)$/
const NUMBER = /^[+−-]?[$€£]?\d[\d.,]*\s?(%|ms|s|min|h|kb|mb|gb|x|×)?$/i
const CODE = /^[^\s]*[/_.:@][^\s]*$/

export const kindOfCell = (cell: string): CellKind => {
  const text = cell.trim()

  if (HEX.test(text)) {
    return 'colour'
  }

  if (DIFF.test(text)) {
    return 'diff'
  }

  if (NUMBER.test(text)) {
    return 'number'
  }

  return CODE.test(text) && text.length > 1 ? 'code' : 'text'
}

// A link's text is drawn between these marks, which take no room, and styled as a link.
const OPEN = '\u0001'
const CLOSE = '\u0002'
const showLinks = (cell: string): string => cell.replace(LINK, `${OPEN}$1${CLOSE}`)

// Width of a string in pixels, at the table's type size unless told another.
export const measure = (text: string, isMono: boolean, size = SIZE): number => measureAt(text.replace(/[\u0001\u0002]/g, ''), isMono, size)

const isMonoKind = (kind: CellKind): boolean => kind !== 'text'

// Splits a word too long for its column into pieces that each fit.
function breakWord(word: string, width: number, isMono: boolean, size: number): string[] {
  const pieces: string[] = []
  let piece = ''

  for (const char of word) {
    if (piece !== '' && measure(piece + char, isMono, size) > width) {
      pieces.push(piece)
      piece = char
    } else {
      piece += char
    }
  }

  return piece === '' ? pieces : [...pieces, piece]
}

// The cell's text as lines that fit its column, all of it: nothing is cut.
export function wrapCell(text: string, width: number, isMono: boolean, size = SIZE): string[] {
  const lines: string[] = []
  let line = ''

  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line === '' ? word : `${line} ${word}`

    if (measure(candidate, isMono, size) <= width) {
      line = candidate
      continue
    }

    if (line !== '') {
      lines.push(line)
    }

    const pieces = measure(word, isMono, size) <= width ? [word] : breakWord(word, width, isMono, size)
    lines.push(...pieces.slice(0, -1))
    line = pieces.at(-1) ?? ''
  }

  const all = line === '' ? lines : [...lines, line]

  return all.length === 0 ? [''] : all
}

// Width of what a cell holds: all of it, or with `isWord` its longest word, the narrowest
// its column can be without breaking one. Colours, diffs and numbers never wrap.
function cellWidth(cell: string, isWord: boolean): number {
  const kind = kindOfCell(cell)
  const isWrapped = isWord && (kind === 'text' || kind === 'code')
  const parts = isWrapped ? cell.split(/\s+/) : [cell]

  return Math.max(0, ...parts.map(part => measure(part, isMonoKind(kind)))) + (kind === 'colour' ? 22 : 0)
}

// Per column, its widest cell or header, or with `isWord` its widest word; the last column
// keeps `reserve` more beside its header, the corner a control is laid over.
function columnWidthsOf(table: Table, isWord: boolean, reserve: number): number[] {
  return table.header.map((header, col) => {
    const head = (isWord ? header.toUpperCase().split(/\s+/) : [header.toUpperCase()]).map(part => measure(part, false, HEAD_MEASURE))
    const widest = Math.max(
      Math.max(...head) + (col === table.header.length - 1 ? reserve : 0),
      ...table.rows.map(row => cellWidth(row[col] ?? '', isWord)),
    )

    return Math.max(MIN_COL, Math.ceil(widest))
  })
}

// Columns that fit their fair share keep their natural width; the rest share what is
// left in proportion to how much they hold, and wrap. With room to spare, every column
// stretches in proportion, so the card spans its width. A column is never narrower than
// its `least` (its longest word) while the columns' leasts fit: the widest give way first.
// Only a word wider than the whole table breaks.
export function fitColumns(natural: readonly number[], width: number, least: readonly number[] = []): number[] {
  const room = width - PAD_X * 2 - COL_GAP * (natural.length - 1)
  const total = natural.reduce((sum, w) => sum + w, 0)

  if (total <= room) {
    return natural.map(w => w + ((room - total) * w) / total)
  }

  const fair = room / natural.length
  const fixed = natural.reduce((sum, w) => sum + (w <= fair ? w : 0), 0)
  const flexTotal = natural.reduce((sum, w) => sum + (w > fair ? w : 0), 0)
  const flexRoom = Math.max(0, room - fixed)
  const shared = natural.map(w => (w <= fair ? w : Math.max(MIN_COL, (flexRoom * w) / flexTotal)))
  const floors = natural.map((_, i) => Math.min(least[i] ?? 0, room))
  const floorTotal = floors.reduce((sum, w) => sum + w, 0)

  if (shared.every((w, i) => w >= (floors[i] ?? 0))) {
    return shared
  }

  if (floorTotal > room) {
    return floors.map(w => (w * room) / floorTotal)
  }

  // The level the widest columns are cut down to, found by halving.
  const fit = (level: number) => shared.map((w, i) => Math.max(floors[i] ?? 0, Math.min(w, level)))
  let low = 0
  let high = Math.max(...shared)

  for (let step = 0; step < 40; step++) {
    const level = (low + high) / 2

    if (fit(level).reduce((sum, w) => sum + w, 0) > room) {
      high = level
    } else {
      low = level
    }
  }

  return fit(low)
}

const anchorOf = (align: Align): string => (align === 'right' ? 'end' : align === 'center' ? 'middle' : 'start')

const xOf = (left: number, width: number, align: Align): number =>
  align === 'right' ? left + width : align === 'center' ? left + width / 2 : left

type Cell = { kind: CellKind; text: string; lines: string[] }

function layoutCell(text: string, width: number): Cell {
  const kind = kindOfCell(text)
  const isWrapped = kind === 'text' || kind === 'code'

  return { kind, text, lines: isWrapped ? wrapCell(text, width, kind === 'code') : [text] }
}

function cellMarkup(cell: Cell, left: number, width: number, align: Align, rowH: number, palette: Palette): string {
  const isMono = isMonoKind(cell.kind)
  const font = isMono ? `font-family="${MONO}" font-size="${SIZE - 0.5}"` : ''
  const blockH = cell.lines.length * LINE_H
  const firstY = (rowH - blockH) / 2 + LINE_H / 2 + 5
  const middle = rowH / 2

  if (cell.kind === 'colour') {
    const x = align === 'right' ? left + width - measure(cell.text, true) - 22 : left

    return `<circle cx="${x + 6}" cy="${middle}" r="6" fill="${cell.text}" stroke="${palette.muted}"/><text x="${x + 22}" y="${middle + 5}" ${font} fill="${palette.fg}">${escape(cell.text)}</text>`
  }

  if (cell.kind === 'diff') {
    const [, added = '0', removed = '0'] = DIFF.exec(cell.text.trim()) ?? []

    return `<text x="${xOf(left, width, align)}" y="${middle + 5}" text-anchor="${anchorOf(align)}" ${font}><tspan fill="${palette.ok}">+${added}</tspan><tspan fill="${palette.muted}"> </tspan><tspan fill="${palette.err}">−${removed}</tspan></text>`
  }

  // A link's text may wrap: each line closes the link it leaves open and the next reopens it.
  let isInLink = false

  return cell.lines
    .map((line, i) => {
      const reopen = isInLink ? '<tspan class="link">' : ''
      isInLink = line.lastIndexOf(OPEN) > line.lastIndexOf(CLOSE) || (isInLink && !line.includes(CLOSE))
      const shown = escape(line).replaceAll(OPEN, '<tspan class="link">').replaceAll(CLOSE, '</tspan>')

      return `<text x="${xOf(left, width, align)}" y="${firstY + i * LINE_H}" text-anchor="${anchorOf(align)}" ${font} fill="${palette.fg}" class="${cell.kind === 'number' ? 'num' : ''}">${reopen}${shown}${isInLink ? '</tspan>' : ''}</text>`
    })
    .join('')
}

// `width` is the room the reply gives the card, in pixels; it is clamped to a sane range.
// `fresh` is the first row new since the card's last draw: on a redraw only rows from it
// on rise in, their stagger starting at once. `hasControl` keeps the header row's right
// end free for a Copy button laid over it.
export function tableSvg(table: Table, palette: Palette, width: number, fresh?: number, hasControl = false): SvgTable {
  const cardWidth = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width)))
  const reserve = hasControl ? CONTROL_SLOT : 0
  const shownRows = table.rows.map(row => row.map(showLinks))
  const shown = { ...table, rows: shownRows }
  const widths = fitColumns(columnWidthsOf(shown, false, reserve), cardWidth, columnWidthsOf(shown, true, reserve))
  const lefts = widths.map((_, i) => PAD_X + widths.slice(0, i).reduce((sum, w) => sum + w + COL_GAP, 0))
  const align = (i: number): Align => table.align[i] ?? 'left'

  const laid = shownRows.map(row => row.map((cell, i) => layoutCell(cell, (widths[i] ?? MIN_COL) - (kindOfCell(cell) === 'colour' ? 22 : 0))))
  const heights = laid.map(cells => Math.max(MIN_ROW_H, Math.max(...cells.map(cell => cell.lines.length)) * LINE_H + ROW_PAD_Y * 2))
  // A header too long for its column wraps, and the header grows to hold it.
  const headWidth = (i: number): number => (widths[i] ?? MIN_COL) - (i === widths.length - 1 ? reserve : 0)
  const heads = table.header.map((cell, i) => wrapCell(cell.toUpperCase(), headWidth(i), false, HEAD_MEASURE))
  const headerH = HEADER_H + (Math.max(...heads.map(lines => lines.length)) - 1) * HEAD_LINE_H
  const tops = heights.map((_, r) => headerH + heights.slice(0, r).reduce((sum, h) => sum + h, 0))
  const height = headerH + heights.reduce((sum, h) => sum + h, 0) + 6

  const header = heads
    .map((lines, i) =>
      lines
        .map(
          (text, l) =>
            `<text x="${xOf(lefts[i] ?? 0, headWidth(i), align(i))}" y="${headerH / 2 + 4 + (l - (lines.length - 1) / 2) * HEAD_LINE_H}" text-anchor="${anchorOf(align(i))}" class="head">${escape(text)}</text>`,
        )
        .join(''),
    )
    .join('')

  const rows = laid
    .map((cells, r) => {
      const rowH = heights[r] ?? MIN_ROW_H
      const markup = cells.map((cell, i) => cellMarkup(cell, lefts[i] ?? 0, widths[i] ?? 0, align(i), rowH, palette)).join('')
      const band = r % 2 === 1 ? `fill="${palette.fg}" fill-opacity=".05"` : 'fill="none"'
      const isFresh = fresh !== undefined && r >= fresh

      // The outer group places the row; the inner one rises relative to that place.
      return `<g transform="translate(0 ${tops[r] ?? 0})"><g class="${isFresh ? 'row fresh' : 'row'}" style="animation-delay:${120 + staggerMs(isFresh ? r - fresh : r, STAGGER_MS)}ms"><rect class="bg" x="0" y="0" width="${cardWidth}" height="${rowH}" ${band}/>${markup}</g></g>`
    })
    .join('')

  const style = [
    `text{font-size:${SIZE}px}`,
    `.head{font-size:12px;font-weight:600;letter-spacing:.1em;fill:${palette.muted}}`,
    `.num{font-variant-numeric:tabular-nums}`,
    `.link{fill:${palette.web};text-decoration:underline}`,
    // Visible by default: `both` hides a row or the rule only while its delay runs.
    `.row{animation:rise .5s cubic-bezier(.2,.8,.2,1) both}`,
    `.rule{stroke-dasharray:${cardWidth};animation:draw .8s cubic-bezier(.6,0,.2,1) .05s both}`,
    `@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1}}`,
    `@keyframes draw{from{stroke-dashoffset:${cardWidth}}to{stroke-dashoffset:0}}`,
  ].join('')

  const body = [
    header,
    `<line class="rule" x1="${PAD_X}" y1="${headerH - 1}" x2="${cardWidth - PAD_X - reserve}" y2="${headerH - 1}" stroke="${palette.user}" stroke-width="1" stroke-linecap="square"/>`,
    rows,
  ].join('')

  return {
    source: svgCard(cardWidth, height, palette, style, body, fresh === undefined ? undefined : '.fresh'),
    width: cardWidth,
    height,
    alt: [table.header.join(' | '), ...table.rows.map(row => row.join(' | '))].join('\n'),
  }
}
