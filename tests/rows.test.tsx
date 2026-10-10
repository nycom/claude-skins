import type { On, RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { widthOf } from '../hooks/markdown'
import { CONTROL_SLOT, measure, PX_PER_COLUMN } from '../hooks/svg-kit'
import { codeSvg } from '../hooks/svg-code'
import { HEAD_PAD_Y, INSET, PAD_X, PAD_Y } from '../hooks/table-card'
import noir from '../hooks/themes/noir'
import tokyoNight from '../hooks/themes/tokyo-night'

const SURFACES = ['terminal', 'desktop'] as const

const SITE = { plugin: 'skins', viewport: { columns: 100, rows: 30 } } as const

// Stands for what Claude Code would draw wherever the skin hands a row back.
const STOCK: RenderElement = { type: 'Text', props: {}, children: ['stock row'] }

const PANE = {
  ...SITE,
  component: 'Pane',
  requestId: 'skins-settings',
  props: {
    title: 'Skins',
    isFocused: true,
    bodyColumns: 80,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const call = (tool: string, input: unknown, state: object = {}) => ({
  tool_use_id: 'tu1',
  tool,
  input,
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
  ...state,
})

type Found = { props: Record<string, unknown>; children?: readonly unknown[] } | undefined

// `find` matches text anywhere in a row, so a span's colour is read from its children.
function spanColor(row: Found, text: string): unknown {
  for (const child of row?.children ?? []) {
    const element = child as { props?: { color?: unknown }; children?: readonly unknown[] }

    if (element.children?.[0] === text) {
      return element.props?.color
    }

    const inner = spanColor(element as Found, text)

    if (inner !== undefined) {
      return inner
    }
  }

  return undefined
}

const runSkin = ($: Engine, args: string) =>
  $.command.run({
    command: 'skin',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })

// The engine's own answers, so a hook can mount without a session. A test answering
// the environment or the store itself leaves them out.
function stubEngine(on: On, own: { env?: boolean; store?: boolean; usage?: boolean } = {}) {
  const clock = mock.clock(on, { now: 10_000 })
  on('session.cwd', () => ({ value: '/work' }))
  if (!own.env) {
    on('env.get', () => ({ value: undefined }))
  }
  if (!own.store) {
    on('store.get', () => ({ value: undefined }))
    on('store.set', () => ({ value: undefined }))
  }
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  if (!own.usage) {
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: 42 }, rateLimits: [{ kind: 'five_hour', percentUsed: 18 }] } }))
  }
  // The dialog must hold Claude Code's own drawing, which a real engine hands back by reference.
  on('ui.render', ($, e) => (e.component === 'AskUserQuestion' ? { type: 'engine', ref: 0 } : STOCK))

  return clock
}

const toolUse = (props: ReturnType<typeof call>, surface: (typeof SURFACES)[number] = 'terminal') =>
  ({ ...SITE, surface, component: 'ToolUse', requestId: props.tool_use_id, props }) as const

test('a Bash call is a node on the terminal\u2019s rail and an icon row on the desktop', async ($, on) => {
  stubEngine(on)

  const terminal = await $.ui.mount(toolUse(call('Bash', { command: 'pnpm test' }), 'terminal'))
  expect(await terminal.find({ type: 'Text', text: '┃' })).toBeDefined()
  expect(await terminal.find({ type: 'Text', text: /●─ Bash {2}pnpm test/ })).toBeDefined()
  await terminal.unmount()

  const desktop = await $.ui.mount(toolUse(call('Bash', { command: 'pnpm test' }), 'desktop'))
  const icon = (await desktop.find({ type: 'Svg' })) as { props: { source: string } } | undefined
  expect(icon?.props.source).toContain('M5 7l5 5-5 5')
  expect(await desktop.find({ type: 'Text', text: /Bash {2}pnpm test/ })).toBeDefined()
  expect(await desktop.find({ type: 'Text', text: '┃' })).toBeUndefined()
  await desktop.unmount()

  const running = await $.ui.mount(toolUse(call('Bash', { command: 'sleep 9' }, { tool_use_id: 'tu3', isRunning: true }), 'desktop'))
  expect((await clientsOf(running))[0]?.props.props?.source).toContain('class="spin"')
  await running.unmount()

  // A failed call says so by a mark on the icon and in its alt, not by colour alone.
  const failed = await $.ui.mount(toolUse(call('Bash', { command: 'false' }, { tool_use_id: 'tu4', isErrored: true }), 'desktop'))
  const crossed = (await failed.find({ type: 'Svg' })) as { props: { source: string; alt: string } } | undefined
  expect(crossed?.props.source).toContain('M16.5 16.5l5 5')
  expect(crossed?.props.alt).toBe('Run, failed')
})

