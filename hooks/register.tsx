import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface, Timer } from 'claude-code'

import type { CustomSkin, PanelTheme, Prefs, SkinSlot, TurnStats, UsageSnap } from '../types'
import { DEFAULT_PREFS, parsePrefs, runSkinCommand, TOGGLES } from './command'
import { buildCustom, resolveSkin, skinNames, withSlot } from './custom'
import { forTheme, mix, resolveLight } from './light'
import { parseFolders, prefsFor, withFolder, withoutFolder } from './folders'
import { DESIGN_TOOL, runDesign } from './designer'
import type { DesignState } from './designer'
import { clipLines, diffstat, pick } from './format'
import { splitReply } from './markdown'
import type { Segment } from './markdown'
import { askBand, desktopSpinnerRow, diffCard, footerRow, terminalCard, usageBand, groupRow, promptRow, replyRows, spinnerRow, toolRow } from './rows'
import type { ClientElement, Look, SvgElement, Ui } from './rows'
import { galleryPane } from './gallery'
import { settingsPane } from './settings'
import { ICONS } from './skin'
import type { Skin } from './skin'
import { hunksOf } from './svg-diff'
import { shellOutputOf } from './svg-terminal'
import { limitLabel, metersOf, partsOf, rampFrom, SETTLE_MS } from './svg-usage'
import { shortenPath } from './format'
import { drawOnce, holdStill } from './svg-kit'
import { kindOf, summarize } from './tools'

const SETTINGS = 'skins-settings'
const GALLERY = 'skins-gallery'
const DESIGN = `mcp__skins__${DESIGN_TOOL.name}`
const DESIGN_MATCH = /^mcp__skins__design$/

// Markdown takes at most 10000 characters a block; a longer prompt keeps Claude Code's
// own drawing, which folds a big paste.
const MAX_MARKDOWN = 9000
const MAX_PROMPT = 4000

const CLIP_HEAD = 8
const CLIP_TAIL = 4
const FRAME_MS = 90
const KEPT_TURNS = 40
// ponytail: an `auto` theme asks the system again this often (drawing cannot write state,
// so a timer does it), so a mid-session appearance flip shows within a minute; a watcher
// on the OS's appearance notification would make it instant.
const THEME_TTL_MS = 60_000

const prefsAtom = atom({ plugin: 'skins', key: 'prefs' } as const, DEFAULT_PREFS)
const customAtom = atom({ plugin: 'skins', key: 'custom' } as const, {})
const startedAtom = atom({ plugin: 'skins', key: 'startedAt' } as const, 0)
const frameAtom = atom({ plugin: 'skins', key: 'frame' } as const, 0)
const turnsAtom = atom({ plugin: 'skins', key: 'turns' } as const, {})
const durationAtom = atom({ plugin: 'skins', key: 'duration' } as const, -1)
const editingAtom = atom({ plugin: 'skins', key: 'editing' } as const, 'user' as SkinSlot)
const lightAtom = atom({ plugin: 'skins', key: 'isLight' } as const, false)
const imagesAtom = atom({ plugin: 'skins', key: 'images' } as const, false)
const usageAtom = atom({ plugin: 'skins', key: 'usage' } as const, { context: null, limits: [] } as UsageSnap)
const compactingAtom = atom({ plugin: 'skins', key: 'compacting' } as const, false)
const pinnedAtom = atom({ plugin: 'skins', key: 'pinned' } as const, false)
const themeAtom = atom({ plugin: 'skins', key: 'theme' } as const, null as PanelTheme | null)
const settledAtom = atom({ plugin: 'skins', key: 'settled' } as const, 0)
// Per call, whether its icon may move; and how many calls' icons do.
const loopAtom = atom({ plugin: 'skins', key: 'loop' } as const, false)
const toolLoopsAtom = atom({ plugin: 'skins', key: 'toolLoops' } as const, 0)

// The animation budget: every looping image costs the desktop's main thread, so at most this
// many of the skin's move at once. The spinner always keeps one (it can show between turns, as
// for background tasks), the newest running calls take up to TOOL_LOOPS, and the band's rings
// what is left; the rest are drawn held.
const LOOP_BUDGET = 3
const TOOL_LOOPS = 2

const EDITS = new Set(['Edit', 'MultiEdit', 'Write'])

// Only a person's own typing becomes a prompt row: a task notification or a peer's
// message is not theirs to dress as theirs.
const TYPED = new Set(['composer', 'bridge', 'sdk'])

