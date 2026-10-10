import type { ElementTable, RenderSurface } from 'claude-code'

import type { Prefs, TurnStats } from '../types'
import { formatDuration, formatMs } from './format'
import { columnWidths, cutCell, LINK, widthOf } from './markdown'
import type { Segment, Table } from './markdown'
import type { Icons, Kind, Skin } from './skin'
import { spinnerIcon, toolIcon } from './icons'
import type { SpinnerMode } from './icons'
import type { LoopProps } from './anim'
import { codeSvg } from './svg-code'
import { diffSvg, patchText } from './svg-diff'
import type { DiffInput } from './svg-diff'
import { PX_PER_COLUMN, cardWidth, held, isLooping } from './svg-kit'
import { tableSvg } from './svg-table'
import { terminalSvg } from './svg-terminal'
import type { ShellOutput } from './svg-terminal'
import { BAND_H, COMPACT_NUDGE, COMPACT_SHOW, partCells, usageLine, usageSvg } from './svg-usage'
import type { Meter, Part } from './svg-usage'
import { kindOf, toolLabel } from './tools'

export type Ui = Pick<ElementTable, 'Box' | 'Text' | 'Markdown' | 'Button' | 'Link'>

// An experiment to try live: true draws the looping images (the band's rings, tool icons and
// spinners) in the desktop's sandboxed frame instead of as an image. Off, they stay images.
const LOOPS_INTERACTIVE = false
const LOOP_PROPS = LOOPS_INTERACTIVE ? { isInteractive: true } : {}

// The vector element, on the surfaces that have one (the desktop app).
export type SvgElement = ElementTable<'desktop'>['Svg']

// A region one of the mod's surface modules draws, on the desktop.
export type ClientElement = ElementTable<'desktop'>['Client']

export type Look = {
  ui: Ui
  skin: Skin
  icons: Icons
  prefs: Prefs
  surface: RenderSurface
  // The vector element where the surface draws one: icons replace glyphs there.
  svg?: SvgElement
  // Where the surface keeps a module's region across redraws (the desktop): loops draw there.
  client?: ClientElement
  // Puts text on the clipboard of the surface drawing; absent where nothing can copy.
  copy?: (text: string) => void
}

export type Call = {
  tool: string
  input: unknown
  isRunning: boolean
  isErrored: boolean
  isInterrupted: boolean
}

// What a tool row shows at its right edge.
export type Meta = { ms?: number; added?: number; removed?: number }

const KIND_LABEL: Readonly<Record<Kind, string>> = {
  read: 'Read',
  write: 'Edit',
  run: 'Run',
  search: 'Search',
  web: 'Web',
  mcp: 'MCP',
  other: 'Other',
}

const CELL_PAD = 1

// The worst thing that happened to any of the calls, else how far along they are.
function status({ skin, icons }: Look, calls: readonly Call[]) {
  if (calls.some(call => call.isInterrupted)) {
    return { glyph: icons.interrupted, color: skin.palette.warn, word: 'interrupted', mark: 'interrupted' as const }
  }

  if (calls.some(call => call.isErrored)) {
    return { glyph: icons.err, color: skin.palette.err, word: 'failed', mark: 'failed' as const }
  }

  if (calls.some(call => call.isRunning)) {
    return { glyph: icons.running, color: skin.palette.muted, word: 'running' }
  }

  return { glyph: icons.ok, color: skin.palette.ok, word: 'done' }
}

// The connector above a node, which ties a turn's calls into one line down the left.
function railLine(look: Look) {
  const { Text } = look.ui

  return <Text color={look.skin.palette.user}>{look.icons.rail}</Text>
}

function node(look: Look, calls: readonly Call[]) {
  const { Text } = look.ui
  const { glyph, color } = status(look, calls)
  const branch = look.prefs.rail && look.surface === 'terminal' ? look.icons.branch : ''

  return (
    <Text color={color}>
      {`${glyph}`}
      <Text color={look.skin.palette.muted}>{`${branch} `}</Text>
    </Text>
  )
}

