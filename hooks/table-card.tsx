import { LINK, plainCell } from './markdown'
import type { Table } from './markdown'
import type { Look, Ui } from './rows'
import { cardWidth, CONTROL_SLOT, measure } from './svg-kit'

// A table on the desktop built from the surface's own elements: a grid of Boxes, each
// body cell its own markdown, so links open, text selects, inline code and bold draw as
// in a reply, and the type follows the app's font size. Nothing is an image, so nothing
// replays when the row is drawn again.

// Spacing, in the desktop's units: a column is a code-font cell (about 8px, taken high so the
// pixels a padding is counted at never fall short; rows.tsx's CELL_W takes it low for the
// inverse sum), a row a line of body text (about 20px); fractions are taken as they are.
// A cell's padding each side, about 16px.
export const PAD_X = 2
// A body cell's padding above and below, about 12px.
export const PAD_Y = 0.6
// The header's, about 12px.
export const HEAD_PAD_Y = 0.6
// Between the border and the bands on every side: none, so the bands span the card and its
// rounded corners clip them.
export const INSET = 0

const SIZE = 15
// Bold capitals run about a size wider than the body's text.
const HEAD_SIZE = SIZE + 1
// A cell's padding, both sides, in pixels.
const CELL_PAD = Math.ceil(2 * PAD_X * 8)
const MIN_COL = 56

export const JUSTIFY = { left: 'flex-start', right: 'flex-end', center: 'center' } as const

// A cell's text as the surface shows it, in runs: a link by its label, code spans in the
// code font, bold without its marks.
const runsOf = (cell: string): { text: string; isMono: boolean }[] =>
  cell
    .replace(LINK, '$1')
    .replace(/\*\*|__/g, '')
    .replace(/\\\|/g, '|')
    .split('`')
    .map((text, i) => ({ text, isMono: i % 2 === 1 }))

// Width of a cell in pixels: all of it, or with `isWord` its longest word, the narrowest
// its column can be without breaking one.
const cellWidth = (cell: string, isWord: boolean): number =>
  isWord
    ? Math.max(0, ...runsOf(cell).flatMap(run => run.text.split(/\s+/).map(word => measure(word, run.isMono, SIZE))))
    : runsOf(cell).reduce((sum, run) => sum + measure(run.text, run.isMono, SIZE), 0)

// The header as plain capitals: it is drawn as styled text, not markdown.
const headOf = (cell: string): string => plainCell(cell.replace(LINK, '$1')).toUpperCase()

// Per column, its widest cell or header, or with `isWord` its widest word, padding
// included; the last column keeps `reserve` more beside its header, the slot Copy sits in.
function columnWidthsOf(table: Table, isWord: boolean, reserve: number): number[] {
  return table.header.map((header, col) => {
    const head = headOf(header)
    const heads = (isWord ? head.split(/\s+/) : [head]).map(part => measure(part, false, HEAD_SIZE))
    const widest = Math.max(
      Math.max(...heads) + (col === table.header.length - 1 ? reserve : 0),
      ...table.rows.map(row => cellWidth(row[col] ?? '', isWord)),
    )

    return Math.max(MIN_COL, Math.ceil(widest + CELL_PAD))
  })
}

// Columns that fit their fair share keep their natural width; the rest share what is
// left in proportion to how much they hold, and wrap. With room to spare, every column
// stretches in proportion, so the card spans its width. A column is never narrower than
// its `least` (its longest word) while the columns' leasts fit: the widest give way first.
// Only a word wider than the whole table breaks.
export function fitColumns(natural: readonly number[], room: number, least: readonly number[] = []): number[] {
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

// Widths as whole percentages, as a Box takes them, summing to 100: what rounding gains
// or loses goes to the widest column, which has the most slack.
function sharesOf(widths: readonly number[]): number[] {
  const total = widths.reduce((sum, w) => sum + w, 0)
  const shares = widths.map(w => Math.round((w * 100) / total))
  const widest = widths.indexOf(Math.max(...widths))
  shares[widest] = (shares[widest] ?? 0) + 100 - shares.reduce((sum, share) => sum + share, 0)

  return shares
}

// The card spans the reply; its columns take shares of it, sized in pixels for the room
// the reply gives a card, so a column keeps its longest word whole whatever the unit.
// `control`, the Copy button, ends the header row, in a slot of its own after the last header.
export function tableCard(look: Look, table: Table, columns: number, control?: ReturnType<Ui['Button']>) {
  const { Box, Markdown, Text } = look.ui
  const { palette } = look.skin
  const reserve = control === undefined ? 0 : CONTROL_SLOT
  const shares = sharesOf(fitColumns(columnWidthsOf(table, false, reserve), cardWidth(columns), columnWidthsOf(table, true, reserve)))
  const cellBox = (i: number, padY: number) => ({ width: `${shares[i] ?? 0}%`, paddingX: PAD_X, paddingY: padY })
  const last = table.header.length - 1
  const head = (cell: string, i: number) => {
    const label = (
      <Text color={palette.muted} bold>
        {headOf(cell)}
      </Text>
    )
    const justify = JUSTIFY[table.align[i] ?? 'left']

    return control !== undefined && i === last ? (
      <Box {...cellBox(i, HEAD_PAD_Y)} flexDirection="row" alignItems="center" columnGap={1}>
        <Box flexGrow={1} justifyContent={justify}>
          {label}
        </Box>
        <Box flexShrink={0}>{control}</Box>
      </Box>
    ) : (
      <Box {...cellBox(i, HEAD_PAD_Y)} justifyContent={justify}>
        {label}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" marginY={1} width="100%" borderStyle="round" borderColor={palette.muted} padding={INSET} overflow="hidden">
      <Box flexDirection="row" alignItems="center" backgroundColor={palette.surface}>
        {table.header.map(head)}
      </Box>
      {table.rows.map((cells, r) => (
        <Box flexDirection="row" {...(r % 2 === 1 ? { backgroundColor: palette.zebra } : {})}>
          {table.header.map((_, i) => (
            <Box {...cellBox(i, PAD_Y)} justifyContent={JUSTIFY[table.align[i] ?? 'left']}>
              <Markdown text={cells[i] ?? ''} />
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  )
}