type Active = { prefs: Prefs; skin: Skin; custom: Record<string, CustomSkin> }

const NO_STATS: TurnStats = { tools: 0, added: 0, removed: 0 }

async function activeSkin($: EngineInterface): Promise<Active | null> {
  const prefs = await read($, prefsAtom)
  const custom = await read($, customAtom)
  const skin = resolveSkin(prefs.skin, custom)

  return skin === undefined ? null : { prefs, skin: forTheme(skin, await read($, lightAtom)), custom }
}

// The drawn skin's colours for other mods' panels. Skins draw on the host's background,
// so `surface` stands in for it; a quarter of the accent over it is a highlight body text
// still reads on (at least 5:1 for every built-in skin, light or dark). Each write redraws
// every reader, so only a change is written.
async function publishTheme($: EngineInterface): Promise<void> {
  const active = await activeSkin($)
  const p = active?.skin.palette
  const theme: PanelTheme | null =
    p === undefined
      ? null
      : {
          mode: (await read($, lightAtom)) ? 'light' : 'dark',
          accent: p.user,
          foreground: p.fg,
          dim: p.muted,
          muted: p.muted,
          red: p.err,
          selection: mix(p.surface, p.user, 0.25),
          background: p.surface,
        }

  if (JSON.stringify(await read($, themeAtom)) !== JSON.stringify(theme)) await update($, themeAtom, () => theme)
}

// The system's appearance, for an `auto` theme: macOS's AppleInterfaceStyle, else GNOME's
// color-scheme. Undefined when neither answers.
async function systemDark($: EngineInterface): Promise<boolean | undefined> {
  try {
    const mac = await $.process.run(['defaults', 'read', '-g', 'AppleInterfaceStyle'], { timeoutMs: 2000 })

    // Unset (exit 1, "does not exist") is how macOS says light.
    return mac.exitCode === 0 ? mac.stdout.trim() === 'Dark' : /does not exist/.test(mac.stderr) ? false : undefined
  } catch {}

  try {
    const gnome = await $.process.run(['gsettings', 'get', 'org.gnome.desktop.interface', 'color-scheme'], {
      timeoutMs: 2000,
    })

    return gnome.exitCode === 0 ? gnome.stdout.includes('dark') : undefined
  } catch {
    return undefined
  }
}

// Claude Code's own theme decides whether skins draw for a light or a dark background:
// `SKINS_THEME` first, then the theme setting, and for `auto` the terminal and the system.
// Says whether the system decided, so it is asked again later, and whether Claude Code's
// Reduce motion setting is on.
async function refreshTheme($: EngineInterface): Promise<{ followsSystem: boolean; reducesMotion: boolean }> {
  const rows = await $.config.list()
  const hints = {
    override: await $.env.get('SKINS_THEME'),
    theme: rows.find(row => row.key === 'theme')?.value,
    colorfgbg: await $.env.get('COLORFGBG'),
  }
  // Asks the system only when nothing before it decided.
  const needsSystem = resolveLight(hints) !== resolveLight({ ...hints, systemDark: false })
  const isLight = resolveLight({ ...hints, systemDark: needsSystem ? await systemDark($) : undefined })

  // Every write redraws every card that reads it, so the minute's poll writes only a change.
  if ((await read($, lightAtom)) !== isLight) await update($, lightAtom, () => isLight)
  await publishTheme($)

  return { followsSystem: needsSystem, reducesMotion: rows.find(row => row.key === 'reduceMotion')?.value === true }
}

// A row as one surface draws it: every attached surface runs the hook on its own, so one
// surface's draw says nothing about another's.
const drawKey = (e: { surface: RenderSurface; requestId?: string | undefined }): string | undefined =>
  e.requestId === undefined ? undefined : `${e.surface}:${e.requestId}`

// Each reply's segments as last drawn. A redraw holds the reply still, but a table that
// only gained rows, as one does while its reply streams, lets the new rows rise in.
// ponytail: keeps every reply with a table for the session; a reload clears it.
const shown = new Map<string, readonly Segment[]>()
// The cards each surface has drawn, a reply's by what they hold, a tool's by its call: one
// mounted again under a new request, as one scrolled back into view may be, draws still.
// ponytail: one entry per card shown for the session; a reload clears it.
const seenCards = new Set<string>()
// A tool's card is known by its call and kind, whatever request draws it; true once drawn.
const sawToolCard = (e: { surface: RenderSurface; props: { tool_use_id: string } }, kind: 'diff' | 'terminal'): boolean => {
  const card = `${e.surface}:${kind}:${e.props.tool_use_id}`
  const seen = seenCards.has(card)
  seenCards.add(card)
  return seen
}
const cardsOf = (surface: RenderSurface, segments: readonly Segment[]): string[] =>
  segments.filter(segment => segment.kind !== 'text').map(segment => `${surface}:${JSON.stringify(segment)}`)