test('an edit shows its added and removed lines', async ($, on) => {
  stubEngine(on)

  const output = { structuredPatch: [{ lines: ['+a', '+b', '-c'] }] }
  const ui = await $.ui.mount(toolUse(call('Edit', { file_path: '/work/a.ts' }, { output })))

  expect(await ui.find({ type: 'Text', text: '+2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' −1' })).toBeDefined()
})

test('a failed call shows the error mark, a running one the running mark', async ($, on) => {
  stubEngine(on)

  const failed = await $.ui.mount(toolUse(call('Read', { file_path: '/work/a.ts' }, { isErrored: true })))
  expect(await failed.find({ type: 'Text', text: /✕─ Read/ })).toBeDefined()

  const running = await $.ui.mount(toolUse(call('Bash', { command: 'sleep 9' }, { tool_use_id: 'tu2', isRunning: true })))
  expect(await running.find({ type: 'Text', text: /○─ Bash/ })).toBeDefined()
})

test('tools a skin cannot redraw faithfully keep their own row', async ($, on) => {
  stubEngine(on)

  const ui = await $.ui.mount(toolUse(call('Task', { description: 'dig' })))

  expect(await ui.find({ type: 'Text', text: 'stock row' })).toBeDefined()
})

test('a folded group is one node, an expanded one keeps its rows', async ($, on) => {
  stubEngine(on)

  const calls = [call('Read', {}), call('Read', {}), call('Grep', { pattern: 'x' })]
  const group = (isExpanded: boolean) =>
    ({ ...SITE, surface: 'terminal', component: 'ToolGroup', requestId: 'g1', props: { calls, isActive: false, isExpanded } }) as const

  const folded = await $.ui.mount(group(false))
  expect(await folded.find({ type: 'Text', text: /Read 2 · Search 1/ })).toBeDefined()
  await folded.unmount()

  const expanded = await $.ui.mount(group(true))
  expect(await expanded.find({ type: 'Text', text: 'stock row' })).toBeDefined()
})

test('a typed prompt sits in an outline sized to its text, other senders keep their row', async ($, on) => {
  stubEngine(on)

  for (const surface of SURFACES) {
    const prompt = (kind: 'composer' | 'task-notification') =>
      ({ ...SITE, surface, component: 'UserMessage', requestId: 'm1', props: { text: 'fix the build', origin: { kind }, isExpanded: false } }) as const

    const typed = await $.ui.mount(prompt('composer'))
    const column = (await typed.find({ type: 'Box' })) as { props: { alignItems?: string }; children?: readonly { props?: { borderStyle?: string } }[] } | undefined
    // The outline hugs the text: its column does not stretch it to the full width.
    expect(column?.props.alignItems).toBe('flex-start')
    expect(column?.children?.[0]?.props?.borderStyle).toBe('round')
    expect(await typed.find({ type: 'Text', text: 'fix the build' })).toBeDefined()
    await typed.unmount()

    const notice = await $.ui.mount(prompt('task-notification'))
    expect(await notice.find({ type: 'Text', text: 'stock row' })).toBeDefined()
    await notice.unmount()
  }
})

test('a reply with a table draws the table, a reply without one keeps its own drawing', async ($, on) => {
  stubEngine(on)

  const reply = (text: string) =>
    ({ ...SITE, surface: 'terminal', component: 'AssistantMessage', requestId: 'r1', props: { text, isFirstOfReply: true } }) as const

  const withTable = await $.ui.mount(reply('Limits:\n\n| Route | Limit |\n|---|--:|\n| /chat | 60 |\n| /up | 10 |'))
  expect(await withTable.find({ type: 'Markdown' })).toBeDefined()
  expect(await withTable.find({ type: 'Text', text: 'Route' })).toBeDefined()
  expect(await withTable.find({ type: 'Text', text: '10' })).toBeDefined()
  await withTable.unmount()

  const plain = await $.ui.mount(reply('No table | here, just a pipe.'))
  expect(await plain.find({ type: 'Text', text: 'stock row' })).toBeDefined()
})

test('a terminal table sizes Korean, Chinese, Japanese and emoji cells to their full width', async ($, on) => {
  stubEngine(on)

  const cells = ['레일, 스피너', '中文字符', 'カタカナ', '🚀 ship']
  const text = `| Slot | Use |\n|---|---|\n${cells.map((cell, i) => `| s${i} | ${cell} |`).join('\n')}`
  const ui = await $.ui.mount({ ...SITE, surface: 'terminal', component: 'AssistantMessage', requestId: 'cjk', props: { text, isFirstOfReply: true } })

  type Node = { type?: string; props?: { width?: unknown }; children?: readonly (Node | string)[] }
  // The box a cell's Text sits in, found by the cell's text.
  const boxOf = (node: Node | string | undefined, cell: string): Node | undefined => {
    if (node === undefined || typeof node === 'string') {
      return undefined
    }
    const holds = node.children?.some(child => typeof child !== 'string' && child.type === 'Text' && child.children?.join('') === cell)
    return holds ? node : node.children?.map(child => boxOf(child, cell)).find(found => found !== undefined)
  }
  const root = (await ui.find({ type: 'Box' })) as Node

  for (const cell of cells) {
    expect(await ui.find({ type: 'Text', text: cell })).toBeDefined()
    // Each cell's box holds its terminal width plus padding, so nothing is cut with an ellipsis.
    expect(boxOf(root, cell)?.props?.width).toBe(widthOf('레일, 스피너') + 2)
  }

  expect(await ui.find({ type: 'Text', text: /…$/ })).toBeUndefined()
  await ui.unmount()
})

test('the terminal spinner shimmers, the desktop one is an animated icon beside its step', async ($, on) => {
  stubEngine(on)

  const spinner = (surface: (typeof SURFACES)[number]) =>
    ({ ...SITE, surface, component: 'Spinner', requestId: 'main', props: { word: 'Sauteing', message: null, suffix: '…', mode: 'responding' } }) as const

  const terminal = await $.ui.mount(spinner('terminal'))
  expect(await terminal.find({ type: 'Text', text: /^⠋ .+…/ })).toBeDefined()
  await terminal.unmount()

  const desktop = await $.ui.mount(spinner('desktop'))
  expect((await svgOf(desktop)).source).toContain('class="bar')
  expect(await desktop.find({ type: 'Text', text: 'Sauteing' })).toBeDefined()
})

test('the turn footer names the time in the skin’s words', async ($, on) => {
  stubEngine(on)

  const ui = await $.ui.mount({
    ...SITE,
    surface: 'terminal',
    component: 'TurnDuration',
    requestId: 'f1',
    props: { word: 'Baked', durationMs: 64000 },
  })

  expect(await ui.find({ type: 'Text', text: /^◆ .+ in 1m 4s$/ })).toBeDefined()
})

test('the question dialog keeps Claude Code’s drawing under a band naming its topics', async ($, on) => {
  stubEngine(on)

  const ui = await $.ui.mount({
    ...SITE,
    surface: 'terminal',
    component: 'AskUserQuestion',
    requestId: 'q1',
    props: { tool: 'AskUserQuestion', questions: [{ header: 'Approach' }, { header: 'Store' }] },
  })

  expect(await ui.find({ type: 'Text', text: /Approach {2}· {2}Store/ })).toBeDefined()
})

test('the settings pane picks a skin, switches the rail and paints a slot', async ($, on) => {
  stubEngine(on)

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'skin-dracula' })
  await pane.press({ key: 'toggle-rail' })
  await pane.unmount()

  const row = await $.ui.mount(toolUse(call('Bash', { command: 'ls' })))
  const found = await row.find({ type: 'Text', text: /Bash/ })
  expect(spanColor(found, 'Bash')).toBe('#f1fa8c')
  expect(await row.find({ type: 'Text', text: '┃' })).toBeUndefined()
  await row.unmount()

  const again = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await again.input({ key: 'hex', text: '#ff0000' })
  await again.unmount()

  expect((await runSkin($, 'list')).text).toContain('● my-dracula')
})

test('the agent’s design tool saves a skin and it applies at once', async ($, on) => {
  stubEngine(on)

  const out = await $.tool.call({
    tool: 'mcp__skins__design',
    action: 'save',
    name: 'sunset',
    base: 'gruvbox',
    palette: { run: '#ff8800' },
  })
  expect(out.deny).toBeUndefined()

  const row = await $.ui.mount(toolUse(call('Bash', { command: 'ls' })))
  expect(spanColor(await row.find({ type: 'Text', text: /Bash/ }), 'Bash')).toBe('#ff8800')

  const refused = await $.tool.call({ tool: 'mcp__skins__design', action: 'save', name: 'dracula' })
  expect(refused.deny).toContain('built-in')
})

test('/skin with no argument opens the settings pane', async ($, on) => {
  stubEngine(on)

  const answer = await runSkin($, '')

  expect(answer.text).toBeUndefined()
})

test('a table wider than its share spans the column instead of running off it', async ($, on) => {
  stubEngine(on)

  const wide = `| File | What changed |\n|---|---|\n| server.ts | ${'a long description '.repeat(6)} |`

  for (const surface of ['terminal'] as const) {
    const ui = await $.ui.mount({
      ...SITE,
      surface,
      component: 'AssistantMessage',
      requestId: 'r2',
      props: { text: wide, isFirstOfReply: true },
    })
    type Node = { props?: { width?: unknown; position?: unknown; top?: unknown }; children?: readonly Node[] }
    const reply = (await ui.find({ type: 'Box' })) as Node
    const frame = reply.children?.[0]
    // Copy sits on the frame's top border, laid over it at the right.
    const control = frame?.children?.at(-1)

    expect(frame?.props?.width).toBe('100%')
    expect(control?.props?.position).toBe('absolute')
    expect(control?.props?.top).toBe(-1)
    expect(await ui.find({ type: 'Text', text: /…$/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the desktop draws a table as a grid of markdown cells in the skin, not an image', async ($, on) => {
  stubEngine(on)
  const { palette } = noir
  const text = '| Skin | Note |\n|---|--:|\n| dracula | uses `#bd93f9` and **bold** |\n| x<y | ok |\n| z | 3 |'
  const ui = await $.ui.mount(desktopReply('grid-tb', text))
  type Node = { type?: string; props?: Record<string, unknown>; children?: readonly Node[] }
  const card = ((await ui.find({ type: 'Box' })) as Node).children?.[0]
  const [header, ...rows] = (card?.children ?? []).filter(child => child.type === 'Box' && child.props?.position !== 'absolute')

  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  expect(card?.props).toMatchObject({ borderStyle: 'round', borderColor: palette.muted, width: '100%' })
  // The header's own band, then zebra rows from the skin's palette.
  expect(header?.props?.backgroundColor).toBe(palette.surface)
  expect(rows.map(row => row.props?.backgroundColor)).toEqual([undefined, palette.zebra, undefined])
  const heads = (await ui.findAll({ type: 'Text' })).filter(found => found.props.bold === true)
  expect(heads.map(found => [found.text, found.props.color])).toEqual([['SKIN', palette.muted], ['NOTE', palette.muted]])
  // Every body cell is the surface's own markdown, inline code and bold as written.
  expect((await ui.findAll({ type: 'Markdown' })).map(found => found.props.text)).toEqual(['dracula', 'uses `#bd93f9` and **bold**', 'x<y', 'ok', 'z', '3'])
  // A right-aligned column keeps its alignment.
  expect(rows[0]?.children?.[1]?.props?.justifyContent).toBe('flex-end')
  // Every cell breathes: the header at least as tall a pad as the body, the same pad across.
  expect(PAD_Y).toBeGreaterThan(0)
  expect(HEAD_PAD_Y).toBeGreaterThanOrEqual(PAD_Y)
  for (const cell of header?.children ?? []) expect(cell.props).toMatchObject({ paddingX: PAD_X, paddingY: HEAD_PAD_Y })
  for (const cell of rows.flatMap(row => row.children ?? [])) expect(cell.props).toMatchObject({ paddingX: PAD_X, paddingY: PAD_Y })
  // The bands sit the same distance from the border on every side, its corners clipping them.
  expect(card?.props).toMatchObject({ padding: INSET, overflow: 'hidden' })
  for (const side of ['paddingX', 'paddingY', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight']) expect(card?.props?.[side]).toBeUndefined()
  await ui.unmount()
})

test('on the desktop an edit is a diff card and a shell command a terminal card', async ($, on) => {
  stubEngine(on)

  const result = (tool: string, output: unknown, isErrored = false) =>
    ({ ...SITE, surface: 'desktop', component: 'ToolResult', requestId: 'tr1', props: { tool_use_id: 'tr1', tool, output, isErrored } }) as const
  const sourceOf = async (ui: { find: (q: { type: string }) => Promise<unknown> }) =>
    ((await ui.find({ type: 'Svg' })) as { props: { source: string } } | undefined)?.props.source ?? ''

  const edit = await $.ui.mount(result('Edit', { filePath: '/work/src/a.ts', structuredPatch: [{ oldStart: 1, newStart: 1, lines: ['-a', '+b'] }] }))
  expect(await sourceOf(edit)).toContain('src/a.ts')
  await edit.unmount()

  const shell = await $.ui.mount(result('Bash', { stdout: 'built', stderr: '', interrupted: false }))
  expect(await sourceOf(shell)).toContain('built')
  await shell.unmount()

  const terminal = await $.ui.mount({ ...result('Bash', { stdout: 'built', stderr: '', interrupted: false }), surface: 'terminal' })
  expect(await terminal.find({ type: 'Text', text: 'stock row' })).toBeDefined()
})

test('a code fence is a card on the desktop and stays markdown in the terminal', async ($, on) => {
  stubEngine(on)

  const reply = (surface: (typeof SURFACES)[number]) =>
    ({ ...SITE, surface, component: 'AssistantMessage', requestId: 'c1', props: { text: 'Run:\n\n```ts\nconst a = 1\n```', isFirstOfReply: true } }) as const

  const desktop = await $.ui.mount(reply('desktop'))
  expect(((await desktop.find({ type: 'Svg' })) as { props: { source: string } } | undefined)?.props.source).toContain('const')
  await desktop.unmount()

  const terminal = await $.ui.mount(reply('terminal'))
  expect(await terminal.find({ type: 'Svg' })).toBeUndefined()
  expect(await terminal.find({ type: 'Markdown' })).toBeDefined()
})

const BAND = (surface: (typeof SURFACES)[number], isWorking: boolean, bodyColumns = 100) =>
  ({
    ...SITE,
    surface,
    component: 'AbovePrompt',
    requestId: 'band',
    props: { hasSurvey: false, isWorking, maxRows: 4, bodyColumns, scroll: { offset: 0, bodyRows: 4 }, view: {} },
  }) as const

test('the band offers Compact, nudges at 70% context, and compacts on a press', async ($, on) => {
  let compacted = 0
  const toasts: string[] = []
  const clock = mock.clock(on, { now: 10_000 })
  on('session.cwd', () => ({ value: '/work' }))
  on('store.get', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', () => STOCK)
  on('command.run', ($, e) => {
    if (e.command === 'compact') {
      compacted += 1
    }

    return {}
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: 85 }, rateLimits: [] } }))
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: { command: 'skin' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__skins__design' } }))

  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })

  const band = await $.ui.mount(BAND('desktop', false))
  expect(await band.find({ type: 'Text', text: 'Context is 85% full' })).toBeDefined()
  // No hotkey on the desktop: a keystroke in the prompt must never start a compaction.
  expect(((await band.find({ key: 'compact' })) as { props: { hotkey?: string } } | undefined)?.props.hotkey).toBeUndefined()
  await band.press({ key: 'compact' })
  // It starts on a timer, outside the press, so the press ending cannot cancel it.
  expect(compacted).toBe(0)
  // Hidden until that run ends, so more presses cannot queue more runs.
  expect(await band.find({ key: 'compact' })).toBeUndefined()
  await clock.advance(1)
  expect(compacted).toBe(1)
  expect(await band.find({ key: 'compact' })).toBeDefined()
  expect(toasts).toEqual([])
  await band.unmount()

  const busy = await $.ui.mount(BAND('terminal', true))
  expect(await busy.find({ key: 'compact' })).toBeUndefined()
  await busy.unmount()

  // The terminal's is a letter, which presses only while the band holds the focus.
  const idle = await $.ui.mount(BAND('terminal', false))
  expect(((await idle.find({ key: 'compact' })) as { props: { hotkey?: string } } | undefined)?.props.hotkey).toBe('c')
})

test('the band sits last, nearest the prompt, below another mod’s row, and keeps that slot as the row comes and goes', async ($, on) => {
  let isShown = true
  // Registered first, so it is what the skin's hook reaches when it hands the band on.
  on('ui.render', { component: 'AbovePrompt' }, () => (isShown ? { type: 'Text', props: {}, children: ['PROGRESS'] } : { type: 'engine', ref: 0 }))
  // The other mod's row comes and goes while the band stays mounted, as it does live. A test's
  // hooks may not write state, so a pref the band does not show draws the band again, the
  // whole chain with it. This holds the band's order, not the area's height: that grows and
  // shrinks with the row.
  const toggle = async (shown: boolean) => {
    isShown = shown
    await runSkin($, `clip ${shown ? 'off' : 'on'}`)
  }
  stubEngine(on)
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: { command: 'skin' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__skins__design' } }))

  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })

  for (const surface of SURFACES) {
    isShown = true
    const band = await $.ui.mount(BAND(surface, false))
    const column = async () => (await band.drawn()) as { props: { rowGap?: number }; children: readonly unknown[] }
    const shown = await column()
    const first = JSON.stringify(shown.children[0])
    const last = JSON.stringify(shown.children.at(-1))

    expect(shown.children.length).toBe(2)
    expect(first).toContain('PROGRESS')
    expect(last).not.toContain('PROGRESS')
    expect(last).toContain(surface === 'desktop' ? 'Svg' : '% context')
    expect(shown.props.rowGap ?? 0).toBe(surface === 'desktop' ? 1 : 0)

    await toggle(false)
    const alone = await column()

    expect(alone.children.length).toBe(1)
    expect(JSON.stringify(alone.children[0])).toBe(last)

    await toggle(true)
    const again = await column()

    expect(again.children.length).toBe(2)
    expect(JSON.stringify(again.children.at(-1))).toBe(last)
    await band.unmount()
  }
})

test('with nothing drawn above it, the band has no gap or empty row above its rings', async ($, on) => {
  // What the skin's hook reaches when nothing beneath it draws: the engine's own band, by reference,
  // which draws nothing without a survey.
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 0 }))
  stubEngine(on)
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: { command: 'skin' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__skins__design' } }))

  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })

  const band = await $.ui.mount(BAND('desktop', false))
  const column = (await band.drawn()) as { props: { rowGap?: number }; children: readonly unknown[] }

  expect(column.props.rowGap ?? 0).toBe(0)
  expect(column.children.map(child => (child as { type?: string }).type)).toEqual(['Box'])
  expect(JSON.stringify(column.children[0])).toContain('Svg')
  await band.unmount()
})