function metaSpans(look: Look, meta: Meta) {
  const { Text } = look.ui
  const { palette } = look.skin
  const spans = []

  if (meta.added !== undefined && meta.removed !== undefined && meta.added + meta.removed > 0) {
    spans.push(<Text color={palette.ok}>{`+${meta.added}`}</Text>)
    spans.push(<Text color={palette.err}>{` −${meta.removed}`}</Text>)
  }

  if (meta.ms !== undefined) {
    spans.push(<Text color={palette.muted}>{`${spans.length > 0 ? '  ' : ''}${formatMs(meta.ms)}`}</Text>)
  }

  return spans
}

// A line with its facts flush right on the terminal and trailing it on the desktop,
// which lays a row out its own way.
function withMeta(look: Look, main: ReturnType<Ui['Text']>, meta: Meta) {
  const { Box, Text } = look.ui
  const spans = metaSpans(look, meta)

  if (spans.length === 0) {
    return main
  }

  if (look.surface !== 'terminal') {
    return (
      <Text wrap="truncate-end">
        {main}
        {'   '}
        {spans}
      </Text>
    )
  }

  return (
    <Box flexDirection="row">
      <Box flexGrow={1} flexShrink={1}>
        {main}
      </Box>
      <Box flexShrink={0} paddingLeft={2}>
        <Text>{spans}</Text>
      </Box>
    </Box>
  )
}

function stack(look: Look, line: ReturnType<Ui['Text']>) {
  const { Box } = look.ui

  // Box-drawing rails need a monospace font, which only the terminal draws mod text in.
  return look.prefs.rail && look.surface === 'terminal' ? (
    <Box flexDirection="column">
      {railLine(look)}
      {line}
    </Box>
  ) : (
    line
  )
}

// An image that may loop. `key` is the Client it moves in, under the animation budget; with
// none it is drawn held. The desktop builds an Svg again on every redraw, which starts its
// loop over, so there a loop is drawn by a Client (anim.tsx), which the desktop keeps across
// redraws while its props stay the same; with no size of its own, its region is the image's.
// An image only moves on the main thread: the desktop rasterises an SVG image's frames there,
// so every loop on screen costs it.
function loopImage(look: Look, Svg: SvgElement, source: string, image: { alt: string; width: number; height: number }, key?: string) {
  const isLoop = isLooping(source) && key !== undefined
  const drawn = { source: isLoop || !isLooping(source) ? source : held(source), ...image, ...LOOP_PROPS }
  const Client = look.client

  return isLoop && Client !== undefined ? <Client key={key} module="./anim.tsx" props={drawn satisfies LoopProps} /> : <Svg {...drawn} />
}

// On a surface with vector icons, the icon leads the row in place of the status glyph.
// Its shape names the kind; a failed or interrupted call adds a mark, and the alt says it.
function iconRow(look: Look, Svg: SvgElement, kind: Kind, calls: readonly Call[], line: ReturnType<Ui['Text']>, loop?: string) {
  const { Box } = look.ui
  const { color, word, mark } = status(look, calls)
  const source = toolIcon(kind, color, calls.some(call => call.isRunning), mark)

  return (
    <Box flexDirection="row" columnGap={1} alignItems="center">
      {loopImage(look, Svg, source, { alt: `${KIND_LABEL[kind]}, ${word}`, width: 16, height: 16 }, loop)}
      {line}
    </Box>
  )
}

// `loop` is the Client key a running icon moves under; without one it is held.
export function toolRow(look: Look, call: Call, kind: Kind, target: string, meta: Meta, loop?: string) {
  const { Text } = look.ui
  const { palette } = look.skin

  if (look.svg !== undefined) {
    const line = (
      <Text wrap="truncate-end">
        <Text color={palette[kind]} bold>
          {toolLabel(call.tool)}
        </Text>
        <Text color={call.isErrored ? palette.err : palette.muted}>{`  ${target}`}</Text>
      </Text>
    )

    return iconRow(look, look.svg, kind, [call], withMeta(look, line, meta), loop)
  }

  const main = (
    <Text wrap="truncate-end">
      {node(look, [call])}
      <Text color={palette[kind]}>{toolLabel(call.tool)}</Text>
      <Text color={call.isErrored ? palette.err : palette.muted}>{`  ${target}`}</Text>
    </Text>
  )

  return stack(look, withMeta(look, main, meta))
}