const freshRows = (e: { surface: RenderSurface; requestId?: string | undefined }, segments: readonly Segment[]): (number | undefined)[] | undefined => {
  const key = drawKey(e)
  if (key === undefined) return undefined
  const last = shown.get(key)
  shown.set(key, segments)
  // A streaming reply's earlier draws are not cards anyone scrolls back to.
  for (const card of cardsOf(e.surface, last ?? [])) seenCards.delete(card)
  const cards = cardsOf(e.surface, segments)
  const isSeen = cards.every(card => seenCards.has(card))
  for (const card of cards) seenCards.add(card)
  if (last === undefined) return isSeen ? [] : undefined

  // A table is matched to the one at its own place among the reply's tables, so text or code
  // arriving ahead of it, which moves it to a later segment, does not make it new.
  const priorTables = last.filter(segment => segment.kind === 'table')
  let nth = 0
  return segments.map(segment => {
    if (segment.kind !== 'table') return undefined
    const prior = priorTables[nth++]
    const before = prior?.kind === 'table' ? prior.rows : []
    // The last row may have been drawn half-written and finished since, so it may differ.
    const kept = before.slice(0, -1).every((row, r) => row.join('\n') === segment.rows[r]?.join('\n'))
    return segment.rows.length > before.length && kept ? before.length : undefined
  })
}

// The band's rings grow from their last reading (see rampFrom); once they have grown, one
// more draw settles them.
const ramp = rampFrom()
let settle: { cancel(): void } | undefined
// A reset's label changes at local midnight (`tmrw` to today's time) and when it passes (to
// none); nothing else redraws the band then, so one timer wakes it at the sooner of the two.
let relabel: { at: number; timer: { cancel(): void } } | undefined
const stopRelabel = (): void => {
  relabel?.timer.cancel()
  relabel = undefined
}

// The engine keeps a reply's drawing and shows it again when the reply's row mounts again,
// as on a scroll back into view, which plays its animation again. So once its rows have
// risen, the reply is drawn once more, still, and that is the drawing kept.
const replySettles = new Map<string, { cancel(): void }>()
function settleReply($: EngineInterface, e: { surface: RenderSurface; requestId: string }): void {
  const key = `${e.surface}:${e.requestId}`
  replySettles.get(key)?.cancel()
  replySettles.set(
    key,
    $.clock.after(SETTLE_MS, () => {
      replySettles.delete(key)
      return update($, memberOf(settledAtom, e), n => n + 1)
    }),
  )
}

// What the settings said when last read.
type ConfigMemo = Awaited<ReturnType<typeof refreshTheme>>

async function readConfig($: EngineInterface, memo: ConfigMemo): Promise<void> {
  Object.assign(memo, await refreshTheme($))
  holdStill(memo.reducesMotion)
}

// Every surface's element table names Svg, but the terminal draws it as nothing, so
// vector icons are for the other surfaces only; loops move in a Client on the desktop's.
const lookOf = (
  ui: Ui & { Svg?: SvgElement; Client?: ClientElement },
  active: Active,
  surface: RenderSurface,
  copy?: (text: string) => void,
): Look => ({
  ui,
  skin: active.skin,
  icons: ICONS[active.prefs.icons],
  prefs: active.prefs,
  surface,
  ...(surface !== 'terminal' && ui.Svg !== undefined ? { svg: ui.Svg } : {}),
  ...(surface === 'desktop' && ui.Client !== undefined ? { client: ui.Client } : {}),
  ...(copy === undefined ? {} : { copy }),
})

// Made skins from the store, each checked again: the store may hold an older shape.
function parseCustom(raw: unknown): Record<string, CustomSkin> {
  const saved = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}

  return Object.fromEntries(
    Object.values(saved)
      .map(draft => buildCustom(draft as Record<string, unknown>, undefined))
      .filter((skin): skin is CustomSkin => typeof skin !== 'string')
      .map(skin => [skin.name, skin]),
  )
}