test('cards draw no background of their own', async ($, on) => {
  stubEngine(on)

  const ui = await $.ui.mount({
    ...SITE,
    surface: 'desktop',
    component: 'AssistantMessage',
    requestId: 'bg',
    props: { text: '| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1\n```', isFirstOfReply: true },
  })
  const svg = (await ui.find({ type: 'Svg' })) as { props: { source: string } } | undefined

  expect(svg?.props.source).not.toContain('background:')
})

test('/skin gallery opens a pane with every element, numbered, on both surfaces', async ($, on) => {
  stubEngine(on)

  expect((await runSkin($, 'gallery')).text).toBeUndefined()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, requestId: 'skins-gallery', surface })

    expect(await ui.find({ type: 'Text', text: /^1  Your prompt/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^11  Turn footer/ })).toBeDefined()
    await ui.unmount()
  }
})

test('on a light Claude Code theme the skin draws dark text for a light background', async ($, on) => {
  stubEngine(on)
  on('config.list', () => ({ value: [{ key: 'theme', label: 'Theme', kind: 'enum', value: 'light', provider: { kind: 'engine' }, isLocked: false }] as never }))
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: { command: 'skin' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__skins__design' } }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const row = await $.ui.mount(toolUse(call('Bash', { command: 'ls' })))
  expect(spanColor(await row.find({ type: 'Text', text: /Bash/ }), 'Bash')).toBe('#111111')
})

test('code blocks, tables and shell output get a Copy button that copies their text', async ($, on) => {
  stubEngine(on)
  const copied: string[] = []
  on('ui.copy', ($, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })

  const text = 'Run:\n\n```ts\nconst a = 1\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |'

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...SITE, surface, component: 'AssistantMessage', requestId: `cp-${surface}`, props: { text, isFirstOfReply: true } })
    await ui.press({ key: 'copy-1' })
    await ui.press({ key: 'copy-2' })
    await ui.unmount()
  }

  const shell = await $.ui.mount({
    ...SITE,
    surface: 'desktop',
    component: 'ToolResult',
    requestId: 'cp-sh',
    props: { tool_use_id: 'cp-sh', tool: 'Bash', output: { stdout: 'built ok', stderr: '', interrupted: false }, isErrored: false },
  })
  await shell.press({ key: 'copy-output' })

  expect(copied).toEqual(['const a = 1', '| A | B |\n| --- | --- |\n| 1 | 2 |', 'const a = 1', '| A | B |\n| --- | --- |\n| 1 | 2 |', 'built ok'])
})

test('on the desktop the Copy button is laid over the card, in the corner the card leaves free', async ($, on) => {
  stubEngine(on)
  on('ui.copy', () => ({ value: { isCopied: true } }))

  const ui = await $.ui.mount({
    ...SITE,
    surface: 'desktop',
    component: 'AssistantMessage',
    requestId: 'ov',
    props: { text: '```ts\nconst a = 1\n```', isFirstOfReply: true },
  })
  type Node = { type?: string; props?: Record<string, unknown>; children?: readonly Node[] }
  const reply = (await ui.find({ type: 'Box' })) as Node
  const card = reply.children?.[0]
  const overlay = card?.children?.[1]

  expect(card?.props?.alignSelf).toBe('flex-start')
  expect(overlay?.props?.position).toBe('absolute')
  expect(overlay?.children?.[0]?.type).toBe('Button')
})

const THEME_AUTO = [{ key: 'theme', label: 'Theme', kind: 'enum', value: 'auto', provider: { kind: 'engine' }, isLocked: false }]

test('an auto theme follows the system, and SKINS_THEME overrides the setting', async ($, on) => {
  let override: string | undefined
  stubEngine(on, { env: true })
  on('env.get', ($, e) => ({ value: e.name === 'SKINS_THEME' ? override : undefined }))
  on('config.list', () => ({ value: THEME_AUTO as never }))
  // macOS answers "does not exist" when the system is light.
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'The domain/default pair does not exist' } as never }))
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: { command: 'skin' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__skins__design' } }))

  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  const light = await $.ui.mount(toolUse(call('Bash', { command: 'ls' })))
  expect(spanColor(await light.find({ type: 'Text', text: /Bash/ }), 'Bash')).toBe('#111111')

  override = 'dark'
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  const dark = await $.ui.mount({ ...toolUse(call('Bash', { command: 'ls' })), requestId: 'again' })
  expect(spanColor(await dark.find({ type: 'Text', text: /Bash/ }), 'Bash')).toBe('#ededed')
})

test('/skin pin keeps a look to this folder, /skin unpin returns to the default', async ($, on) => {
  const store: Record<string, unknown> = {}
  stubEngine(on, { store: true })
  on('store.get', ($, e) => ({ value: store[e.key] }))
  on('store.set', ($, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: { command: 'skin' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__skins__design' } }))
  on('config.list', () => ({ value: [] }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await runSkin($, 'pin')
  await runSkin($, 'nord')

  expect((store.folders as Record<string, { skin: string }>)['/work']?.skin).toBe('nord')
  expect(store.prefs).toBeUndefined()

  await runSkin($, 'unpin')
  await runSkin($, 'dracula')

  expect(store.folders).toEqual({})
  expect((store.prefs as { skin: string }).skin).toBe('dracula')
})

test('an auto theme notices the system turning dark mid-session, asking it at most once a minute', async ($, on) => {
  let asked = 0
  let isDark = false
  const clock = stubEngine(on)
  on('config.list', () => ({ value: THEME_AUTO as never }))
  on('process.run', () => {
    asked += 1
    return { value: (isDark ? { exitCode: 0, stdout: 'Dark\n', stderr: '' } : { exitCode: 1, stdout: '', stderr: 'The domain/default pair does not exist' }) as never }
  })
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: { command: 'skin' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__skins__design' } }))
  const bashColor = async (id: string) => {
    const row = await $.ui.mount({ ...toolUse(call('Bash', { command: 'ls' })), requestId: id })
    const color = spanColor(await row.find({ type: 'Text', text: /Bash/ }), 'Bash')
    await row.unmount()
    return color
  }

  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  expect(await bashColor('t1')).toBe('#111111')

  isDark = true
  await clock.advance(1000)
  expect(await bashColor('t2')).toBe('#111111')
  expect(asked).toBe(1)

  await clock.advance(60_000)
  // The kit does not promise to wait for a timer's work, so let it finish before looking:
  // the read asks the system, then repaints.
  let color = await bashColor('t3')
  for (let i = 0; i < 50 && color !== '#ededed'; i += 1) {
    await clock.settle()
    color = await bashColor(`t3-${i}`)
  }
  expect(color).toBe('#ededed')
  expect(asked).toBe(2)
})

test('Claude Code\u2019s Reduce motion holds the desktop\u2019s icons and cards still, whatever the system says', async ($, on) => {
  let reduces = true
  stubEngine(on)
  on('config.list', () => ({ value: [{ key: 'reduceMotion', label: 'Reduce motion', kind: 'boolean', value: reduces, provider: { kind: 'engine' }, isLocked: false }] as never }))
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: { command: 'skin' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__skins__design' } }))
  // The rule outside any media query: the one inside it follows the system, not the setting.
  const holdsStill = (source: string | undefined) =>
    (source ?? '').split('@media (prefers-reduced-motion:reduce){*{animation:none!important}}').join('').includes('*{animation:none!important}')
  const calls = heldCalls($, on)

  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })

  const icon = await $.ui.mount(toolUse(call('Bash', { command: 'sleep 9' }, { tool_use_id: 'rm1', isRunning: true }), 'desktop'))
  expect(holdsStill(((await icon.find({ type: 'Svg' })) as { props: { source: string } } | undefined)?.props.source)).toBe(true)
  await icon.unmount()

  const card = await $.ui.mount({
    ...SITE,
    surface: 'desktop',
    component: 'ToolResult',
    requestId: 'rm2',
    props: { tool_use_id: 'rm2', tool: 'Bash', output: { stdout: 'built', stderr: '', interrupted: false }, isErrored: false },
  })
  expect(holdsStill(((await card.find({ type: 'Svg' })) as { props: { source: string } } | undefined)?.props.source)).toBe(true)
  await card.unmount()

  const band = await $.ui.mount(BAND('desktop', false))
  expect(holdsStill(((await band.find({ type: 'Svg' })) as { props: { source: string } } | undefined)?.props.source)).toBe(true)
  await band.unmount()

  // Turned off again, only the system's preference holds them still.
  reduces = false
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await calls.start('rm3')
  const moving = await $.ui.mount(toolUse(call('Bash', { command: 'sleep 9' }, { tool_use_id: 'rm3', isRunning: true }), 'desktop'))
  expect(holdsStill((await svgOf(moving)).source)).toBe(false)
})

test('the band hides Compact below 50% context and offers it, dimmed, from 50%', async ($, on) => {
  mock.clock(on)
  let percent = 40
  on('session.cwd', () => ({ value: '/work' }))
  on('store.get', () => ({ value: undefined }))
  on('ui.render', () => STOCK)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent }, rateLimits: [] } }))
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: { command: 'skin' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__skins__design' } }))

  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })

  const low = await $.ui.mount(BAND('desktop', false))
  expect(await low.find({ key: 'compact' })).toBeUndefined()
  await low.unmount()

  // The band's numbers refresh at session start, a turn's end, or a plan limit's move.
  percent = 55
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  const mid = await $.ui.mount(BAND('desktop', false))
  expect(((await mid.find({ key: 'compact' })) as { props: { label?: string } } | undefined)?.props.label).toBe('Compact')
  expect(await mid.find({ type: 'Text', text: 'Context is 55% full' })).toBeUndefined()
  await mid.unmount()
})