// A run of reads and searches on one node: `●─ Read 3 · Search 2`.
export function groupRow(look: Look, calls: readonly Call[], loop?: string) {
  const { Text } = look.ui
  const { palette } = look.skin
  const counts = new Map<Kind, number>()

  for (const call of calls) {
    const kind = kindOf(call.tool) ?? 'other'
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }

  const parts = [...counts].flatMap(([kind, count], i) => [
    ...(i === 0 ? [] : [<Text color={palette.muted}>{' · '}</Text>]),
    <Text color={palette[kind]}>{KIND_LABEL[kind]}</Text>,
    <Text color={palette.muted}>{` ${count}`}</Text>,
  ])

  if (look.svg !== undefined) {
    const lead = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'other'

    return iconRow(look, look.svg, lead, calls, <Text wrap="truncate-end">{parts}</Text>, loop)
  }

  return stack(
    look,
    <Text wrap="truncate-end">
      {node(look, calls)}
      {parts}
    </Text>,
  )
}

// The desktop's spinner row: an animated icon for what the turn is doing, beside the
// step the desktop names (`Creating notes.md`).
export function desktopSpinnerRow(look: Look, Svg: SvgElement, mode: SpinnerMode, text: string, loop?: string) {
  const { Box, Text } = look.ui

  return (
    <Box flexDirection="row" columnGap={1} alignItems="center">
      {loopImage(look, Svg, spinnerIcon(mode, look.skin.palette.user), { alt: mode, width: 20, height: 20 }, loop)}
      <Text color={look.skin.palette.muted}>{text}</Text>
    </Box>
  )
}

// Your message in a rounded outline sized to what you typed, so it stands apart from
// replies without taking the full width. Images it carried follow below it, drawn by
// Claude Code.
export function promptRow(look: Look, text: string, images?: ReturnType<Ui['Text']>) {
  const { Box, Text } = look.ui

  return (
    <Box flexDirection="column" alignItems="flex-start" marginY={1}>
      <Box borderStyle="round" borderColor={look.skin.palette.muted} paddingX={1} flexShrink={1}>
        <Text color={look.skin.palette.fg}>{text}</Text>
      </Box>
      {images ?? ''}
    </Box>
  )
}

const JUSTIFY = { left: 'flex-start', right: 'flex-end', center: 'center' } as const

// The share of the reported width a table may take at its natural size. Past it, the
// table spans its container and splits it between columns in proportion: the desktop
// app reports the window's width, wider than the transcript column a reply sits in.
const NATURAL_SHARE = 0.55

// A grid of cells, so columns line up in the terminal's monospace and in the desktop
// app's proportional font alike. `control`, such as a Copy button, sits on the frame's
// top border at the right, as ╭──── Copy ─╮.
export function tableRows(look: Look, table: Table, maxWidth: number, control?: ReturnType<Ui['Button']>) {
  const { Box, Text } = look.ui
  const { palette } = look.skin
  const widths = columnWidths(table, maxWidth - 4, CELL_PAD * 2)
  const natural = widths.reduce((sum, width) => sum + width + CELL_PAD * 2, 2)
  const isFluid = natural > maxWidth * NATURAL_SHARE
  const size = (i: number) =>
    isFluid
      ? { width: 0, flexGrow: Math.max(1, widths[i] ?? 1), flexShrink: 1 }
      : { width: (widths[i] ?? 0) + CELL_PAD * 2, flexShrink: 0 }
  const row = (cells: readonly string[], isHeader: boolean, band: string | undefined) => (
    <Box flexDirection="row" {...(band === undefined ? {} : { backgroundColor: band })}>
      {cells.map((cell, i) => (
        <Box {...size(i)} paddingX={CELL_PAD} justifyContent={JUSTIFY[table.align[i] ?? 'left']}>
          <Text color={palette.fg} bold={isHeader} wrap="truncate-end">
            {cutCell(cell, widths[i] ?? 0)}
          </Text>
        </Box>
      ))}
    </Box>
  )

  return (
    <Box
      flexDirection="column"
      marginY={1}
      borderStyle="round"
      borderColor={palette.muted}
      {...(isFluid ? { width: '100%' } : { alignSelf: 'flex-start' as const })}
    >
      {row(table.header, true, palette.surface)}
      {table.rows.map((cells, i) => row(cells, false, i % 2 === 1 ? palette.zebra : undefined))}
      {control === undefined ? (
        ''
      ) : (
        <Box position="absolute" top={-1} right={1}>
          {control}
        </Box>
      )}
    </Box>
  )
}