async function load($: EngineInterface): Promise<void> {
  const custom = parseCustom(await $.store.get('custom'))
  const names = skinNames(custom)
  const folders = parseFolders(await $.store.get('folders'), names)
  const folder = await $.session.cwd()
  const prefs = prefsFor(folder, folders, parsePrefs(await $.store.get('prefs'), names))

  await update($, customAtom, () => custom)
  await update($, prefsAtom, () => prefs)
  await update($, pinnedAtom, () => Object.hasOwn(folders, folder))
}

// A pinned folder keeps its prefs to itself; every other folder shares the default.
async function savePrefs($: EngineInterface, prefs: Prefs): Promise<void> {
  if (!(await read($, pinnedAtom))) {
    await $.store.set('prefs', prefs)

    return
  }

  const names = skinNames(await read($, customAtom))
  const folders = parseFolders(await $.store.get('folders'), names)
  await $.store.set('folders', withFolder(folders, await $.session.cwd(), prefs))
}

// /skin pin, unpin and share: this folder's own look, or the default.
async function runFolderCommand($: EngineInterface, word: string): Promise<string> {
  const folder = await $.session.cwd()
  const custom = await read($, customAtom)
  const names = skinNames(custom)
  const folders = parseFolders(await $.store.get('folders'), names)
  const prefs = await read($, prefsAtom)

  switch (word) {
    case 'pin':
      await $.store.set('folders', withFolder(folders, folder, prefs))
      await update($, pinnedAtom, () => true)

      return 'this folder keeps its own look'
    case 'unpin': {
      const fallback = parsePrefs(await $.store.get('prefs'), names)
      await $.store.set('folders', withoutFolder(folders, folder))
      await update($, pinnedAtom, () => false)
      await update($, prefsAtom, () => fallback)
      await publishTheme($)

      return `this folder follows the default: ${fallback.skin}`
    }
    default:
      await $.store.set('prefs', prefs)

      return `default look: ${prefs.skin}`
  }
}

// The breakdown is the local estimate, which sends no requests, asked only while the band
// draws; when it fails the band goes on without its bar.
async function refreshUsage($: EngineInterface): Promise<void> {
  const isBand = (await activeSkin($))?.prefs.band === true
  const usage = await (isBand ? $.session.usage({ breakdown: 'summary' }).catch(() => $.session.usage()) : $.session.usage())
  const categories = usage.context.breakdown?.categories
  const snap: UsageSnap = {
    context: usage.context.percent ?? null,
    window: usage.context.window,
    limits: usage.rateLimits.map(limit => ({ label: limitLabel(limit.kind), percent: limit.percentUsed, resetsAt: limit.resetsAt })),
    ...(usage.context.tokens === undefined ? {} : { tokens: usage.context.tokens }),
    ...(Array.isArray(categories)
      ? { parts: categories.filter(category => category.kind === 'used').map(category => ({ name: category.name, tokens: category.tokens })) }
      : {}),
  }

  await update($, usageAtom, () => snap)
}

async function commit($: EngineInterface, state: DesignState): Promise<void> {
  await update($, customAtom, () => state.custom)
  await update($, prefsAtom, () => state.prefs)
  await publishTheme($)
  await $.store.set('custom', state.custom)
  await savePrefs($, state.prefs)
}

// The main loop's calls running now, oldest first. A new session starts with none.
// ponytail: one list per plugin process, as the turn's stats are; per session if one process
// ever hosts several at once.
let running: readonly string[] = []

// Which calls' icons move changes only as a call starts or ends, never on a redraw.
async function setRunning($: EngineInterface, next: readonly string[]): Promise<void> {
  const was = new Set(running.slice(-TOOL_LOOPS))
  running = next
  const now = new Set(running.slice(-TOOL_LOOPS))

  for (const id of new Set([...was, ...now])) {
    if (was.has(id) !== now.has(id)) await update($, memberOf(loopAtom, { requestId: id }), () => now.has(id))
  }

  if (was.size !== now.size) await update($, toolLoopsAtom, () => now.size)
}

async function designState($: EngineInterface): Promise<DesignState> {
  return { prefs: await read($, prefsAtom), custom: await read($, customAtom) }
}