test('a card animates on its first draw only: a redraw of the same row holds still', async ($, on) => {
  stubEngine(on)
  let theme = 'dark'
  on('config.list', () => ({ value: [{ key: 'theme', label: 'Theme', kind: 'enum', value: theme, provider: { kind: 'engine' }, isLocked: false }] as never }))
  on('config.set', ($, e) => ((theme = String(e.value)), { value: e.value }) as never)
  const sourceOf = async (ui: { find: (q: { type: string }) => Promise<unknown> }) =>
    ((await ui.find({ type: 'Svg' })) as { props: { source: string } } | undefined)?.props.source ?? ''
  const held = '*{animation:none!important}</style>'

  const shell = await $.ui.mount({ ...SITE, surface: 'desktop', component: 'ToolResult', requestId: 'once-sh', props: { tool_use_id: 'once-sh', tool: 'Bash', output: { stdout: 'built', stderr: '', interrupted: false }, isErrored: false } })
  const code = await $.ui.mount({ ...SITE, surface: 'desktop', component: 'AssistantMessage', requestId: 'once-tb', props: { text: '```ts\nconst a = 1\n```' } as never })
  expect(await sourceOf(shell)).not.toContain(held)
  expect(await sourceOf(code)).not.toContain(held)

  // Any write the cards read (here a theme switch) draws them again: the rows must not rise in a second time.
  await $.config.set({ key: 'theme', value: 'light', previous: 'dark', provider: { kind: 'engine' }, origin: { kind: 'composer' } } as never)
  expect(await sourceOf(shell)).toContain(held)
  expect(await sourceOf(code)).toContain(held)
  await shell.unmount()
  await code.unmount()
})

test('the terminal drawing a reply first does not hold the desktop’s first card still', async ($, on) => {
  stubEngine(on)
  const reply = (surface: (typeof SURFACES)[number]) =>
    ({ ...SITE, surface, component: 'AssistantMessage', requestId: 'both-tb', props: { text: '```ts\nconst a = 1\n```' } as never }) as const

  await (await $.ui.mount(reply('terminal'))).unmount()
  const desktop = await $.ui.mount(reply('desktop'))
  const source = ((await desktop.find({ type: 'Svg' })) as { props: { source: string } } | undefined)?.props.source ?? ''
  expect(source).toContain('<svg')
  expect(source).not.toContain('*{animation:none!important}</style>')
  await desktop.unmount()
})

test('each surface remembers its own card draws: desktop, mobile, desktop animates, animates, holds', async ($, on) => {
  stubEngine(on)
  const sourceOf = async (ui: { find: (q: { type: string }) => Promise<unknown> }) =>
    ((await ui.find({ type: 'Svg' })) as { props: { source: string } } | undefined)?.props.source ?? ''
  const held = '*{animation:none!important}</style>'
  const shell = (surface: 'desktop' | 'mobile') =>
    ({ ...SITE, surface, component: 'ToolResult', requestId: 'surf-sh', props: { tool_use_id: 'surf-sh', tool: 'Bash', output: { stdout: 'built', stderr: '', interrupted: false }, isErrored: false } }) as const
  const table = (surface: 'desktop' | 'mobile') =>
    ({ ...SITE, surface, component: 'AssistantMessage', requestId: 'surf-tb', props: { text: '```ts\nconst a = 1\n```' } as never }) as const

  for (const make of [shell, table]) {
    const states: boolean[] = []
    for (const surface of ['desktop', 'mobile', 'desktop'] as const) {
      const ui = await $.ui.mount(make(surface))
      states.push((await sourceOf(ui)).includes(held))
      await ui.unmount()
    }
    expect(states).toEqual([false, false, true])
  }
})

const desktopReply = (requestId: string, text: string) =>
  ({ ...SITE, surface: 'desktop', component: 'AssistantMessage', requestId, props: { text, isFirstOfReply: true } }) as const
// Every image a mounted drawing holds, in order: an Svg's, and the one a loop's Client draws.
type Image = { source: string; alt: string; width: number; isInteractive?: boolean }
type Drawn = { type?: string; props?: { props?: unknown }; children?: readonly unknown[] }
async function svgsOf(ui: { drawn: () => Promise<unknown> }): Promise<Image[]> {
  const found: Image[] = []
  const walk = (node: unknown): void => {
    const element = (typeof node === 'object' && node !== null ? node : {}) as Drawn
    if (element.type === 'Svg') found.push(element.props as Image)
    if (element.type === 'Client') found.push(element.props?.props as Image)
    element.children?.forEach(walk)
  }
  walk(await ui.drawn())
  return found
}
const svgOf = async (ui: { drawn: () => Promise<unknown> }) => (await svgsOf(ui))[0] ?? { source: '', width: 0 }

// The images that loop: each ring's, a running arc, a spinner.
const loopingOf = async (ui: { drawn: () => Promise<unknown> }) =>
  (await svgsOf(ui)).map(svg => svg.source).filter(source => source.includes('infinite'))

// An image's animation delays that are not fixed offsets: negative, or longer than any stagger.
const timedDelays = (source: string) => [...source.matchAll(/(-?\d+)ms infinite/g)].map(m => Number(m[1])).filter(ms => ms < 0 || ms > 2000)

test('a desktop table card keeps Copy inside its header row, after the last header, centred with it', async ($, on) => {
  stubEngine(on)
  const copied: string[] = []
  on('ui.copy', ($, e) => (copied.push(e.text), { value: { isCopied: true } }))
  const ui = await $.ui.mount(desktopReply('span-tb', '| Client | Where |\n| --- | --- |\n| Robot | Pi |'))
  type Node = { type?: string; props?: Record<string, unknown>; children?: readonly Node[] }
  const card = ((await ui.find({ type: 'Box' })) as Node).children?.[0]
  const header = card?.children?.[0]
  const last = header?.children?.at(-1)
  const [label, slot] = last?.children ?? []

  // Nothing laid over the card's corner: Copy is in the flow, in its own slot.
  expect(card?.children?.some(child => child.props?.position === 'absolute')).toBe(false)
  // Two columns in the header row: no phantom third one for the icon.
  expect(header?.children).toHaveLength(2)
  expect(header?.props?.alignItems).toBe('center')
  expect(last?.props).toMatchObject({ flexDirection: 'row', alignItems: 'center' })
  // The label takes what the slot leaves; the slot never shrinks under it.
  expect(label?.props?.flexGrow).toBe(1)
  expect(label?.children?.[0]?.children?.[0]).toBe('WHERE')
  expect(slot?.props?.flexShrink).toBe(0)
  expect(slot?.children?.[0]?.type).toBe('Button')
  expect(slot?.children?.[0]?.props?.key).toBe('copy-0')
  await ui.press({ key: 'copy-0' })
  expect(copied).toEqual(['| Client | Where |\n| --- | --- |\n| Robot | Pi |'])
  await ui.unmount()
})

test('code cards keep only an icon-sized corner free for Copy', async () => {
  const card = codeSvg('const a = 1', 'ts', tokyoNight.palette, 600, true)

  expect(CONTROL_SLOT).toBeLessThanOrEqual(48)
  expect(card.source).toContain(`<text x="${600 - 16 - CONTROL_SLOT}"`)
})

test('a desktop table card copies with a dim one-glyph icon, ascii icons too: its slot fits one glyph', async ($, on) => {
  stubEngine(on)
  on('ui.copy', () => ({ value: { isCopied: true } }))
  on('command.register', () => ({ value: { command: 'skin' } }))
  const buttonOf = async (requestId: string) => {
    const ui = await $.ui.mount(desktopReply(requestId, '| A | B |\n| --- | --- |\n| 1 | 2 |'))
    const button = (await ui.find({ type: 'Button' })) as unknown as { props: { label: string; plain?: boolean; dimColor?: boolean } }
    await ui.unmount()
    return button.props
  }

  expect(await buttonOf('icon-tb')).toMatchObject({ label: '⧉', plain: true, dimColor: true })
  await runSkin($, 'icons ascii')
  expect(await buttonOf('icon-tb-ascii')).toMatchObject({ label: '⧉' })
})