// A card's Copy button laid over its top-right corner, level with its header, in the
// slot the card leaves free there; nothing where nothing can copy. The image cannot be
// pressed, so the button is a real one on top of it.
function copyOverlay(look: Look, key: string, text: string) {
  const { Box } = look.ui
  const button = copyButton(look, key, text)

  return button === undefined ? (
    ''
  ) : (
    <Box position="absolute" top={1} right={3}>
      {button}
    </Box>
  )
}

// A card drawn as an image with its Copy button over it; the box hugs the image so the
// corner is the card's, not the column's.
function cardWithCopy(look: Look, Svg: SvgElement, built: { source: string; alt: string; width: number; height: number }, key: string, text: string) {
  const { Box } = look.ui

  return (
    <Box marginY={1} alignSelf="flex-start">
      <Svg source={built.source} alt={built.alt} width={built.width} height={built.height} />
      {copyOverlay(look, key, text)}
    </Box>
  )
}

// A table card, its Copy button over the header row's right end and its links under it:
// the image cannot be pressed, so its links are pressed here.
function tableCard(look: Look, table: Table, Svg: SvgElement, columns: number, key: string, fresh?: number) {
  const { Box, Link } = look.ui
  const card = tableSvg(table, look.skin.palette, cardWidth(columns), fresh, look.copy !== undefined)
  const links = new Map(table.rows.flat().flatMap(cell => [...cell.matchAll(LINK)].map(([, label = '', href = '']) => [href, label] as const)))

  return (
    <Box flexDirection="column" marginY={1} alignSelf="flex-start">
      <Box alignSelf="flex-start">
        <Svg source={card.source} alt={card.alt} width={card.width} height={card.height} />
        {copyOverlay(look, key, tableMarkdown(table))}
      </Box>
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {[...links].map(([href, label]) => (
          <Link href={href} label={label} />
        ))}
      </Box>
    </Box>
  )
}

// A table as markdown again, for the clipboard.
const tableMarkdown = (table: Table): string =>
  [table.header, table.header.map(() => '---'), ...table.rows].map(cells => `| ${cells.join(' | ')} |`).join('\n')

// A copy button, an icon; nothing where nothing can copy.
function copyButton(look: Look, key: string, text: string) {
  const { Button } = look.ui
  const copy = look.copy

  return copy === undefined ? undefined : <Button key={key} label={look.icons.copy} plain dimColor onPress={() => copy(text)} />
}

// A small copy icon button under a card or block, flush right; nothing where nothing can copy.
export function copyRow(look: Look, key: string, text: string) {
  const { Box, Button } = look.ui
  const copy = look.copy

  if (copy === undefined) {
    return ''
  }

  return (
    <Box flexDirection="row" justifyContent="flex-end">
      <Button key={key} label={look.icons.copy} plain dimColor onPress={() => copy(text)} />
    </Box>
  )
}

// `fresh` holds, per segment, the first table row new since the reply's last draw.
export function replyRows(look: Look, segments: readonly Segment[], maxWidth: number, Svg?: SvgElement, fresh: readonly (number | undefined)[] = []) {
  const { Box, Markdown } = look.ui

  return (
    <Box flexDirection="column">
      {segments.map((segment, i) => {
        if (segment.kind === 'text') {
          return <Markdown text={segment.text} />
        }

        if (segment.kind === 'code') {
          return Svg === undefined ? (
            <Box flexDirection="column">
              <Markdown text={segment.raw} />
              {copyRow(look, `copy-${i}`, segment.code)}
            </Box>
          ) : (
            codeCard(look, segment.lang, segment.code, Svg, maxWidth, `copy-${i}`)
          )
        }

        return Svg === undefined ? (
          tableRows(look, segment, maxWidth, copyButton(look, `copy-${i}`, tableMarkdown(segment)))
        ) : (
          tableCard(look, segment, Svg, maxWidth, `copy-${i}`, fresh[i])
        )
      })}
    </Box>
  )
}