export const register: Register = on => {
  // What the turn on the main loop has done so far, for its footer.
  let stats: TurnStats = NO_STATS
  let isWorking = false
  let ticker: Timer | undefined
  // The width the last reply was drawn at, shown by /skin list to tune table sizing.
  let lastColumns: number | undefined
  const config: ConfigMemo = { followsSystem: false, reducesMotion: false }
  let themeTimer: Timer | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'skin',
      description: 'Open the skin settings, or /skin <name | list | off>',
      argumentHint: '[gallery | name | list | off | pin | unpin | share | rail | tables | shimmer | band | clip | icons]',
      immediate: true,
    })
    await $.tool.register({
      name: DESIGN_TOOL.name,
      description: DESIGN_TOOL.description,
      inputSchema: DESIGN_TOOL.inputSchema,
    })
    await load($)
    await refreshUsage($)
    await readConfig($, config)
    stopRelabel()
    await setRunning($, [])
    await update($, toolLoopsAtom, () => 0)

    // Only the spinner reads the frame, so a tick redraws the spinner and nothing else.
    ticker?.cancel()
    ticker = $.clock.every(FRAME_MS, () => {
      if (isWorking) {
        void update($, frameAtom, frame => frame + 1)
      }
    })
    // An `auto` theme follows the system's appearance as it changes mid-session.
    themeTimer?.cancel()
    // Returns the read, so the tick's dispatch lasts until the theme is settled.
    themeTimer = $.clock.every(THEME_TTL_MS, () => (config.followsSystem ? readConfig($, config) : undefined))

    return next(e)
  })

  // /clear, /resume and /branch reset $.state to its defaults and skip session.start.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    await load($)
    stopRelabel()
    await readConfig($, config)

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    stats = NO_STATS
    isWorking = true
    const now = await $.clock.now()
    await update($, startedAtom, () => now)

    return next(e)
  })

  on('config.set', async ($, e, next) => {
    const result = await next(e)

    if (e.key === 'theme' || e.key === 'reduceMotion') {
      await readConfig($, config)
    }

    return result
  })

  // Notes which prompts carried images, so their row keeps Claude Code's drawing of them.
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    const hasImage = e.door === 'prompt' && e.message.content.some(block => block.type === 'image')

    if (hasImage && stored.uuid !== undefined) {
      await update($, memberOf(imagesAtom, { requestId: stored.uuid }), () => true)
    }

    return stored
  })

  // A turn's end and a plan limit's move are when the band's numbers change.
  on('session.measure', async ($, e, next) => {
    await refreshUsage($)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await refreshUsage($)
      isWorking = false
      const finished = stats
      await update($, turnsAtom, turns =>
        Object.fromEntries([...Object.entries(turns), [String(e.durationMs), finished]].slice(-KEPT_TURNS)),
      )
    }

    return next(e)
  })

  // Times every call and counts the main loop's calls and changed lines.
  on('tool.call', async ($, e, next) => {
    const startedAt = await $.clock.now()
    // A subagent's calls have no row on the main transcript, so they take no loop.
    const isMain = e.agentId === undefined
    if (isMain) await setRunning($, [...running, e.tool_use_id])
    const ran = await next(e).finally(() => (isMain ? setRunning($, running.filter(id => id !== e.tool_use_id)) : undefined))
    const ms = (await $.clock.now()) - startedAt

    await update($, memberOf(durationAtom, { requestId: e.tool_use_id }), () => ms)

    if (isMain && e.tool !== DESIGN && ran.deny === undefined) {
      const diff = diffstat(ran.result)
      stats = {
        tools: stats.tools + 1,
        added: stats.added + (diff?.added ?? 0),
        removed: stats.removed + (diff?.removed ?? 0),
      }
    }

    return ran
  })

  on('tool.call', { tool: DESIGN_MATCH }, async ($, e) => {
    const outcome = runDesign(e, await designState($))

    if (outcome.isError) {
      return { deny: outcome.text }
    }

    await commit($, outcome.state)

    return { result: outcome.text }
  })

  on('command.run', { command: 'skin' }, async ($, e) => {
    if (e.args.trim() === '') {
      await $.ui.open({ id: SETTINGS, title: 'Skins', focus: true, closeOnEscape: true })

      return {}
    }

    if (e.args.trim().toLowerCase() === 'gallery') {
      await $.ui.open({ id: GALLERY, title: 'Skin gallery', focus: true, closeOnEscape: true })

      return {}
    }

    const word = e.args.trim().toLowerCase()

    if (word === 'pin' || word === 'unpin' || word === 'share') {
      $.ui.toast(await runFolderCommand($, word))

      return {}
    }

    const current = await read($, prefsAtom)
    const custom = await read($, customAtom)
    const outcome = runSkinCommand(e.args, current, skinNames(custom))

    if (outcome.prefs !== current) {
      await commit($, { prefs: outcome.prefs, custom })
    }

    if (outcome.channel === 'row') {
      const width = lastColumns === undefined ? '' : `
reply width: ${lastColumns} columns`

      const folder = (await read($, pinnedAtom)) ? 'this folder: pinned' : 'this folder: follows the default'

      return { text: e.args.trim() === 'list' ? `${outcome.message}\n${folder}${width}` : outcome.message }
    }

    $.ui.toast(outcome.message)

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: SETTINGS }, async ($, e) => {
    const prefs = await read($, prefsAtom)
    const custom = await read($, customAtom)
    const editing = await read($, editingAtom)
    const skin = resolveSkin(prefs.skin, custom) ?? resolveSkin(DEFAULT_PREFS.skin, custom)
    const ui = $.ui.resolve(e)

    if (skin === undefined || e.surface === 'mobile' || !('Input' in ui)) {
      return <ui.Text>Open the skin settings in the terminal or the desktop app.</ui.Text>
    }

    const look = lookOf(ui, { prefs, custom, skin }, e.surface)
    const state = { prefs, custom }

    return settingsPane(look, ui, { names: skinNames(custom), editing, width: e.props.bodyColumns }, {
      pick: name => void commit($, { ...state, prefs: { ...prefs, skin: name } }),
      toggle: word => void commit($, { ...state, prefs: { ...prefs, [TOGGLES[word]]: !prefs[TOGGLES[word]] } }),
      icons: () =>
        void commit($, { ...state, prefs: { ...prefs, icons: prefs.icons === 'unicode' ? 'ascii' : 'unicode' } }),
      edit: slot => void update($, editingAtom, () => slot),
      paint: hex => {
        const made = withSlot(prefs.skin === 'off' ? DEFAULT_PREFS.skin : prefs.skin, custom, editing, hex)

        if (typeof made === 'string') {
          $.ui.toast(made)

          return
        }

        void commit($, { prefs: { ...prefs, skin: made.name }, custom: { ...custom, [made.name]: made.skin } })
      },
    })
  })

  // Every element the skin draws, numbered, to point at when asking for a change.
  on('ui.render', { component: 'Pane', requestId: GALLERY }, async ($, e) => {
    const active = await activeSkin($)
    const ui = $.ui.resolve(e)

    if (active === null) {
      return <ui.Text>The gallery shows a skin. Pick one with /skin first.</ui.Text>
    }

    return galleryPane(lookOf(ui, active, e.surface), e.props.bodyColumns)
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const kind = kindOf(e.props.tool)
    const active = await activeSkin($)

    if (kind === null || active === null) {
      return next(e)
    }

    const ms = await read($, memberOf(durationAtom, e))
    const diff = diffstat(e.props.output)
    const target = summarize(e.props.tool, e.props.input, await $.session.cwd())

    const moves = await read($, memberOf(loopAtom, { requestId: e.props.tool_use_id }))

    return toolRow(
      lookOf($.ui.resolve(e), active, e.surface),
      e.props,
      kind,
      target,
      {
        ...(ms >= 0 && !e.props.isRunning ? { ms } : {}),
        ...(diff === null ? {} : diff),
      },
      moves ? `loop-${e.props.tool_use_id}` : undefined,
    )
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const active = await activeSkin($)

    if (active === null || e.props.isExpanded) {
      return next(e)
    }

    const ids = e.props.calls.flatMap(call => (call.tool_use_id === undefined ? [] : [call.tool_use_id]))
    const moves = await Promise.all(ids.map(id => read($, memberOf(loopAtom, { requestId: id }))))
    const moving = ids.find((_, i) => moves[i])

    return groupRow(lookOf($.ui.resolve(e), active, e.surface), e.props.calls, moving === undefined ? undefined : `loop-${moving}`)
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const active = await activeSkin($)
    const output = e.props.output as { stdout?: unknown } | null
    const copy = (text: string) => {
      void $.ui.copy({ text, surface: e.surface }).then(result => $.ui.toast(result.isCopied ? 'Copied' : 'Could not copy here'))
    }
    const look = active === null ? undefined : lookOf($.ui.resolve(e), active, e.surface, copy)
    const columns = e.viewport?.columns ?? 100
    // A result is drawn once its call is done, so its card animates on its first draw only,
    // then settles like a reply's (see settleReply).
    const toolCard = async (kind: 'diff' | 'terminal', draw: () => ReturnType<typeof diffCard>) => {
      const seen = sawToolCard(e, kind)
      await read($, memberOf(settledAtom, e))
      if (!seen) settleReply($, e)
      return drawOnce(seen, draw)
    }

    // The desktop gets cards: a diff for an edit, a terminal for a shell command.
    if (look?.svg !== undefined && EDITS.has(e.props.tool) && !e.props.isErrored) {
      const diff = hunksOf(e.props.output)

      if (diff !== null) {
        const shown = shortenPath(diff.path, await $.session.cwd())

        return toolCard('diff', () => diffCard(look, look.svg!, diff, shown, columns))
      }
    }

    if (look?.svg !== undefined && e.props.tool === 'Bash') {
      const shell = shellOutputOf(e.props.output)

      if (shell !== null) {
        return toolCard('terminal', () => terminalCard(look, look.svg!, shell, e.props.isErrored, columns))
      }
    }

    if (!active?.prefs.clipOutput || e.props.tool !== 'Bash' || typeof output?.stdout !== 'string') {
      return next(e)
    }

    const stdout = clipLines(output.stdout, CLIP_HEAD, CLIP_TAIL)

    return stdout === output.stdout
      ? next(e)
      : next({ ...e, props: { ...e.props, output: { ...output, stdout } } })
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const active = await activeSkin($)

    if (active === null || !TYPED.has(e.props.origin.kind) || e.props.text.length > MAX_PROMPT) {
      return next(e)
    }

    const look = lookOf($.ui.resolve(e), active, e.surface)
    const hasImages = await read($, memberOf(imagesAtom, e))

    // Claude Code draws the images; the text is already in the outline above them.
    return promptRow(look, e.props.text, hasImages ? await next({ ...e, props: { ...e.props, text: '' } }) : undefined)
  })

  // A reply keeps Claude Code's own drawing unless it holds a table to draw.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const active = await activeSkin($)

    const text = e.props.text

    if (active === null || !active.prefs.tables || !/\||```|~~~/.test(text)) {
      return next(e)
    }

    const segments = splitReply(text)
    const fits = segments.every(segment => segment.kind === 'table' || (segment.kind === 'text' ? segment.text : segment.raw).length <= MAX_MARKDOWN)

    if (!fits || !segments.some(segment => segment.kind !== 'text')) {
      return next(e)
    }

    // Every surface's table names Svg, but the terminal draws it as nothing.
    const ui = $.ui.resolve(e)
    lastColumns = e.viewport?.columns
    const copy = (copied: string) => {
      void $.ui.copy({ text: copied, surface: e.surface }).then(result => $.ui.toast(result.isCopied ? 'Copied' : 'Could not copy here'))
    }

    const svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : undefined
    // Only a vector card animates, so only its draws are remembered.
    const fresh = svg === undefined ? undefined : freshRows(e, segments)

    if (svg !== undefined) {
      await read($, memberOf(settledAtom, e))
      if (fresh === undefined || fresh.some(row => row !== undefined)) settleReply($, e)
    }

    return drawOnce(fresh !== undefined, () => replyRows(lookOf(ui, active, e.surface, copy), segments, e.viewport?.columns ?? 100, svg, fresh))
  })

  // The terminal's spinner gets the skin's word with a shimmer; the desktop's keeps its
  // word, which says what the step is doing, beside an animated icon.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const active = await activeSkin($)

    if (active === null) {
      return next(e)
    }

    if (e.surface !== 'terminal') {
      const look = lookOf($.ui.resolve(e), active, e.surface)

      return look.svg === undefined
        ? next(e)
        : desktopSpinnerRow(look, look.svg, e.props.mode, e.props.message ?? e.props.word, 'loop-spinner')
    }

    const word = pick(active.skin.spinner, e.props.word) ?? e.props.word

    // Claude Code's Reduce motion keeps its own still spinner, in the skin's word.
    if (!active.prefs.shimmer || config.reducesMotion || e.props.message !== null) {
      return next({ ...e, props: { ...e.props, word } })
    }

    const frame = await read($, frameAtom)
    const startedAt = await read($, startedAtom)
    const elapsed = startedAt === 0 ? 0 : (await $.clock.now()) - startedAt

    return spinnerRow(lookOf($.ui.resolve(e), active, e.surface), word, frame, elapsed)
  })

  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    const active = await activeSkin($)

    if (active === null) {
      return next(e)
    }

    const turns = await read($, turnsAtom)
    const word = pick(active.skin.done, e.props.word) ?? e.props.word

    return footerRow(lookOf($.ui.resolve(e), active, e.surface), word, e.props.durationMs, turns[String(e.props.durationMs)])
  })

  // The band above the prompt: context and plan limits. A survey keeps its place. Another
  // mod's drawing there stays above the band, whatever order the hooks run in, so the band
  // sits last, nearest the prompt. Only the desktop spaces them: a terminal gap is a whole row.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const active = await activeSkin($)
    const usage = await read($, usageAtom)
    const now = await $.clock.now()
    const meters = metersOf(usage, now)

    if (active === null || !active.prefs.band || e.props.hasSurvey || meters.length === 0) {
      // Nothing drawn, so nothing to relabel; the band's next draw arms it again.
      stopRelabel()
      return next(e)
    }

    const starts = ramp(meters, now)
    const ringLoops = Math.max(0, LOOP_BUDGET - 1 - (await read($, toolLoopsAtom)))
    const isGrowing = starts.some((start, i) => start !== meters[i]?.percent)
    const look = lookOf($.ui.resolve(e), active, e.surface)
    const { Box } = look.ui
    // With no mod's row above, what comes back is the engine's own band, by reference, which
    // draws nothing without a survey; it is left out, so no empty row or gap sits above the rings.
    // ponytail: only that bare pass-through is known to draw nothing; a mod's own Box around it
    // may be its padding, border or height, so it keeps the gap. Look inside if a mod wraps it.
    const theirs = await next(e)
    const above = theirs.type === 'engine' ? null : theirs
    // Compacting mid-turn would cut the turn's own context out from under it.
    // Runs Claude Code's own /compact, so the person sees its usual progress and result.
    // Work a press starts is abandoned when the press ends, which cancels a compaction
    // still running, so a timer starts it in a dispatch of its own, which returns the run
    // so that dispatch lasts until the compaction ends. The button hides until then, so
    // repeated presses do not queue one /compact each.
    const isCompacting = await read($, compactingAtom)
    const compact = () => {
      void update($, compactingAtom, () => true)
      $.clock.after(1, () =>
        $.command
          .run({ command: 'compact' })
          .catch((error: unknown) => $.ui.toast(`Compacting failed: ${error instanceof Error ? error.message : String(error)}`))
          .finally(() => update($, compactingAtom, () => false)),
      )
    }

    if (settle === undefined && isGrowing) {
      settle = $.clock.after(SETTLE_MS, () => {
        settle = undefined
        return update($, usageAtom, usage => ({ ...usage }))
      })
    }

    const today = new Date(now)
    const resets = usage.limits.map(limit => Date.parse(limit.resetsAt ?? '')).filter(at => at > now)
    const due = Math.min(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).getTime(), ...resets)
    if (resets.length > 0 && relabel?.at !== due) {
      stopRelabel()
      relabel = {
        at: due,
        timer: $.clock.after(due - now, () => {
          relabel = undefined
          return update($, usageAtom, usage => ({ ...usage }))
        }),
      }
    }

    return (
      <Box flexDirection="column" rowGap={above !== null && look.surface === 'desktop' ? 1 : 0}>
        {above}
        {usageBand(look, meters, !e.props.isWorking && !isCompacting, compact, starts, partsOf(usage.parts ?? []), e.props.bodyColumns, ringLoops)}
      </Box>
    )
  })

  // Claude Code's own dialog stays whole: the skin only adds a band above it.
  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    const active = await activeSkin($)
    const theirs = await next(e)

    if (active === null) {
      return theirs
    }

    const headers = e.props.questions
      .map(question => (question as { header?: unknown } | null)?.header)
      .filter((header): header is string => typeof header === 'string' && header !== '')
    const look = lookOf($.ui.resolve(e), active, e.surface)
    const { Box } = look.ui

    return headers.length === 0 ? (
      theirs
    ) : (
      <Box flexDirection="column">
        {askBand(look, headers)}
        {theirs}
      </Box>
    )
  })
}