test('a desktop table card draws long headers and cells in full, and a column never narrower than its longest word', async ($, on) => {
  stubEngine(on)
  const long = 'the unit restarts it on failure with a five second backoff, which held when the process was killed twice'
  const ui = await $.ui.mount(desktopReply('full-tb', `| Directory marketplaces | What | Why |\n| --- | --- | --- |\n| Directory marketplaces | ${long} | ${long} ${long} |`))
  type Node = { props?: { width?: unknown }; children?: readonly Node[] }
  const header = ((await ui.find({ type: 'Box' })) as Node).children?.[0]?.children?.[0]
  const shares = (header?.children ?? []).map(cell => Number.parseFloat(String(cell.props?.width)))
  // The card spans the room the reply gives it; the first column holds its longest word whole.
  const room = 100 * PX_PER_COLUMN

  expect(await ui.find({ type: 'Text', text: 'DIRECTORY MARKETPLACES' })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: `${long} ${long}` })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /…/ })).toBeUndefined()
  expect(Math.round(shares.reduce((sum, share) => sum + share, 0))).toBe(100)
  expect(((shares[0] ?? 0) / 100) * room).toBeGreaterThanOrEqual(measure('MARKETPLACES', false, 14))
  expect(((shares[0] ?? 0) / 100) * room).toBeGreaterThanOrEqual(measure('marketplaces', false, 15))
  await ui.unmount()
})

test('a desktop table column of CJK text is at least as wide as its text', async ($, on) => {
  stubEngine(on)
  const cjk = '設定ファイルの場所'
  const long = 'the unit restarts it on failure with a five second backoff, which held when the process was killed twice'
  const ui = await $.ui.mount(desktopReply('cjk-tb', `| 名前 | Why |\n| --- | --- |\n| ${cjk} | ${long} ${long} |`))
  type Node = { props?: { width?: unknown }; children?: readonly Node[] }
  const header = ((await ui.find({ type: 'Box' })) as Node).children?.[0]?.children?.[0]
  const share = Number.parseFloat(String(header?.children?.[0]?.props?.width))

  expect((share / 100) * 100 * PX_PER_COLUMN).toBeGreaterThanOrEqual([...cjk].length * 15)
  await ui.unmount()
})

test('a link in a desktop table cell is the surface’s own link, inline in its cell, with no row of links under the card', async ($, on) => {
  stubEngine(on)
  const ui = await $.ui.mount(desktopReply('link-tb', '| Client | Docs |\n| --- | --- |\n| Robot | see [README](https://github.com/nycom/orion#readme) first |'))

  expect((await ui.findAll({ type: 'Markdown' })).map(found => found.props.text)).toContain('see [README](https://github.com/nycom/orion#readme) first')
  expect(await ui.find({ type: 'Link' })).toBeUndefined()
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  await ui.unmount()
})

const nodesOf = (node: unknown): number => {
  const element = (typeof node === 'object' && node !== null ? node : {}) as Drawn
  return 1 + (element.children ?? []).reduce<number>((sum, child) => sum + nodesOf(child), 0)
}
const tableOf = (rows: number, cols: number) => {
  const line = (cell: (c: number) => string) => `| ${Array.from({ length: cols }, (_, c) => cell(c)).join(' | ')} |`
  return [line(c => `H${c}`), line(() => '---'), ...Array.from({ length: rows }, (_, r) => line(c => `r${r}c${c}`))].join('\n')
}

test('a desktop table too big or too wide for a native grid is one markdown block, and the reply stays drawable', async ($, on) => {
  stubEngine(on)
  for (const [rows, cols] of [[200, 5], [120, 8], [3, 30]] as const) {
    const text = tableOf(rows, cols)
    const ui = await $.ui.mount(desktopReply(`big-${rows}x${cols}`, text))
    const drawn = await ui.drawn()
    const markdowns = await ui.findAll({ type: 'Markdown' })

    expect(nodesOf(drawn)).toBeLessThan(2000)
    expect(markdowns).toHaveLength(1)
    expect(String(markdowns[0]?.props.text)).toContain(`| r${rows - 1}c0 |`)
    await ui.unmount()
  }

  // The markdown keeps a column's alignment.
  const aligned = await $.ui.mount(desktopReply('big-align', tableOf(3, 13).replace('| --- |', '| --: |')))
  expect(await aligned.find({ type: 'Markdown', text: /^\| H0 [^\n]*\n\| --: \| --- \|/ })).toBeDefined()
  await aligned.unmount()

  // Two tables that fit alone but not together: the first stays a grid, the second falls back.
  const ui = await $.ui.mount(desktopReply('big-pair', `${tableOf(90, 5)}\n\ntext\n\n${tableOf(90, 5)}`))
  expect(nodesOf(await ui.drawn())).toBeLessThan(2000)
  expect(await ui.find({ type: 'Markdown', text: /\| r89c0 \|/ })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: 'r0c0' })).toBeDefined()
  await ui.unmount()

  // A normal table still draws natively.
  const small = await $.ui.mount(desktopReply('big-small', tableOf(10, 4)))
  expect(await small.find({ type: 'Markdown', text: 'r9c3' })).toBeDefined()
  await small.unmount()
})

test('a desktop table is drawn once: it sets no settle timer and never holds a redraw', async ($, on) => {
  const clock = stubEngine(on)
  // A settle is a write to `settled` once the card has risen, which draws the reply again.
  const settles: unknown[] = []
  on('state.set', ($, e, next) => (e.key === 'settled' && settles.push(e.id), next(e)))

  const table = await $.ui.mount(desktopReply('quiet-tb', '| Client | Where |\n| --- | --- |\n| Robot | Pi |'))
  await clock.advance(1500)
  expect(settles).toEqual([])
  await table.unmount()

  // A code card in the same place still settles.
  const code = await $.ui.mount(desktopReply('quiet-cd', '```ts\nconst a = 1\n```'))
  await clock.advance(1500)
  expect(settles).toHaveLength(1)
  await code.unmount()
})

test('a code card scrolled back into view does not rise in again, whatever request draws it', async ($, on) => {
  const clock = stubEngine(on)
  const text = '```ts\nconst a = 1\n```'
  const held = '*{animation:none!important}</style>'

  // The engine keeps a drawing's answer and replays it when the row mounts again: once its
  // rows have risen, the answer it keeps must be the still one.
  const first = await $.ui.mount(desktopReply('scroll-a', text))
  expect((await svgOf(first)).source).not.toContain(held)
  await clock.advance(1500)
  expect((await svgOf(first)).source).toContain(held)
  await first.unmount()

  // A mount under a new request id draws the same card, already seen, still.
  const again = await $.ui.mount(desktopReply('scroll-b', text))
  expect((await svgOf(again)).source).toContain(held)
  await again.unmount()
})

test('a diff or terminal card scrolled back into view does not rise in again, whatever request draws it', async ($, on) => {
  const clock = stubEngine(on)
  const held = '*{animation:none!important}</style>'
  const result = (requestId: string, tool_use_id: string, tool: string, output: unknown) =>
    ({ ...SITE, surface: 'desktop', component: 'ToolResult', requestId, props: { tool_use_id, tool, output, isErrored: false } }) as const
  const cards = [
    ['scroll-ed', 'Edit', { filePath: '/work/src/a.ts', structuredPatch: [{ oldStart: 1, newStart: 1, lines: ['-a', '+b'] }] }],
    ['scroll-sh', 'Bash', { stdout: 'built', stderr: '', interrupted: false }],
  ] as const

  for (const [id, tool, output] of cards) {
    // Once its rows have risen, the drawing the engine keeps for the row is the still one.
    const first = await $.ui.mount(result(id, id, tool, output))
    expect((await svgOf(first)).source).not.toContain(held)
    await clock.advance(1500)
    expect((await svgOf(first)).source).toContain(held)
    await first.unmount()

    // Mounted again under a new request id, the same completed card draws still.
    const again = await $.ui.mount(result(`${id}-again`, id, tool, output))
    expect((await svgOf(again)).source).toContain(held)
    await again.unmount()
  }
})

test('a running tool keeps its arc spinning: only completed cards settle', async ($, on) => {
  const clock = stubEngine(on)
  const calls = heldCalls($, on)
  await calls.start('live-sh')
  const held = '*{animation:none!important}</style>'
  const running = toolUse(call('Bash', { command: 'sleep 9' }, { tool_use_id: 'live-sh', isRunning: true }), 'desktop')

  const ui = await $.ui.mount(running)
  await clock.advance(1500)
  const source = (await svgOf(ui)).source
  expect(source).toContain('class="spin"')
  expect(source).not.toContain(held)
  await ui.unmount()

  const again = await $.ui.mount(running)
  expect((await svgOf(again)).source).not.toContain(held)
  await again.unmount()
})

test('when the context ring moves, a weekly ring that did not move stays full instead of replaying', async ($, on) => {
  mock.clock(on)
  let percent = 40
  on('session.cwd', () => ({ value: '/work' }))
  on('store.get', () => ({ value: undefined }))
  on('ui.render', () => STOCK)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent }, rateLimits: [{ kind: 'seven_day', percentUsed: 19 }] } }))
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: { command: 'skin' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__skins__design' } }))
  const rings = async () => {
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    const band = await $.ui.mount(BAND('desktop', false))
    const sources = (await svgsOf(band)).map(svg => svg.source).filter(source => source.includes('<mask id="jog"'))
    await band.unmount()
    return sources
  }

  const first = await rings()
  expect(first.length).toBe(2)
  expect(first[0]).toContain('@keyframes fill{')
  expect(first[1]).toContain('@keyframes fill{')
  percent = 55
  const moved = await rings()
  expect(moved[0]).toContain('@keyframes fill{')
  expect(moved[1]).not.toContain('@keyframes fill')
})

test('the context ring grows from its last reading, and a redraw at the same reading is the same image', async ($, on) => {
  let percent = 40
  const clock = mock.clock(on)
  on('session.cwd', () => ({ value: '/work' }))
  on('store.get', () => ({ value: undefined }))
  on('ui.render', () => STOCK)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent }, rateLimits: [] } }))
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: { command: 'skin' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__skins__design' } }))
  const ring = async () => {
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    const band = await $.ui.mount(BAND('desktop', false))
    const { source } = await svgOf(band)
    await band.unmount()
    return source
  }
  const circumference = 2 * Math.PI * 8

  expect(await ring()).toContain('@keyframes fill{from{stroke-dasharray:0 ')
  percent = 55
  const grown = await ring()
  expect(grown).toContain(`@keyframes fill{from{stroke-dasharray:${(circumference * 40) / 100} `)
  expect(await ring()).toBe(grown)
  // Once grown, the band settles: an image built again has nothing left to replay.
  await clock.advance(1200)
  const settled = await ring()
  expect(settled).not.toContain('@keyframes fill')
  expect(await ring()).toBe(settled)
  // The fill arc and its segments sit on its track: one centre per ring.
  const centres = [...grown.matchAll(/<circle[^>]* cx="([\d.]+)" cy="([\d.]+)"/g)].map(m => `${m[1]},${m[2]}`)
  expect(centres.length).toBeGreaterThan(2)
  expect(new Set(centres).size).toBe(1)
})

