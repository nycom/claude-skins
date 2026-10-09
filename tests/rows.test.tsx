import type { On, RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { widthOf } from '../hooks/markdown'
import { PX_PER_COLUMN } from '../hooks/svg-kit'
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
function stubEngine(on: On, own: { env?: boolean; store?: boolean } = {}) {
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
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: 42 }, rateLimits: [{ kind: 'five_hour', percentUsed: 18 }] } }))
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
  const spinning = (await running.find({ type: 'Svg' })) as { props: { source: string } } | undefined
  expect(spinning?.props.source).toContain('class="spin"')
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
  const icon = (await desktop.find({ type: 'Svg' })) as { props: { source: string } } | undefined
  expect(icon?.props.source).toContain('class="bar')
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

test('the desktop draws a table as an animated vector card, with a tooltip on a cut cell', async ($, on) => {
  stubEngine(on)

  const text = `| Skin | Accent | Note |
|---|---|---|
| dracula | #bd93f9 | ${'a very long note '.repeat(30)} |
| x<y | +18 −3 | ok |`
  const ui = await $.ui.mount({
    ...SITE,
    surface: 'desktop',
    component: 'AssistantMessage',
    requestId: 'r3',
    props: { text, isFirstOfReply: true },
  })
  const svg = (await ui.find({ type: 'Svg' })) as { props: { source: string; isInteractive?: boolean; alt: string } } | undefined

  expect(svg?.props.isInteractive).toBeUndefined()
  expect(svg?.props.source).toContain('class="row"')
  expect(svg?.props.source).toContain('<circle')
  expect(svg?.props.source).toContain('x&lt;y')
  expect(svg?.props.alt).toContain('Skin | Accent | Note')
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

test('the band sits last, nearest the prompt, below another mod’s row', async ($, on) => {
  // Registered first, so it is what the skin's hook reaches when it hands the band on.
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', props: {}, children: ['PROGRESS'] }))
  stubEngine(on)
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: { command: 'skin' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__skins__design' } }))

  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })

  for (const surface of SURFACES) {
    const band = await $.ui.mount(BAND(surface, false))
    const column = (await band.drawn()) as { children: readonly unknown[] }
    const first = JSON.stringify(column.children[0])
    const last = JSON.stringify(column.children[column.children.length - 1])

    expect(first).toContain('PROGRESS')
    expect(last).not.toContain('PROGRESS')
    expect(last).toContain(surface === 'desktop' ? 'Svg' : '% context')
    await band.unmount()
  }
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
  const moving = await $.ui.mount(toolUse(call('Bash', { command: 'sleep 9' }, { tool_use_id: 'rm3', isRunning: true }), 'desktop'))
  expect(holdsStill(((await moving.find({ type: 'Svg' })) as { props: { source: string } } | undefined)?.props.source)).toBe(false)
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
  const table = await $.ui.mount({ ...SITE, surface: 'desktop', component: 'AssistantMessage', requestId: 'once-tb', props: { text: '| A | B |\n| --- | --- |\n| 1 | 2 |' } as never })
  expect(await sourceOf(shell)).not.toContain(held)
  expect(await sourceOf(table)).not.toContain(held)

  // Any write the cards read (here a theme switch) draws them again: the rows must not rise in a second time.
  await $.config.set({ key: 'theme', value: 'light', previous: 'dark', provider: { kind: 'engine' }, origin: { kind: 'composer' } } as never)
  expect(await sourceOf(shell)).toContain(held)
  expect(await sourceOf(table)).toContain(held)
  await shell.unmount()
  await table.unmount()
})

test('a table that grows while its reply streams: only the rows new since the last draw rise in', async ($, on) => {
  stubEngine(on)
  const draw = async (rows: string[]) => {
    const ui = await $.ui.mount({ ...SITE, surface: 'desktop', component: 'AssistantMessage', requestId: 'grow-tb', props: { text: ['| A | B |', '| --- | --- |', ...rows].join('\n') } as never })
    const source = ((await ui.find({ type: 'Svg' })) as { props: { source: string } } | undefined)?.props.source ?? ''
    await ui.unmount()
    return source
  }
  // Each row's group, in order, with the text of its cells.
  const rowsOf = (source: string) => [...source.matchAll(/<g class="(row[^"]*)" style="animation-delay:(\d+)ms">(.*?)<\/g><\/g>/g)].map(([, cls, delay, body]) => ({ cls, delay, text: [...(body ?? '').matchAll(/>([^<]+)<\/text>/g)].map(m => m[1]).join(' ') }))
  const all = ['| 1 | 2 |', '| 3 | four |', '| 5 | 6 |', '| 7 | 8 |']

  // The last row is still streaming: drawn half-written, then finished on the next draw.
  expect(await draw(['| 1 | 2 |', '| 3 | fo'])).not.toContain('*{animation:none!important}</style>')

  const grown = await draw(all)
  const rows = rowsOf(grown)
  expect(rows.map(row => [row.cls, row.text])).toEqual([['row', '1 2'], ['row', '3 four'], ['row fresh', '5 6'], ['row fresh', '7 8']])
  // The new rows start their stagger at once; everything but them, header and rule included, holds still.
  expect(rows[2]?.delay).toBe('120')
  expect(grown).toContain(':not(.fresh){animation:none!important}')
  expect(grown).not.toContain('*{animation:none!important}</style>')

  const again = await draw(all)
  expect(again).toContain('*{animation:none!important}</style>')
  expect(again).not.toContain('fresh')
})

test('a reply whose table gives its place to text on a redraw still draws', async ($, on) => {
  stubEngine(on)
  const reply = (text: string) => ({ ...SITE, surface: 'desktop', component: 'AssistantMessage', requestId: 'swap-tb', props: { text } as never }) as const
  const table = '| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |'

  await (await $.ui.mount(reply(table))).unmount()
  const swapped = await $.ui.mount(reply(`Intro\n\n${table}`))
  expect(await swapped.find({ type: 'Svg' })).toBeDefined()
  await swapped.unmount()
})

test('a table that moves to another segment keeps its rows held; only the new row rises in', async ($, on) => {
  stubEngine(on)
  const reply = (text: string) => ({ ...SITE, surface: 'desktop', component: 'AssistantMessage', requestId: 'shift-tb', props: { text } as never }) as const
  const table = (rows: string[]) => ['| A | B |', '| --- | --- |', ...rows].join('\n')
  const draw = async (text: string) => {
    const ui = await $.ui.mount(reply(text))
    const source = ((await ui.find({ type: 'Svg' })) as { props: { source: string } } | undefined)?.props.source ?? ''
    await ui.unmount()
    return [...source.matchAll(/<g class="(row[^"]*)" style="animation-delay:\d+ms">(.*?)<\/g><\/g>/g)].map(([, cls, body]) => [cls, [...(body ?? '').matchAll(/>([^<]+)<\/text>/g)].map(m => m[1]).join(' ')])
  }

  // A closed code block sits before the table, then goes: the table moves from segment 2 to segment 1.
  await draw(`Intro\n\n\`\`\`js\nx\n\`\`\`\n\n${table(['| 1 | 2 |', '| 3 | 4 |'])}`)
  const grown = await draw(`Intro\n\n${table(['| 1 | 2 |', '| 3 | 4 |', '| 5 | 6 |'])}`)
  expect(grown.filter(([cls]) => cls === 'row fresh')).toEqual([['row fresh', '5 6']])
})

test('the terminal drawing a reply first does not hold the desktop’s first draw still', async ($, on) => {
  stubEngine(on)
  const reply = (surface: (typeof SURFACES)[number]) =>
    ({ ...SITE, surface, component: 'AssistantMessage', requestId: 'both-tb', props: { text: '| A | B |\n| --- | --- |\n| 1 | 2 |' } as never }) as const

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
    ({ ...SITE, surface, component: 'AssistantMessage', requestId: 'surf-tb', props: { text: '| A | B |\n| --- | --- |\n| 1 | 2 |' } as never }) as const

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
const svgOf = async (ui: { find: (q: { type: string }) => Promise<unknown> }) =>
  ((await ui.find({ type: 'Svg' })) as { props: { source: string; width: number } } | undefined)?.props ?? { source: '', width: 0 }
// Every text a card draws, its lines joined by spaces.
const drawnText = (source: string) => [...source.matchAll(/>([^<>]+)</g)].map(m => m[1]).join(' ')

test('a desktop table card spans its columns: Copy sits under the card, not in a column of its own', async ($, on) => {
  stubEngine(on)
  const copied: string[] = []
  on('ui.copy', ($, e) => (copied.push(e.text), { value: { isCopied: true } }))
  const ui = await $.ui.mount(desktopReply('span-tb', '| Client | Where |\n| --- | --- |\n| Robot | Pi |'))
  const { source, width } = await svgOf(ui)
  type Node = { props?: Record<string, unknown>; children?: readonly unknown[] }
  const overlays = (node: unknown): number =>
    typeof node !== 'object' || node === null ? 0 : ((node as Node).props?.position === 'absolute' ? 1 : 0) + ((node as Node).children ?? []).reduce<number>((sum, child) => sum + overlays(child), 0)

  // The header's rule runs the card's full width, less its padding: no slot kept free for Copy.
  expect(source).toContain(`class="rule" x1="24" y1="57" x2="${width - 24}"`)
  expect(overlays(await ui.find({ type: 'Box' }))).toBe(0)
  await ui.press({ key: 'copy-0' })
  expect(copied).toEqual(['| Client | Where |\n| --- | --- |\n| Robot | Pi |'])
  await ui.unmount()
})

test('a desktop table card draws long headers and cells in full, wrapping instead of cutting', async ($, on) => {
  stubEngine(on)
  const long = 'Yes, systemd brings it back (its README says so, and the unit restarts it on failure with a five second backoff, which held when the process was killed twice and came back each time without help)'
  const text = `| Client | Where | Survives a restart |\n| --- | --- | --- |\n| Robot | the Pi under /home/user | ${long} |\n| WEB | Cloud Run | ${long} ${long} |\n| Server | NAS | no |`
  const ui = await $.ui.mount(desktopReply('full-tb', text))
  const { source } = await svgOf(ui)
  const words = drawnText(source).split(/\s+/)

  expect(source).not.toContain('…')
  for (const word of ['CLIENT', 'WHERE', 'SURVIVES', 'A', 'RESTART', ...long.split(' ')]) {
    expect(words).toContain(word)
  }
  await ui.unmount()
})

test('a link in a desktop table cell is drawn as its text and pressable as a link', async ($, on) => {
  stubEngine(on)
  const ui = await $.ui.mount(desktopReply('link-tb', '| Client | Docs |\n| --- | --- |\n| Robot | see [README](https://github.com/nycom/orion#readme) first |'))
  const { source } = await svgOf(ui)
  const link = (await ui.find({ type: 'Link' })) as { props: { href: string; label?: string } } | undefined

  expect(link?.props).toEqual({ href: 'https://github.com/nycom/orion#readme', label: 'README' })
  expect(source).not.toContain('](')
  expect(source).toContain('class="link">README</tspan>')
  await ui.unmount()
})

test('a table scrolled back into view does not rise in again, whatever request draws it', async ($, on) => {
  const clock = stubEngine(on)
  const text = '| Client | Where |\n| --- | --- |\n| Robot | Pi |\n| Server | NAS |'
  const held = '*{animation:none!important}</style>'

  // The engine keeps a drawing's answer and replays it when the row mounts again: once its
  // rows have risen, the answer it keeps must be the still one.
  const first = await $.ui.mount(desktopReply('scroll-a', text))
  expect((await svgOf(first)).source).not.toContain(held)
  await clock.advance(1500)
  expect((await svgOf(first)).source).toContain(held)
  await first.unmount()

  // A mount under a new request id draws the same table, already seen, still.
  const again = await $.ui.mount(desktopReply('scroll-b', text))
  expect((await svgOf(again)).source).toContain(held)
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
  const ring = async () => {
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    const band = await $.ui.mount(BAND('desktop', false))
    const source = ((await band.find({ type: 'Svg' })) as { props: { source: string } } | undefined)?.props.source ?? ''
    await band.unmount()
    return source
  }

  const first = await ring()
  expect(first).toContain('@keyframes fill0{')
  expect(first).toContain('@keyframes fill1{')
  percent = 55
  const moved = await ring()
  expect(moved).toContain('@keyframes fill0{')
  expect(moved).not.toContain('fill1')
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
    const source = ((await band.find({ type: 'Svg' })) as { props: { source: string } } | undefined)?.props.source ?? ''
    await band.unmount()
    return source
  }
  const circumference = 2 * Math.PI * 8

  expect(await ring()).toContain('@keyframes fill0{from{stroke-dasharray:0 ')
  percent = 55
  const grown = await ring()
  expect(grown).toContain(`@keyframes fill0{from{stroke-dasharray:${(circumference * 40) / 100} `)
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
  const source = async () => ((await band.find({ type: 'Svg' })) as { props: { source: string } } | undefined)?.props.source ?? ''

  expect(await source()).toContain('@keyframes fill')
  await clock.advance(1200)
  expect(await source()).toContain('<svg')
  expect(await source()).not.toContain('@keyframes fill')
  await band.unmount()
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
    const source = ((await band.find({ type: 'Svg' })) as { props: { source: string } } | undefined)?.props.source ?? ''
    await band.unmount()
    return source
  }
  const held = (source: string) => source.split('@media (prefers-reduced-motion:reduce){*{animation:none!important}}').join('').includes('*{animation:none!important}')

  expect(await ring()).toMatch(/animation:jog\d+ 3s ease-in-out/)
  percent = 72
  const nudged = await ring()
  expect(nudged).toMatch(/@keyframes jog\d+\{/)
  expect(nudged).toMatch(/animation:jog\d+ 2.4s ease-in-out/)
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
    const source = ((await band.find({ type: 'Svg' })) as { props: { source: string } } | undefined)?.props.source
    const text = JSON.stringify(await band.drawn())
    const width = ((await band.find({ type: 'Svg' })) as { props: { width: number } } | undefined)?.props.width ?? 0
    const hasCompact = (await band.find({ key: 'compact' })) !== undefined
    await band.unmount()
    return { source: source ?? '', text, hasCompact, width }
  }

  return { draw, asked }
}

test('the band shows tokens on the context ring, resets on the plan rings, and the context breakdown', async ($, on) => {
  const { draw, asked } = await bandWith($, on, args => fullUsage(48, args))
  const { source } = await draw('desktop')

  // The breakdown is the local estimate, never the counted one that sends requests.
  expect(asked).toEqual(['summary'])
  expect(source).toContain('96k/200k')
  expect(source).toContain('2:40pm')
  expect(source).toContain('Mon')
  expect(source).toContain('msgs 61%')
  expect(source).toContain('tools 22%')
  expect(source).toContain('sys 9%')
  // Only the top three are named; free space, the buffer and deferred tools are not content.
  expect(source).not.toContain('memory 8%')
  expect(source).not.toContain('Free')
  const palette = tokyoNight.palette
  expect(source).toContain(`class="part" x="`)
  for (const slot of ['user', 'run', 'read', 'write'] as const) {
    expect(source).toContain(`fill="${palette[slot]}"`)
  }

  const terminal = await draw('terminal')
  expect(terminal.text).toContain('48% context · 96k/200k')
  expect(terminal.text).toContain('19% 5h · 2:40pm')
  expect(terminal.text).toContain('23% 7d · Mon')
  expect(terminal.text).toContain('■')
  expect(terminal.text).toContain('msgs 61%')
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

test('a narrow band drops the breakdown labels, then the bar, then the resets, then the tokens, and keeps Compact', { timeoutMs: 30_000 }, async ($, on) => {
  let percent = 55
  const { draw } = await bandWith($, on, args => fullUsage(percent, args))
  const order = ['labels', 'bar', 'resets', 'tokens'] as const

  for (const reading of [55, 85]) {
    percent = reading
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })

    for (const surface of SURFACES) {
      const seen = new Set<string>()

      for (let columns = 220; columns >= 20; columns -= 4) {
        const { source, text, hasCompact } = await draw(surface, columns)
        const drawn = surface === 'desktop' ? source : text
        const shows = {
          labels: drawn.includes('msgs 61%'),
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
      expect(`${surface} ${reading}% ${[...seen].join(' | ')}`).toBe(`${surface} ${reading}% true,true,true,true | false,true,true,true | false,false,true,true | false,false,false,true | false,false,false,false`)
    }
  }
})

test('at 75% on a ~120 column terminal the rings, kept extras and the Compact controls fit the row', async ($, on) => {
  const columns = 120
  const { draw } = await bandWith($, on, args => fullUsage(75, args))
  const { width, hasCompact } = await draw('desktop', columns)
  // The row's padding and gap, then the nudge and the 'Compact now' button, as the band reserves them.
  const controls = 5 + 2 + ('Compact now'.length + 6 + 2) + ('Context is 75% full'.length + 2)

  expect(hasCompact).toBe(true)
  expect(width).toBeGreaterThan(0)
  expect(width + controls * PX_PER_COLUMN).toBeLessThanOrEqual(columns * PX_PER_COLUMN)
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
    muted: '#878daf',
    red: '#f7768e',
    selection: '#364366',
    background: '#1f2335',
  })

  await $.config.set({ key: 'theme', value: 'light', previous: 'dark', provider: { kind: 'engine' }, origin: { kind: 'composer' } } as never)
  expect(await published()).toMatchObject({ mode: 'light', foreground: '#1f1f1f', selection: '#d0d6e1', background: '#ffffff' })

  await runSkin($, 'off')
  expect(await published()).toBeNull()
})