// The word with a band of light sweeping through it, one letter a frame.
export function spinnerRow(look: Look, word: string, frame: number, elapsedMs: number) {
  const { Text } = look.ui
  const { palette } = look.skin
  const letters = [...word]
  const head = (frame % (letters.length + 8)) - 4
  const shade = (i: number): string => {
    const distance = Math.abs(i - head)

    return distance === 0 ? palette.fg : distance === 1 ? palette.user : palette.muted
  }
  const runs: { color: string; text: string }[] = []

  for (const [i, letter] of letters.entries()) {
    const color = shade(i)
    const last = runs.at(-1)

    if (last?.color === color) {
      last.text += letter
    } else {
      runs.push({ color, text: letter })
    }
  }

  return (
    <Text>
      <Text color={palette.user}>{`${look.icons.frames[frame % look.icons.frames.length] ?? ''} `}</Text>
      {runs.map(run => (
        <Text color={run.color}>{run.text}</Text>
      ))}
      <Text color={palette.muted}>{`…  ${formatDuration(elapsedMs)}`}</Text>
    </Text>
  )
}

export function footerRow(look: Look, word: string, durationMs: number, stats: TurnStats | undefined) {
  const { Text } = look.ui
  const { palette } = look.skin
  const facts = [
    ...(stats === undefined || stats.tools === 0 ? [] : [`${stats.tools} tool${stats.tools === 1 ? '' : 's'}`]),
  ]
  const hasDiff = stats !== undefined && stats.added + stats.removed > 0

  return (
    <Text color={palette.muted}>
      <Text color={palette.user}>{`${look.icons.done} `}</Text>
      {`${word} in ${formatDuration(durationMs)}`}
      {facts.length > 0 ? `  ·  ${facts.join('  ·  ')}` : ''}
      {hasDiff ? '  ·  ' : ''}
      {hasDiff ? <Text color={palette.ok}>{`+${stats.added}`}</Text> : ''}
      {hasDiff ? <Text color={palette.err}>{` −${stats.removed}`}</Text> : ''}
    </Text>
  )
}

// A band above Claude Code's own question dialog: the topics it asks about, in the skin.
export function askBand(look: Look, headers: readonly string[]) {
  const { Text } = look.ui
  const { palette } = look.skin

  return (
    <Text color={palette.muted}>
      <Text color={palette.user}>{`${look.icons.prompt} `}</Text>
      {headers.map((header, i) => (
        <Text color={i === 0 ? palette.fg : palette.muted} bold={i === 0}>
          {`${i === 0 ? '' : '  ·  '}${header}`}
        </Text>
      ))}
    </Text>
  )
}

export function codeCard(look: Look, lang: string, code: string, Svg: SvgElement, columns: number, key = 'copy-code') {
  return cardWithCopy(look, Svg, codeSvg(code, lang, look.skin.palette, cardWidth(columns), look.copy !== undefined), key, code)
}

// The card shows the first lines; Copy gives the whole patch.
export function diffCard(look: Look, Svg: SvgElement, input: DiffInput, shownPath: string, columns: number) {
  return cardWithCopy(look, Svg, diffSvg(input, shownPath, look.skin.palette, cardWidth(columns), look.copy !== undefined), 'copy-diff', patchText(input, shownPath))
}

export function terminalCard(look: Look, Svg: SvgElement, output: ShellOutput, isErrored: boolean, columns: number) {
  const text = [output.stdout, output.stderr].filter(part => part.trim() !== '').join('\n')
  const withCopy = text === '' ? { ...look, copy: undefined } : look

  return cardWithCopy(withCopy, Svg, terminalSvg(output, isErrored, look.skin.palette, cardWidth(columns), withCopy.copy !== undefined), 'copy-output', text)
}

// A letter, which presses only while the band holds the focus (ctrl+x tab), never from
// the prompt: Compact cannot be undone, so typing cannot set it off. The terminal shows it
// (`c: Compact`); the desktop's button is pressed with the pointer.
export const COMPACT_HOTKEY = 'c'

// What the band shows past the rings, by how many of its extras are kept: a narrow band
// drops the breakdown bar first, then the resets, then the tokens.
const EXTRAS = 3

function keptExtras(meters: readonly Meter[], parts: readonly Part[], kept: number): { meters: Meter[]; parts: readonly Part[] } {
  return {
    meters: meters.map(meter => (kept >= 2 || (kept === 1 && meter.label === 'context') ? meter : { label: meter.label, percent: meter.percent })),
    parts: kept === EXTRAS ? parts : [],
  }
}