test('a band left on screen settles by itself once its rings have grown', async ($, on) => {
  const clock = mock.clock(on)
  on('session.cwd', () => ({ value: '/work' }))
  on('store.get', () => ({ value: undefined }))
  on('ui.render', () => STOCK)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: 40 }, rateLimits: [] } }))
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: { command: 'skin' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__skins__design' } }))
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  const band = await $.ui.mount(BAND('desktop', false))
  const source = async () => (await svgOf(band)).source

  expect(await source()).toContain('@keyframes fill')
  await clock.advance(1200)
  expect(await source()).toContain('<svg')
  expect(await source()).not.toContain('@keyframes fill')
  await band.unmount()
})

test('a band left on screen relabels its reset at midnight and drops it once the reset passes', async ($, on) => {
  // Friday 23:00, the 7d window resetting Saturday 9:00.
  const clock = mock.clock(on, { now: new Date(2026, 9, 9, 23, 0).getTime() })
  on('session.cwd', () => ({ value: '/work' }))
  on('store.get', () => ({ value: undefined }))
  on('ui.render', () => STOCK)
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000, percent: 40 }, rateLimits: [{ kind: 'seven_day', percentUsed: 23, resetsAt: new Date(2026, 9, 10, 9, 0).toISOString() }] },
  }))
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: { command: 'skin' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__skins__design' } }))
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  const band = await $.ui.mount(BAND('desktop', false))
  const alt = async () => (await svgsOf(band)).map(svg => svg.alt).join(' | ')

  expect(await alt()).toContain('7d 23% | resets tomorrow 9:00am')
  // Saturday 8:00: the same reset, now today's.
  await clock.advance(9 * 60 * 60 * 1000)
  expect(await alt()).toContain('7d 23% | resets 9:00am')
  // Saturday 10:00: the window has reset, so no time is named.
  await clock.advance(2 * 60 * 60 * 1000)
  expect(await alt()).toContain('7d 23%')
  expect(await alt()).not.toContain('resets')
  await band.unmount()
})

test('a session with no reading yet shows the last plan limits seen, a window past its reset as 0%', async ($, on) => {
  // Friday noon; the 5h window reset at 11:00, the 7d one resets Monday.
  const clock = mock.clock(on, { now: new Date(2026, 9, 9, 12, 0).getTime() })
  let rateLimits: unknown[] = [
    { kind: 'five_hour', percentUsed: 64, resetsAt: new Date(2026, 9, 9, 11, 0).toISOString() },
    { kind: 'seven_day', percentUsed: 23, resetsAt: new Date(2026, 9, 12, 9, 0).toISOString() },
  ]
  on('session.cwd', () => ({ value: '/work' }))
  mock.store(on)
  on('ui.render', () => STOCK)
  on('config.list', () => ({ value: [] }))
  on('env.get', () => ({ value: undefined }))
  on('classic.SessionStart', () => ({}))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: 40 }, rateLimits: rateLimits as never } }))
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: { command: 'skin' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__skins__design' } }))
  const alt = async () => {
    const band = await $.ui.mount(BAND('desktop', false))
    const all = (await svgsOf(band)).map(svg => svg.alt).join(' | ')
    await band.unmount()
    return all
  }

  // A reply's reading is remembered.
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  // The next session, before its first reply, has none of its own.
  rateLimits = []
  await clock.advance(1000)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  expect(await alt()).toContain('context 40% | ')
  expect(await alt()).toContain('5h 0%')
  expect(await alt()).toContain('7d 23% | resets Mon 9:00am')

  // /clear resets the band's state, so it reads the limits again.
  rateLimits = [{ kind: 'five_hour', percentUsed: 30, resetsAt: new Date(2026, 9, 9, 16, 0).toISOString() }]
  await $.classic.SessionStart({ source: 'clear' })
  expect(await alt()).toContain('5h 30% | resets 4:00pm')
})

test('the context ring chases faster in warn from 70% with Compact offered, and holds still under Reduce motion', async ($, on) => {
  mock.clock(on)
  let percent = 65
  let reduces = false
  on('session.cwd', () => ({ value: '/work' }))
  on('store.get', () => ({ value: undefined }))
  on('env.get', () => ({ value: undefined }))
  on('ui.render', () => STOCK)
  on('config.list', () => ({ value: [{ key: 'reduceMotion', label: 'Reduce motion', kind: 'boolean', value: reduces, provider: { kind: 'engine' }, isLocked: false }] as never }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent }, rateLimits: [] } }))
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: { command: 'skin' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__skins__design' } }))
  const ring = async () => {
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    const band = await $.ui.mount(BAND('desktop', false))
    const { source } = await svgOf(band)
    await band.unmount()
    return source
  }
  const held = (source: string) => source.split('@media (prefers-reduced-motion:reduce){*{animation:none!important}}').join('').includes('*{animation:none!important}')

  expect(await ring()).toContain('animation:jog 3s ease-in-out')
  percent = 72
  const nudged = await ring()
  expect(nudged).toContain('@keyframes jog{')
  expect(nudged).toContain('animation:jog 2.4s ease-in-out')
  expect(held(nudged)).toBe(false)
  reduces = true
  expect(held(await ring())).toBe(true)
})

// A Friday noon, in local time so the reset labels hold in any time zone.
const NOON = new Date(2026, 9, 9, 12, 0).getTime()

const category = (name: string, tokens: number, kind = 'used') => ({ name, tokens, kind, color: 'x', isDeferred: kind === 'deferred' })

// What `$.session.usage` answers with every extra the band can show: tokens, resets and the breakdown.
const fullUsage = (percent: number, args: { breakdown?: string }) => ({
  startedAt: 0,
  context: {
    tokens: percent * 2000,
    window: 200_000,
    percent,
    ...(args.breakdown === undefined
      ? {}
      : {
          breakdown: {
            categories: [
              category('System prompt', 9_000),
              category('System tools', 22_000),
              category('Memory files', 8_000),
              category('Messages', 61_000),
              category('MCP tools', 30_000, 'deferred'),
              category('Free space', 67_000, 'free'),
              category('Autocompact buffer', 33_000, 'buffer'),
            ],
          },
        }),
  },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 19, resetsAt: new Date(2026, 9, 9, 14, 40).toISOString() },
    { kind: 'seven_day', percentUsed: 23, resetsAt: new Date(2026, 9, 12, 9, 0).toISOString() },
  ],
})

// Mounts the band against `usage` and hands back its desktop image source, or the terminal row's text.
async function bandWith($: Engine, on: On, usage: (args: { breakdown?: string }) => unknown, reduces = false) {
  const asked: (string | undefined)[] = []
  mock.clock(on, { now: NOON })
  on('session.cwd', () => ({ value: '/work' }))
  // A skin with a colour per slot, so the breakdown's segments differ.
  on('store.get', ($, e) => ({ value: e.key === 'prefs' ? { skin: 'tokyo-night' } : undefined }))
  on('env.get', () => ({ value: undefined }))
  on('ui.render', () => STOCK)
  on('config.list', () => ({ value: [{ key: 'reduceMotion', label: 'Reduce motion', kind: 'boolean', value: reduces, provider: { kind: 'engine' }, isLocked: false }] as never }))
  on('session.usage', ($, e) => {
    asked.push(e.breakdown)
    return { value: usage(e) as never }
  })
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: { command: 'skin' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__skins__design' } }))
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })

  const draw = async (surface: (typeof SURFACES)[number], columns = 200) => {
    const band = await $.ui.mount(BAND(surface, false, columns))
    // The desktop's images side by side, as one.
    const svgs = await svgsOf(band)
    const text = JSON.stringify(await band.drawn())
    const hasCompact = (await band.find({ key: 'compact' })) !== undefined
    await band.unmount()
    return {
      source: svgs.map(svg => svg.source).join(''),
      alt: svgs.map(svg => svg.alt).join(' | '),
      text,
      hasCompact,
      width: svgs.reduce((sum, svg) => sum + svg.width, 0),
    }
  }

  return { draw, asked }
}

test('each ring is an image of its own, byte-identical whatever its tokens, reset, the breakdown or the clock', async ($, on) => {
  let tokens = 148_000
  let resetsAt = new Date(2026, 9, 9, 14, 40)
  let messages = 61_000
  const clock = mock.clock(on, { now: NOON })
  on('session.cwd', () => ({ value: '/work' }))
  on('store.get', ($, e) => ({ value: e.key === 'prefs' ? { skin: 'tokyo-night' } : undefined }))
  on('env.get', () => ({ value: undefined }))
  on('ui.render', () => STOCK)
  on('config.list', () => ({ value: [] }))
  on('session.usage', ($, e) => ({
    value: {
      startedAt: 0,
      context: {
        tokens,
        window: 200_000,
        percent: 74,
        ...(e.breakdown === undefined ? {} : { breakdown: { categories: [category('Messages', messages), category('System tools', 22_000), category('System prompt', 9_000)] } }),
      },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 85, resetsAt: resetsAt.toISOString() },
        { kind: 'seven_day', percentUsed: 96, resetsAt: new Date(2026, 9, 12, 9, 0).toISOString() },
      ],
    } as never,
  }))
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: { command: 'skin' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__skins__design' } }))
  const draw = async () => {
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    const band = await $.ui.mount(BAND('desktop', false, 200))
    const looping = await loopingOf(band)
    const all = (await svgsOf(band)).map(svg => `${svg.source}${svg.alt}`).join('')
    await band.unmount()
    return { looping, all }
  }

  // The rings grow in, then settle.
  await draw()
  await clock.advance(1500)
  const first = await draw()
  tokens = 152_000
  resetsAt = new Date(2026, 9, 9, 15, 10)
  messages = 90_000
  await clock.advance(370)
  const later = await draw()

  expect(first.all).toContain('148k/200k')
  expect(later.all).toContain('152k/200k')
  expect(later.all).toContain('3:10pm')
  expect(later.all).toContain('msgs 74%')
  expect(later.looping).toEqual(first.looping)
  expect(first.looping.length).toBe(3)
  for (const source of first.looping) {
    expect(source).not.toContain('<text')
    expect(source).not.toContain('class="part"')
    expect(timedDelays(source)).toEqual([])
  }
})

test('a running arc, a folded group’s arc and every desktop spinner draw the same image however long they run', async ($, on) => {
  const clock = stubEngine(on)
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: { command: 'skin' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__skins__design' } }))
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  const running = toolUse(call('Bash', { command: 'sleep 9' }, { tool_use_id: 'live-sh', isRunning: true }), 'desktop')
  const calls = [call('Read', {}, { isRunning: true }), call('Grep', { pattern: 'x' })]
  const group = { ...SITE, surface: 'desktop', component: 'ToolGroup', requestId: 'g-live', props: { calls, isActive: true, isExpanded: false } } as const
  const spinners = (['thinking', 'tool-use', 'responding', 'requesting'] as const).map(
    mode => ({ ...SITE, surface: 'desktop', component: 'Spinner', requestId: 'main', props: { word: 'Sauteing', message: null, suffix: '…', mode } }) as const,
  )
  const draw = async () => {
    const found: string[] = []
    for (const element of [running, group, ...spinners]) {
      const ui = await $.ui.mount(element)
      found.push(...(await svgsOf(ui)).map(svg => svg.source))
      await ui.unmount()
    }
    return found
  }

  const first = await draw()
  await clock.advance(1370)
  const later = await draw()

  expect(first.length).toBe(6)
  expect(first.filter(source => source.includes(' infinite')).length).toBe(6)
  expect(later).toEqual(first)
  for (const source of first) {
    expect(timedDelays(source)).toEqual([])
  }
})

test('a band redrawn while its rings grow is the same image, settles once, and its unmoved rings never change', async ($, on) => {
  let percent = 40
  const clock = mock.clock(on, { now: 10_000 })
  on('session.cwd', () => ({ value: '/work' }))
  on('store.get', () => ({ value: undefined }))
  on('config.list', () => ({ value: [] }))
  on('ui.render', () => STOCK)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent }, rateLimits: [{ kind: 'seven_day', percentUsed: 85 }] } }))
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: { command: 'skin' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__skins__design' } }))
  const rings = async () => {
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    const band = await $.ui.mount(BAND('desktop', false))
    const looping = await loopingOf(band)
    await band.unmount()
    return looping
  }

  await rings()
  await clock.advance(1500)
  const [, weekly] = await rings()
  percent = 55
  const growing = await rings()
  expect(growing[0]).toContain('@keyframes fill')
  expect(growing[1]).toBe(weekly)
  await clock.advance(400)
  expect(await rings()).toEqual(growing)
  // Settled: one swap of the moved ring, with no growth left in it, and the same from then on.
  await clock.advance(1100)
  const settled = await rings()
  expect(settled[0]).not.toContain('@keyframes fill')
  expect(settled[1]).toBe(weekly)
  await clock.advance(5000)
  expect(await rings()).toEqual(settled)
})

test('the band shows tokens on the context ring, resets on the plan rings, and the context breakdown', async ($, on) => {
  const { draw, asked } = await bandWith($, on, args => fullUsage(48, args))
  const { source, alt } = await draw('desktop')

  // The breakdown is the local estimate, never the counted one that sends requests.
  expect(asked).toEqual(['summary'])
  expect(source).toContain('96k/200k')
  expect(source).toContain('2:40pm')
  expect(source).toContain('Mon 9:00am')
  // The bar draws no names; its alt reads every part. Free space, the buffer and deferred tools are not content.
  expect(source).not.toContain('msgs')
  expect(alt).toContain('context holds msgs 61%, tools 22%, sys 9%, memory 8%')
  expect(alt).not.toContain('free')
  const palette = tokyoNight.palette
  expect(source).toContain(`class="part" x="`)
  for (const slot of ['user', 'run', 'read', 'write'] as const) {
    expect(source).toContain(`fill="${palette[slot]}"`)
  }

  const terminal = await draw('terminal')
  expect(terminal.text).toContain('48% context · 96k/200k')
  expect(terminal.text).toContain('19% 5h · 2:40pm')
  expect(terminal.text).toContain('23% 7d · Mon 9:00am')
  expect(terminal.text).toContain('■')
  expect(terminal.text).not.toContain('msgs')
})

test('the band leaves out tokens and resets it was not given, and the breakdown when it fails', async ($, on) => {
  const { draw } = await bandWith($, on, args => {
    if (args.breakdown !== undefined) {
      throw new Error('no breakdown')
    }

    return { startedAt: 0, context: { window: 200_000, percent: 48 }, rateLimits: [{ kind: 'five_hour', percentUsed: 19 }] }
  })
  const { source } = await draw('desktop')

  expect(source).toContain('48%')
  expect(source).not.toContain(' · ')
  expect(source).not.toContain('class="part"')
  expect(source).not.toContain('msgs')
  expect((await draw('terminal')).text).not.toContain(' · ')
})

test('a narrow band drops the breakdown bar, then the resets, then the tokens, names no part at any width, and keeps Compact', { timeoutMs: 30_000 }, async ($, on) => {
  let percent = 55
  const { draw } = await bandWith($, on, args => fullUsage(percent, args))
  const order = ['bar', 'resets', 'tokens'] as const

  for (const reading of [55, 85]) {
    percent = reading
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })

    for (const surface of SURFACES) {
      const seen = new Set<string>()

      for (let columns = 220; columns >= 20; columns -= 4) {
        const { source, text, hasCompact } = await draw(surface, columns)
        const drawn = surface === 'desktop' ? source : text
        expect(`${surface} ${columns} named ${drawn.includes('msgs')}`).toBe(`${surface} ${columns} named false`)
        const shows = {
          bar: drawn.includes(surface === 'desktop' ? 'class="part"' : '■'),
          resets: drawn.includes('2:40pm'),
          tokens: drawn.includes(`${reading * 2}k/200k`),
        }
        const kept = order.map(extra => shows[extra])

        // An extra shows only while every one after it in the order does.
        const isInOrder = kept.every((isShown, i) => !isShown || kept.slice(i).every(Boolean))
        expect(`${surface} ${reading}% ${columns}: ${kept.join(',')} ${isInOrder}`).toBe(`${surface} ${reading}% ${columns}: ${kept.join(',')} true`)
        expect(`${surface} ${reading}% ${columns} compact ${hasCompact}`).toBe(`${surface} ${reading}% ${columns} compact true`)
        seen.add(kept.join(','))
      }

      // Wide enough for everything, narrow enough for none, and each step between.
      expect(`${surface} ${reading}% ${[...seen].join(' | ')}`).toBe(`${surface} ${reading}% true,true,true | false,true,true | false,false,true | false,false,false`)
    }
  }
})

test('at 75% on a ~120 column terminal the rings, kept extras and the Compact controls fit the row', async ($, on) => {
  const columns = 120
  const { draw } = await bandWith($, on, args => fullUsage(75, args))
  const { width, hasCompact } = await draw('desktop', columns)
  // The gap, then the nudge and the 'Compact now' button, as the band reserves them.
  const controls = 2 + ('Compact now'.length + 6 + 2) + ('Context is 75% full'.length + 2)
  // A column no narrower than the cards' calibrated 6.4px, so the row fits at any code font from there up.
  const px = 6.4

  expect(hasCompact).toBe(true)
  expect(width).toBeGreaterThan(0)
  expect(width + controls * px).toBeLessThanOrEqual(columns * px)
})

test('the band lays out across all of bodyColumns, which already leave the engine its [-]', async ($, on) => {
  const { draw } = await bandWith($, on, args => fullUsage(48, args))
  const { width } = await draw('desktop')
  // Just the room for the whole image and the gap after it.
  const { source, text } = await draw('desktop', Math.ceil(width / 6.4) + 2)

  expect(source).toContain('class="part"')
  expect(text).not.toContain('paddingRight')
})

test('with the band off, a usage reading asks for no breakdown', async ($, on) => {
  const asked: (string | undefined)[] = []
  mock.clock(on, { now: NOON })
  on('session.cwd', () => ({ value: '/work' }))
  on('store.get', ($, e) => ({ value: e.key === 'prefs' ? { skin: 'tokyo-night', band: false } : undefined }))
  on('env.get', () => ({ value: undefined }))
  on('config.list', () => ({ value: [] }))
  on('session.usage', ($, e) => {
    asked.push(e.breakdown)
    return { value: fullUsage(48, e) as never }
  })
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: { command: 'skin' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__skins__design' } }))
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })

  expect(asked).toEqual([undefined])
})

test('a new session, or the band turned off, stops the band waking at midnight to relabel its reset', { timeoutMs: 30_000 }, async ($, on) => {
  // A minute to Friday midnight, the 7d window resetting two minutes into Saturday.
  const clock = mock.clock(on, { now: new Date(2026, 9, 9, 23, 59).getTime() })
  const writes: string[] = []
  on('state.set', ($, e, next) => {
    writes.push(e.key)
    return next(e)
  })
  on('session.cwd', () => ({ value: '/work' }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('env.get', () => ({ value: undefined }))
  on('config.list', () => ({ value: [] }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.render', () => STOCK)
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000, percent: 40 }, rateLimits: [{ kind: 'seven_day', percentUsed: 23, resetsAt: new Date(2026, 9, 10, 0, 2).toISOString() }] },
  }))
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: { command: 'skin' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__skins__design' } }))
  const start = () => $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  const wakes = async (ms: number) => {
    writes.length = 0
    await clock.advance(ms)
    return writes.filter(key => key === 'usage').length
  }

  await start()
  const first = await $.ui.mount(BAND('desktop', false))
  // Its rings settle.
  await clock.advance(1200)
  await first.unmount()
  await start()
  // Past midnight.
  expect(await wakes(90_000)).toBe(0)

  const second = await $.ui.mount(BAND('desktop', false))
  await runSkin($, 'band off')
  expect(JSON.stringify(await second.drawn())).toContain('stock row')
  // Past the reset.
  expect(await wakes(120_000)).toBe(0)
  await second.unmount()
})

test('the extras redraw as the same image at the same readings, hold still under Reduce motion', async ($, on) => {
  const { draw } = await bandWith($, on, args => fullUsage(48, args), true)
  const first = (await draw('desktop')).source

  expect(first).toContain('class="part"')
  expect(first).not.toContain('@keyframes part')
  expect((await draw('desktop')).source).toBe(first)
  expect(first.split('@media (prefers-reduced-motion:reduce){*{animation:none!important}}').join('')).toContain('*{animation:none!important}')
})