// The meters with as many extras as fit `room` columns; with none, whatever their width.
// `ringLoops`: how many of the rings may move, the first that loop; the rest are held.
function meterView(look: Look, meters: readonly Meter[], parts: readonly Part[], room: number, starts: readonly number[], ringLoops: number) {
  const { Box, Text } = look.ui
  const { palette } = look.skin

  for (let kept = EXTRAS; kept >= 0; kept--) {
    const view = keptExtras(meters, parts, kept)

    if (look.svg !== undefined) {
      const Svg = look.svg
      const built = usageSvg(view.meters, palette, starts, view.parts)

      // Each ring an image of its own, so a ring under the budget moves in a Client of its own.
      if (kept === 0 || built.width <= room * PX_PER_COLUMN) {
        const moving = built.rings.flatMap(({ ring }, i) => (isLooping(ring.source) ? [i] : [])).slice(0, ringLoops)

        return (
          <Box flexDirection="row" alignItems="center">
            {built.rings.flatMap(({ ring, text }, i) => [
              loopImage(look, Svg, ring.source, { alt: ring.alt, width: ring.width, height: BAND_H }, moving.includes(i) ? `loop-${view.meters[i]?.label}` : undefined),
              <Svg source={text.source} alt={text.alt} width={text.width} height={BAND_H} />,
            ])}
            {built.bar === undefined ? '' : <Svg source={built.bar.source} alt={built.bar.alt} width={built.bar.width} height={BAND_H} />}
          </Box>
        )
      }

      continue
    }

    const line = usageLine(view.meters)
    const cells = partCells(view.parts)
    const items = [...line.map(meter => meter.bar + meter.text), ...(cells.length > 0 ? [cells.map(cell => cell.cells).join('')] : [])]
    const width = items.reduce((sum, item) => sum + widthOf(item), 3 * (items.length - 1))

    if (kept === 0 || width <= room) {
      return (
        <Box flexDirection="row" columnGap={3}>
          {line.map(meter => (
            <Text color={palette.muted}>
              <Text color={palette.user}>{meter.bar}</Text>
              {meter.text}
            </Text>
          ))}
          {cells.length > 0 ? (
            <Text>
              {cells.map(cell => (
                <Text color={palette[cell.slot]}>{cell.cells}</Text>
              ))}
            </Text>
          ) : (
            ''
          )}
        </Box>
      )
    }
  }
}

// The band above the prompt: the meters, and from COMPACT_SHOW a Compact button that becomes
// the main action, with a word on why, once the context is full enough to be worth it. Extras
// sit between the two and give way first, so the button never moves for them.
export function usageBand(
  look: Look,
  meters: readonly Meter[],
  canCompact: boolean,
  compact: () => void,
  starts: readonly number[] = [],
  parts: readonly Part[] = [],
  columns = Infinity,
  ringLoops = 0,
) {
  const { Box, Text, Button } = look.ui
  const { palette } = look.skin
  const context = meters.find(meter => meter.label === 'context')?.percent ?? 0
  const isNudge = context >= COMPACT_NUDGE
  const isOffered = canCompact && context >= COMPACT_SHOW
  const nudge = `Context is ${context}% full`
  const label = isNudge ? 'Compact now' : 'Compact'
  // The gap, and room for the Compact controls whenever the context is full enough for
  // them, even while a turn hides them, so the extras hold still across turns.
  const reserved = 2 + (context >= COMPACT_SHOW ? label.length + 6 + 2 : 0) + (isNudge ? nudge.length + 2 : 0)

  return (
    // bodyColumns already leave out the engine's collapse mark ([-]) at the right edge.
    <Box flexDirection="row" alignItems="center" columnGap={2}>
      {meterView(look, meters, parts, columns - reserved, starts, ringLoops)}
      <Box flexGrow={1} />
      {isOffered && isNudge ? (
        <Box flexShrink={0}>
          <Text color={palette.warn}>{nudge}</Text>
        </Box>
      ) : (
        ''
      )}
      {isOffered ? (
        <Box flexShrink={0}>
          <Button
            key="compact"
            label={label}
            {...(look.surface === 'terminal' ? { hotkey: COMPACT_HOTKEY } : {})}
            plain
            {...(isNudge ? { variant: 'primary' as const } : { dimColor: true })}
            onPress={compact}
          />
        </Box>
      ) : (
        ''
      )}
    </Box>
  )
}