test('the selected skin is published for other mods’ panels, and follows /skin and the light theme', async ($, on) => {
  stubEngine(on)
  let theme = 'dark'
  on('config.list', () => ({ value: [{ key: 'theme', label: 'Theme', kind: 'enum', value: theme, provider: { kind: 'engine' }, isLocked: false }] as never }))
  on('config.set', ($, e) => ((theme = String(e.value)), { value: e.value }) as never)
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: { command: 'skin' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__skins__design' } }))
  // Each write redraws other mods' readers, so it is written only when it changes.
  const writes: unknown[] = []
  on('state.set', ($, e, next) => {
    if (e.plugin === 'skins' && e.key === 'theme') writes.push(e.value)
    return next(e)
  })
  const published = async () => writes.at(-1) as Record<string, string> | null | undefined

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect((await published())?.foreground).toBeDefined()

  await runSkin($, 'tokyo-night')
  await runSkin($, 'rail off')
  expect(writes).toHaveLength(2)
  expect(await published()).toEqual({
    mode: 'dark',
    accent: '#7aa2f7',
    foreground: '#c0caf5',
    dim: '#878daf',
    red: '#f7768e',
    selection: '#364366',
    background: '#1f2335',
  })

  await $.config.set({ key: 'theme', value: 'light', previous: 'dark', provider: { kind: 'engine' }, origin: { kind: 'composer' } } as never)
  expect(await published()).toMatchObject({ mode: 'light', foreground: '#1f1f1f', selection: '#d0d6e1', background: '#ffffff' })

  await runSkin($, 'off')
  expect(await published()).toBeNull()
})

// The desktop builds an Svg again as a new image on every redraw, which starts its loop over;
// a Client under one key is kept and draws again only on new props.
type ClientNode = { type: string; key?: string; props: { key?: string; module?: string; width?: unknown; height?: unknown; props?: { source?: string; width?: number } } }
const clientsOf = async (ui: { findAll: (q: { type: string }) => Promise<unknown[]> }) => (await ui.findAll({ type: 'Client' })) as ClientNode[]
const keyOf = (node: ClientNode) => node.props.key ?? node.key

// Shell calls that run until released, started as the engine starts them: each resolves
// once the call reaches the tool, past every plugin's hook, and again once it has ended.
function heldCalls($: Engine, on: On) {
  const reached = new Map<string, () => void>()
  const release = new Map<string, () => void>()
  const ended = new Map<string, Promise<unknown>>()
  on('tool.call', { tool: 'Bash' }, ($, e) =>
    new Promise(resolve => {
      release.set(e.tool_use_id, () => resolve({ result: { stdout: '', stderr: '', interrupted: false } } as never))
      reached.get(e.tool_use_id)?.()
    }),
  )
  return {
    // `agentId`: a subagent's call, which has no row on the main transcript.
    start: (id: string, agentId?: string) =>
      new Promise<void>(resolve => {
        reached.set(id, resolve)
        ended.set(id, $.tool.call({ tool: 'Bash', command: 'sleep 9', tool_use_id: id, ...(agentId === undefined ? {} : { agentId }) } as never))
      }),
    finish: async (id: string) => {
      release.get(id)?.()
      await ended.get(id)
    },
  }
}

async function liveDesktop($: Engine, on: On, reduces = false, ownUsage = false) {
  const clock = stubEngine(on, { usage: ownUsage })
  on('config.list', () => ({ value: [{ key: 'reduceMotion', label: 'Reduce motion', kind: 'boolean', value: reduces, provider: { kind: 'engine' }, isLocked: false }] as never }))
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: { command: 'skin' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__skins__design' } }))
  const calls = heldCalls($, on)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  return { clock, calls }
}

const spinnerAt = (surface: (typeof SURFACES)[number]) =>
  ({ ...SITE, surface, component: 'Spinner', requestId: 'main', props: { word: 'Sauteing', message: null, suffix: '…', mode: 'tool-use' } }) as const

const runningRow = (id: string, surface: (typeof SURFACES)[number] = 'desktop') => toolUse(call('Bash', { command: 'sleep 9' }, { tool_use_id: id, isRunning: true }), surface)

// Every Client a drawing holds, as plain data, and what each one's module draws.
async function clientsDrawn($: Engine, element: Parameters<Engine['ui']['mount']>[0]) {
  const ui = await $.ui.mount(element)
  const clients = await clientsOf(ui)
  const drawn = await Promise.all(clients.map(node => ui.drawn({ in: keyOf(node) ?? '' })))
  const svgs = await svgsOf(ui)
  await ui.unmount()
  return { clients, drawn, svgs }
}

test('desktop loops are Clients under a stable key at their drawing\u2019s size, their props byte-identical across redraws', async ($, on) => {
  let reads = 0
  on('session.usage', () => {
    reads += 1
    return { value: { startedAt: 0, context: { window: 200000, percent: 42 }, rateLimits: [{ kind: 'five_hour', percentUsed: 18 }] } }
  })
  on('session.measure', () => ({ changed: ['context'] }) as never)
  const { clock, calls } = await liveDesktop($, on, false, true)
  await calls.start('run-1')
  const draw = async () => [await clientsDrawn($, runningRow('run-1')), await clientsDrawn($, spinnerAt('desktop')), await clientsDrawn($, BAND('desktop', true))] as const

  // The band's ring grows in, then settles.
  await draw()
  await clock.advance(1500)
  const [row, spinner, band] = await draw()
  for (const [found, key] of [
    [row, 'loop-run-1'],
    [spinner, 'loop-spinner'],
    [band, 'loop-ring-0'],
  ] as const) {
    expect(found.clients.map(keyOf)).toEqual([key])
    const [client] = found.clients
    expect(client?.props.module).toBe('hooks/anim.tsx')
    // A fixed size, so the region never resizes and the desktop never draws it again for that.
    expect(client?.props.width).toBeGreaterThan(0)
    expect(client?.props.height).toBeGreaterThan(0)
    // The module draws the looping image itself.
    expect(found.drawn[0]).toMatchObject({ type: 'Svg', props: { source: client?.props.props?.source } })
    expect(client?.props.props?.source).toContain(' infinite')
  }
  expect(row.clients[0]?.props.props?.source).toContain('class="spin"')

  // The clock moves on, another call starts and ends, the same usage reading lands again.
  await clock.advance(1370)
  await calls.start('other')
  await calls.finish('other')
  const before = reads
  await $.session.measure({ context: { window: 200000, percent: 42 }, rateLimits: [], changed: ['context'] } as never)
  expect(reads).toBeGreaterThan(before)
  const later = await draw()
  expect(JSON.stringify(later.map(found => found.clients))).toBe(JSON.stringify([row, spinner, band].map(found => found.clients)))
})

test('every loop moves: the spinner, each running row and the band\u2019s ring', async ($, on) => {
  const { calls } = await liveDesktop($, on)
  const ids = ['r1', 'r2', 'r3', 'r4', 'r5']
  for (const id of ids) await calls.start(id)

  for (const id of ids) expect((await clientsDrawn($, runningRow(id))).clients.map(keyOf)).toEqual([`loop-${id}`])
  expect((await clientsDrawn($, spinnerAt('desktop'))).clients.map(keyOf)).toEqual(['loop-spinner'])
  expect((await clientsDrawn($, BAND('desktop', true))).clients.map(keyOf)).toEqual(['loop-ring-0'])
})

test('two 7-day rings that both move take a key each', async ($, on) => {
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200000 },
      rateLimits: [
        { kind: 'seven_day', percentUsed: 85 },
        { kind: 'seven_day_opus', percentUsed: 88 },
      ],
    },
  }))
  await liveDesktop($, on, false, true)

  const keys = (await clientsDrawn($, BAND('desktop', false))).clients.map(keyOf)
  expect(keys.length).toBe(2)
  expect(new Set(keys).size).toBe(2)
})

test('a folded group keeps its Client while any of its calls runs', async ($, on) => {
  const { calls } = await liveDesktop($, on)
  await calls.start('g1')
  await calls.start('g2')
  const group = {
    ...SITE,
    surface: 'desktop',
    component: 'ToolGroup',
    requestId: 'g-keep',
    props: {
      calls: [call('Bash', { command: 'sleep 9' }, { tool_use_id: 'g1', isRunning: true }), call('Bash', { command: 'sleep 9' }, { tool_use_id: 'g2', isRunning: true })],
      isActive: true,
      isExpanded: false,
    },
  } as const

  const before = (await clientsDrawn($, group)).clients.map(keyOf)
  await calls.finish('g1')
  expect((await clientsDrawn($, group)).clients.map(keyOf)).toEqual(before)
})

test('Reduce motion draws no loop: no Client, every image held', async ($, on) => {
  const { calls } = await liveDesktop($, on, true)
  await calls.start('rm-1')
  const holdsStill = (source: string) =>
    source.split('@media (prefers-reduced-motion:reduce){*{animation:none!important}}').join('').includes('*{animation:none!important}')

  for (const element of [runningRow('rm-1'), spinnerAt('desktop'), BAND('desktop', false)]) {
    const found = await clientsDrawn($, element)
    expect(found.clients).toEqual([])
    const looping = found.svgs.filter(svg => svg.source.includes(' infinite'))
    expect(looping.length).toBeGreaterThan(0)
    for (const svg of looping) expect(holdsStill(svg.source)).toBe(true)
  }
})

test('the terminal draws no Client: its rows, spinner and band stay text', async ($, on) => {
  const { calls } = await liveDesktop($, on)
  await calls.start('t-1')

  for (const element of [runningRow('t-1', 'terminal'), spinnerAt('terminal'), BAND('terminal', true)]) {
    const ui = await $.ui.mount(element)
    expect(await clientsOf(ui)).toEqual([])
    expect(await ui.findAll({ type: 'Svg' })).toEqual([])
    await ui.unmount()
  }
  const row = await $.ui.mount(runningRow('t-1', 'terminal'))
  expect(await row.find({ type: 'Text', text: /○─ Bash {2}sleep 9/ })).toBeDefined()
})

test('a still icon on the desktop is drawn bare, in its row, with no box sized for it', async ($, on) => {
  await liveDesktop($, on)
  type Node = { type?: string; props?: Record<string, unknown>; children?: readonly unknown[] }
  // The element each Svg sits in.
  const parentsOfSvgs = async (element: Parameters<Engine['ui']['mount']>[0]) => {
    const ui = await $.ui.mount(element)
    const parents: Node[] = []
    const walk = (node: unknown): void => {
      const el = (typeof node === 'object' && node !== null ? node : {}) as Node
      for (const child of el.children ?? []) {
        if ((child as Node)?.type === 'Svg') parents.push(el)
        walk(child)
      }
    }
    walk(await ui.drawn())
    await ui.unmount()
    return parents
  }

  const [parent] = await parentsOfSvgs(toolUse(call('Bash', { command: 'pnpm test' }), 'desktop'))
  expect(parent?.props?.flexDirection).toBe('row')
  expect(parent?.props?.width).toBeUndefined()
})
