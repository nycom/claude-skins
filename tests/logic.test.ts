import { expect, test } from 'claude-code/testing'

import { DEFAULT_PREFS, parsePrefs, runSkinCommand } from '../hooks/command'
import { buildCustom, resolveSkin, skinNames, withSlot } from '../hooks/custom'
import { runDesign } from '../hooks/designer'
import { clipLines, compactCount, diffstat, formatDuration, formatMs, pick, resetLabel, shortenPath } from '../hooks/format'
import { columnWidths, cutCell, padCell, splitReply, widthOf } from '../hooks/markdown'
import { codeSvg, tokenize } from '../hooks/svg-code'
import { MAX_ALT } from '../hooks/svg-kit'
import { diffLines, diffSvg, hunksOf, patchText, TINT_OPACITY } from '../hooks/svg-diff'
import { fitColumns, kindOfCell, measure, tableSvg, wrapCell } from '../hooks/svg-table'
import { outputLines, shellOutputOf, terminalSvg } from '../hooks/svg-terminal'
import { limitLabel, meterColor, metersOf, PART_SLOTS, partsOf, TRACK_OPACITY, usageSvg } from '../hooks/svg-usage'
import { contrast, deepen, forTheme, isLightTheme, LIGHT_BG, resolveLight, toLight } from '../hooks/light'
import { SKINS } from '../hooks/themes'
import { parseFolders, prefsFor, withFolder, withoutFolder } from '../hooks/folders'
import { kindOf, summarize, toolLabel } from '../hooks/tools'
import tokyoNight from '../hooks/themes/tokyo-night'

const NAMES = ['tokyo-night', 'dracula', 'nord']

test('paths under the session directory show relative, others stay', async () => {
  expect(shortenPath('C:\\work\\app\\src\\a.ts', 'C:\\work\\app')).toBe('src/a.ts')
  expect(shortenPath('/work/app/src/a.ts', '/work/app/')).toBe('src/a.ts')
  expect(shortenPath('/etc/hosts', '/work/app')).toBe('/etc/hosts')
  expect(shortenPath('/work/application/a.ts', '/work/app')).toBe('/work/application/a.ts')
})

test('times read like Claude Code writes them', async () => {
  expect(formatDuration(400)).toBe('<1s')
  expect(formatDuration(64000)).toBe('1m 4s')
  expect(formatMs(340)).toBe('340ms')
  expect(formatMs(2140)).toBe('2.1s')
})

test('a seed always picks the same word, and an empty list picks none', async () => {
  expect(pick(['a', 'b', 'c'], 'Sauteing')).toBe(pick(['a', 'b', 'c'], 'Sauteing'))
  expect(pick([], 'Sauteing')).toBeUndefined()
})

test('long output keeps its head and tail and counts the rest', async () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
  const clipped = clipLines(lines, 8, 4).split('\n')

  expect(clipped[8]).toBe('… 18 lines hidden')
  expect(clipped[12]).toBe('line 29')
  expect(clipLines('a\nb', 8, 4)).toBe('a\nb')
})

test('a patch counts its added and removed lines, anything else counts nothing', async () => {
  const output = { structuredPatch: [{ lines: [' a', '-b', '+c', '+d'] }, { lines: ['-e'] }] }

  expect(diffstat(output)).toEqual({ added: 2, removed: 2 })
  expect(diffstat({ stdout: 'x' })).toBeNull()
  expect(diffstat(null)).toBeNull()
})

test('only the tools a skin can draw faithfully get a kind', async () => {
  expect(kindOf('Bash')).toBe('run')
  expect(kindOf('mcp__github__search_code')).toBe('mcp')
  expect(kindOf('Task')).toBeNull()
  expect(toolLabel('mcp__github__search_code')).toBe('github:search_code')
})

test('a call summarises to the one thing worth a glance', async () => {
  expect(summarize('Bash', { command: 'pnpm test\n  --filter hub' }, '/w')).toBe('pnpm test')
  expect(summarize('Grep', { pattern: 'TODO', path: '/w/src' }, '/w')).toBe('TODO in src')
  expect(summarize('Bash', null, '/w')).toBe('')
})

test('tables and closed code fences are split out of a reply, and a fence keeps its table as code', async () => {
  const reply = [
    'Here:',
    '',
    '| Route | Limit |',
    '|:------|------:|',
    '| /chat | **60** |',
    '| /up | 10 |',
    '',
    'Done.',
    '```',
    '| a | b |',
    '|---|---|',
    '```',
  ].join('\n')
  const segments = splitReply(reply)

  expect(segments.map(segment => segment.kind)).toEqual(['text', 'table', 'text', 'code'])
  expect(segments[3]).toEqual({ kind: 'code', lang: '', code: '| a | b |\n|---|---|', raw: '```\n| a | b |\n|---|---|\n```' })
  expect(segments[1]).toEqual({
    kind: 'table',
    header: ['Route', 'Limit'],
    align: ['left', 'right'],
    rows: [
      ['/chat', '60'],
      ['/up', '10'],
    ],
  })
})

test('columns narrow from the widest until the table fits, and cells pad to their side', async () => {
  const table = { kind: 'table' as const, header: ['a', 'b'], align: ['left' as const, 'right' as const], rows: [['x'.repeat(30), 'yy']] }

  expect(columnWidths(table, 20, 3)).toEqual([15, 2])
  expect(padCell('abc', 6, 'right')).toBe('   abc')
  expect(padCell('abcdefgh', 5, 'left')).toBe('abcd…')
})

test('wide characters count two cells, so CJK cells are measured and cut in terminal cells', async () => {
  expect(widthOf('레일, 스피너')).toBe(12)
  expect(widthOf('e\u0301')).toBe(1)
  expect(widthOf('中文')).toBe(4)
  expect(widthOf('カタカナ')).toBe(8)
  expect(widthOf('ok 🚀')).toBe(5)
  expect(widthOf('👍🏽')).toBe(2)
  expect(widthOf('🫠')).toBe(2)
  expect(cutCell('레일, 스피너', 12)).toBe('레일, 스피너')
  expect(cutCell('레일, 스피너', 5)).toBe('레일…')
  expect(widthOf(padCell('레일', 8, 'left'))).toBe(8)
})

test('a made skin lays its slots over its base, and bad drafts are refused with a reason', async () => {
  const sunset = buildCustom({ name: 'Sunset', base: 'gruvbox', palette: { user: '#FF8800' } }, undefined)

  expect(typeof sunset).toBe('object')

  const custom = { sunset: sunset as Exclude<typeof sunset, string> }
  const skin = resolveSkin('sunset', custom)

  expect(skin?.palette.user).toBe('#ff8800')
  expect(skin?.palette.run).toBe(resolveSkin('gruvbox', {})?.palette.run)
  expect(skinNames(custom)).toContain('sunset')
  expect(buildCustom({ name: 'dracula' }, undefined)).toContain('built-in')
  expect(buildCustom({ name: 'x', palette: { user: 'red' } }, undefined)).toContain('bad palette')
  expect(buildCustom({ name: 'x', base: 'nope' }, undefined)).toContain('base must be')
})

test('painting a slot on a built-in skin forks it into my-<name>', async () => {
  const made = withSlot('nord', {}, 'user', '#123456')

  expect(typeof made === 'string' ? made : made.name).toBe('my-nord')
  expect(withSlot('nord', {}, 'user', 'blue')).toContain('#7aa2f7')
})

test('the design tool saves, applies, changes settings and deletes', async () => {
  const start = { prefs: DEFAULT_PREFS, custom: {} }
  const saved = runDesign({ action: 'save', name: 'ink', base: 'mono', palette: { user: '#5555ff' } }, start)

  expect(saved.isError).toBe(false)
  expect(saved.state.prefs.skin).toBe('ink')

  const quiet = runDesign({ action: 'settings', settings: { rail: false, icons: 'ascii' } }, saved.state)

  expect(quiet.state.prefs.rail).toBe(false)
  expect(quiet.state.prefs.icons).toBe('ascii')

  const gone = runDesign({ action: 'delete', name: 'ink' }, quiet.state)

  expect(gone.state.prefs.skin).toBe(DEFAULT_PREFS.skin)
  expect(runDesign({ action: 'delete', name: 'nord' }, start).isError).toBe(true)
  expect(runDesign({ action: 'apply', name: 'nope' }, start).isError).toBe(true)
  expect(JSON.parse(runDesign({ action: 'show' }, start).text).current).toBe('noir')
})

test('/skin names a skin, switches parts, and refuses what it does not know', async () => {
  expect(runSkinCommand('nord', DEFAULT_PREFS, NAMES).prefs.skin).toBe('nord')
  expect(runSkinCommand('default', DEFAULT_PREFS, NAMES).prefs.skin).toBe('off')
  expect(runSkinCommand('rail off', DEFAULT_PREFS, NAMES).prefs.rail).toBe(false)
  expect(runSkinCommand('clip on', DEFAULT_PREFS, NAMES).prefs.clipOutput).toBe(true)
  expect(runSkinCommand('shimmer maybe', DEFAULT_PREFS, NAMES).prefs).toBe(DEFAULT_PREFS)
  expect(runSkinCommand('plaid', DEFAULT_PREFS, NAMES).channel).toBe('row')
  expect(runSkinCommand('list', { ...DEFAULT_PREFS, skin: 'nord' }, NAMES).message).toContain('● nord')
})

test('stored prefs that are stale or hand-edited fall back to defaults', async () => {
  expect(parsePrefs(undefined, NAMES)).toEqual(DEFAULT_PREFS)
  expect(parsePrefs({ skin: 'gone', icons: 'x', rail: 'yes' }, NAMES)).toEqual(DEFAULT_PREFS)
  expect(parsePrefs({ skin: 'off', rail: false }, NAMES).rail).toBe(false)
})

test('cells are read as colours, diffs, numbers, code or text', async () => {
  expect(kindOfCell('#7aa2f7')).toBe('colour')
  expect(kindOfCell('+18 −3')).toBe('diff')
  expect(kindOfCell('120')).toBe('number')
  expect(kindOfCell('2.1s')).toBe('number')
  expect(kindOfCell('apps/hub/server.ts')).toBe('code')
  expect(kindOfCell('Added a limiter')).toBe('text')
  expect(measure('MMMM', false)).toBeDefined()
})

test('a vector table stays within its width and escapes what it draws', async () => {
  const card = tableSvg(
    { kind: 'table', header: ['a', 'b'], align: ['left', 'right'], rows: [['<b>', 'Q'.repeat(400)]] },
    tokyoNight.palette,
    5000,
  )

  expect(card.width).toBe(1600)
  expect(tableSvg({ kind: 'table', header: ['a'], align: ['left'], rows: [['b']] }, tokyoNight.palette, 700).width).toBe(700)
  // A long cell wraps instead of being cut: every one of its 400 characters is drawn.
  expect(card.source).not.toContain('…')
  expect((card.source.match(/Q+/g) ?? []).join('').length).toBe(400)
  expect(card.source).toContain('&lt;b&gt;')
  expect(card.source).not.toContain('<b>')
  expect(card.source).toContain('prefers-reduced-motion')
})

test('a long table rises in within a quarter second, its rows visible without the animation', async () => {
  const rows = Array.from({ length: 40 }, (_, i) => [`row ${i}`])
  const card = tableSvg({ kind: 'table', header: ['a'], align: ['left'], rows }, tokyoNight.palette, 700)
  const delays = [...card.source.matchAll(/animation-delay:(\d+)ms/g)].map(match => Number(match[1]))

  expect(delays.length).toBe(40)
  expect(Math.max(...delays) - Math.min(...delays)).toBeLessThanOrEqual(250)
  expect(card.source).not.toContain('.row{opacity:0')
})

test('a copied patch names the file relative to the session, or by its absolute path outside it', async () => {
  const diff = { path: '/work/src/a.ts', hunks: [{ oldStart: 1, newStart: 1, lines: ['-a', '+b'] }], isNewFile: false }

  expect(patchText(diff, 'src/a.ts')).toBe('--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-a\n+b')
  expect(patchText({ ...diff, path: '/tmp/a.ts' }, '/tmp/a.ts').split('\n').slice(0, 2)).toEqual(['--- /tmp/a.ts', '+++ /tmp/a.ts'])
})

test('a changed line draws its numbers and sign in the text colour, readable on its tint', async () => {
  const { fg, muted } = tokyoNight.palette
  const card = diffSvg({ path: 'a.ts', hunks: [{ oldStart: 7, newStart: 9, lines: ['-a', '+b'] }], isNewFile: false }, 'a.ts', tokyoNight.palette, 600)

  for (const text of ['7', '9', '−', '+']) {
    expect(card.source).toContain(`style="fill:${fg}">${text}</text>`)
    expect(card.source).not.toContain(`style="fill:${muted}">${text}</text>`)
  }
})

test('a huge new file still draws at once, its alt capped in characters', async () => {
  const lines = Array.from({ length: 2000 }, (_, i) => `+const line${i} = '${'x'.repeat(60)}'`)
  const card = diffSvg({ path: 'big.ts', hunks: [{ oldStart: 0, newStart: 1, lines }], isNewFile: true }, 'big.ts', tokyoNight.palette, 800)
  const code = codeSvg(lines.join('\n').repeat(4), 'ts', tokyoNight.palette, 800)

  expect(card.alt.length).toBeLessThanOrEqual('big.ts: +2000 −0\n'.length + MAX_ALT + 1)
  expect(code.alt.length).toBeLessThanOrEqual('ts:\n'.length + MAX_ALT + 1)
  expect(card.alt.length).toBeGreaterThan(MAX_ALT)
})

test('a patch numbers its lines on each side and marks the gap between hunks', async () => {
  const lines = diffLines([
    { oldStart: 10, newStart: 10, lines: [' a', '-b', '+c', '+d'] },
    { oldStart: 40, newStart: 41, lines: [' e', '\\ No newline at end of file'] },
  ])

  expect(lines).toEqual([
    { kind: 'ctx', text: 'a', old: 10, new: 10 },
    { kind: 'del', text: 'b', old: 11 },
    { kind: 'add', text: 'c', new: 11 },
    { kind: 'add', text: 'd', new: 12 },
    { kind: 'gap', at: 41 },
    { kind: 'ctx', text: 'e', old: 40, new: 41 },
  ])
})

test('a new file with an empty patch shows its content as added lines', async () => {
  const diff = hunksOf({ type: 'create', filePath: '/w/a.ts', content: 'x\ny', structuredPatch: [] })

  expect(diff?.isNewFile).toBe(true)
  expect(diff?.hunks[0]?.lines).toEqual(['+x', '+y'])
  expect(hunksOf({ stdout: '' })).toBeNull()

  const card = diffSvg(diff!, 'a.ts', tokyoNight.palette, 600)

  expect(card.source).toContain('new file')
  // The alt carries the whole patch, as Copy does, since the card cuts long lines and stops at 30.
  expect(card.alt).toBe('a.ts: +2 −0\n--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+x\n+y')
})

test('shell output loses its colour codes, keeps stderr apart and folds the middle', async () => {
  const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
  const shell = shellOutputOf({ stdout: `\u001b[32mok\u001b[0m\n${long}\n\n`, stderr: 'warn: x', interrupted: false })
  const lines = outputLines(shell!)

  expect(lines[0]).toEqual({ text: 'ok', isErr: false })
  expect(lines[6]).toEqual({ fold: 30 })
  expect(lines.at(-1)).toEqual({ text: 'warn: x', isErr: true })
  expect(terminalSvg(shell!, true, tokyoNight.palette, 600).source).toContain('failed')
  expect(shellOutputOf({ content: 'x' })).toBeNull()
})

test('code is split into comments, strings, numbers and keywords by language', async () => {
  expect(tokenize('const x = "hi" // note', 'ts').map(token => token.role)).toEqual([
    'keyword', 'plain', 'plain', 'plain', 'string', 'plain', 'comment',
  ])
  expect(tokenize('x = 1  # note', 'python').at(-1)).toEqual({ text: '# note', role: 'comment' })
  expect(codeSvg('a\nb', 'ts', tokyoNight.palette, 600).source).toContain('TS')
})

test('plan limits read as 5h and 7d, and a meter warns as it fills', async () => {
  expect(limitLabel('five_hour')).toBe('5h')
  expect(limitLabel('seven_day')).toBe('7d')
  expect(metersOf({ context: 42.4, limits: [{ label: '5h', percent: 120 }] }, 0)).toEqual([
    { label: 'context', percent: 42 },
    { label: '5h', percent: 100 },
  ])
  expect(meterColor(85, tokyoNight.palette)).toBe(tokyoNight.palette.warn)
  expect(usageSvg([{ label: 'context', percent: 42 }], tokyoNight.palette).alt).toBe('context 42%')
})

test('token counts read compactly, and a reset reads as a time today or a weekday further off', async () => {
  expect([950, 1500, 96_000, 200_000, 999_700, 1_200_000].map(compactCount)).toEqual(['950', '1.5k', '96k', '200k', '1M', '1.2M'])

  // Built from local times, so the expectations hold in any time zone.
  const now = new Date(2026, 9, 9, 12, 0).getTime()
  expect(resetLabel(new Date(2026, 9, 9, 14, 40).toISOString(), now)).toBe('2:40pm')
  expect(resetLabel(new Date(2026, 9, 10, 0, 5).toISOString(), now)).toBe('12:05am')
  expect(resetLabel(new Date(2026, 9, 10, 9, 0).toISOString(), now)).toBe('9:00am')
  expect(resetLabel(new Date(2026, 9, 12, 9, 0).toISOString(), now)).toBe('Mon')
  expect(resetLabel(undefined, now)).toBeUndefined()
  expect(resetLabel('soon', now)).toBeUndefined()

  const usage = {
    context: 48,
    tokens: 96_000,
    window: 200_000,
    limits: [
      { label: '5h', percent: 19, resetsAt: new Date(2026, 9, 9, 14, 40).toISOString() },
      { label: '7d', percent: 23 },
    ],
  }
  expect(metersOf(usage, now)).toEqual([
    { label: 'context', percent: 48, note: '96k/200k' },
    { label: '5h', percent: 19, note: '2:40pm' },
    { label: '7d', percent: 23 },
  ])
  expect(metersOf({ ...usage, tokens: undefined }, now)[0]).toEqual({ label: 'context', percent: 48 })
})

test('the breakdown keeps what fills the window, largest first, as shares of it', async () => {
  const parts = partsOf([
    { name: 'System prompt', tokens: 9_000 },
    { name: 'Messages', tokens: 61_000 },
    { name: 'Memory files', tokens: 8_000 },
    { name: 'System tools', tokens: 22_000 },
    { name: 'Slash commands', tokens: 0 },
  ])

  expect(parts.map(part => `${part.label} ${part.share}`)).toEqual(['msgs 61', 'tools 22', 'sys 9', 'memory 8'])
  expect(parts[0]?.slot).toBe('user')
  expect(partsOf([])).toEqual([])
})

test('the context ring is a jog ring whose unlit segments chase toward 12, faster and hotter as it fills', async () => {
  const { palette } = tokyoNight
  const circumference = 2 * Math.PI * 8
  const band = (context: number) => usageSvg([{ label: 'context', percent: context }, { label: '5h', percent: 19 }, { label: '7d', percent: 23 }], palette).source
  const chase = (context: number) => {
    const heads = [...band(context).matchAll(/ stroke="([^"]+)"[^>]* opacity="([\d.]+)" transform="rotate\((-?\d+) [^"]*" style="animation:jog\d+ ([\d.]+)s/g)]
    return { angles: heads.map(m => Number(m[3])), colors: [...new Set(heads.map(m => m[1]))], seconds: [...new Set(heads.map(m => Number(m[4])))], resting: heads.map(m => m[2]) }
  }
  const arc = (source: string) => source.match(/class="fill"[^>]* stroke="([^"]+)"/)?.[1]

  const warned = band(74)
  expect(warned).toContain('<mask id="jog0"')
  expect(warned).toContain('<g mask="url(#jog0)">')
  // The mask's dash and gap repeat twelve times around the ring.
  const [dash = 0, gap = 0] = warned.match(/<mask[^>]*><circle[^>]* stroke-dasharray="([\d.]+) ([\d.]+)"/)?.slice(1).map(Number) ?? []
  expect(Math.abs((dash + gap) * 12 - circumference)).toBeLessThan(0.001)
  expect(arc(warned)).toBe(palette.warn)
  expect(warned).toContain('@keyframes jog0{0%,45%,100%{opacity:0}18%{opacity:0.75}}')
  // Reduced motion leaves the next segment up at .4 and the rest dark.
  expect(chase(74)).toEqual({ angles: [180, 210, 240], colors: [palette.warn], seconds: [2.4], resting: ['0.4', '0', '0'] })
  expect(warned).toContain('@media (prefers-reduced-motion:reduce){*{animation:none!important}}')
  expect(chase(70).angles).toEqual([150, 180, 210, 240])

  // Below Compact it chases slowly and faintly in the accent, a bit brighter once Compact shows.
  expect(chase(20)).toMatchObject({ angles: [-30, 0, 30, 60, 90, 120, 150, 180, 210, 240], colors: [palette.user], seconds: [4] })
  expect(band(20)).toContain('18%{opacity:0.35}')
  expect(chase(55)).toMatchObject({ angles: [120, 150, 180, 210, 240], colors: [palette.user], seconds: [3] })
  expect(band(55)).toContain('18%{opacity:0.5}')

  // From 90% one segment is left, blinking in the error colour; from 97% the arc dims on its beat.
  const full = band(92)
  expect(chase(92)).toMatchObject({ angles: [240], colors: [palette.err], seconds: [1.2] })
  expect(arc(full)).toBe(palette.err)
  expect(full).not.toContain('dim 1.2s')
  expect(chase(99)).toMatchObject({ angles: [240], colors: [palette.err], seconds: [1.2] })
  expect(band(99)).toContain('@keyframes dim{50%{opacity:.6}}')
  expect(band(99)).toContain(',dim 1.2s ease-in-out infinite"')

  // The plan rings share the twelve segments under their own masks, square-ended, in their
  // meter colour; well short of the limit they hold still.
  for (const source of [warned, full]) {
    const plans = source.slice(source.indexOf('</text>'))
    expect(plans).toContain('<mask id="jog1"')
    expect(plans).toContain('<g mask="url(#jog1)">')
    expect(plans).toContain('<mask id="jog2"')
    expect(plans).toContain('<g mask="url(#jog2)">')
    expect(plans.match(/<circle/g)?.length).toBe(6)
    expect(plans).not.toContain('animation:jog')
    expect(plans).not.toContain('linecap')
    expect(arc(plans)).toBe(meterColor(19, palette))
  }
})

test('a plan ring is a still jog ring until 80%, then chases in the warning colour, and from 95% blinks its last segment', async () => {
  const { palette } = tokyoNight
  for (const label of ['5h', '7d']) {
    const ring = (percent: number) => {
      const source = usageSvg([{ label, percent }], palette).source
      const heads = [...source.matchAll(/ stroke="([^"]+)"[^>]* opacity="([\d.]+)" transform="rotate\((-?\d+) [^"]*" style="animation:jog0 ([\d.]+)s/g)]
      return {
        source,
        arc: source.match(/class="fill"[^>]* stroke="([^"]+)"/)?.[1],
        chase: { angles: heads.map(m => Number(m[3])), colors: [...new Set(heads.map(m => m[1]))], seconds: [...new Set(heads.map(m => Number(m[4])))], resting: heads.map(m => m[2]) },
      }
    }

    const still = ring(79)
    expect(still.source).toContain('<g mask="url(#jog0)">')
    expect(still.source).not.toContain('jog0{')
    expect(still.chase.angles).toEqual([])
    expect(still.arc).toBe(meterColor(79, palette))

    const near = ring(85)
    expect(near.arc).toBe(palette.warn)
    expect(near.chase).toEqual({ angles: [210, 240], colors: [palette.warn], seconds: [3], resting: ['0.4', '0'] })
    expect(near.source).toContain('@keyframes jog0{0%,45%,100%{opacity:0}18%{opacity:0.5}}')

    const over = ring(96)
    expect(over.arc).toBe(palette.err)
    expect(over.chase).toEqual({ angles: [240], colors: [palette.err], seconds: [1.2], resting: ['0.4'] })
    expect(over.source).toContain('18%{opacity:0.75}')
    expect(over.source).not.toContain('dim')
    expect(over.source).toContain('@media (prefers-reduced-motion:reduce){*{animation:none!important}}')
  }

  // Beside a chasing context ring, each ring chases on its own keyframes.
  const both = usageSvg([{ label: 'context', percent: 74 }, { label: '5h', percent: 85 }], palette).source
  expect(both).toContain('@keyframes jog0{0%,45%,100%{opacity:0}18%{opacity:0.75}}')
  expect(both).toContain('@keyframes jog1{0%,45%,100%{opacity:0}18%{opacity:0.5}}')
})

test('a long cell wraps on its words, breaks a word too long for the column, and keeps every word', async () => {
  expect(wrapCell('the quick brown fox jumps', 90, false)).toEqual(['the quick', 'brown fox', 'jumps'])
  expect(wrapCell('x'.repeat(30), 60, true).every(line => measure(line, true) <= 60)).toBe(true)
  expect(wrapCell('word '.repeat(80), 60, false).join(' ')).toBe('word '.repeat(80).trim())
})

test('short columns keep their width and long ones share the rest', async () => {
  const [hash, why, who] = fitColumns([20, 900, 60], 700)

  expect(hash).toBe(20)
  expect(who).toBe(60)
  expect(Math.round((why ?? 0) + 20 + 60 + 2 * 28 + 2 * 24)).toBe(700)
})

test('a light palette is derived with dark text, light bands and deepened colours', async () => {
  const light = toLight(tokyoNight.palette)

  expect(light.fg).toBe('#1f1f1f')
  expect(light.surface).toBe('#ffffff')
  expect(light.run).toBe(deepen(tokyoNight.palette.run, 0.45))
  expect(deepen('#ffffff', 0.5)).toBe('#808080')
  expect(isLightTheme('light-daltonized')).toBe(true)
  expect(isLightTheme('dark')).toBe(false)
})

test('SKINS_THEME wins, then the theme, then the terminal and the system for auto', async () => {
  expect(resolveLight({ override: 'dark', theme: 'light' })).toBe(false)
  expect(resolveLight({ override: 'Light', theme: 'dark' })).toBe(true)
  expect(resolveLight({ override: '', theme: 'light-daltonized' })).toBe(true)
  expect(resolveLight({ theme: 'auto', colorfgbg: '0;15' })).toBe(true)
  expect(resolveLight({ theme: 'auto', colorfgbg: '15;default;0' })).toBe(false)
  expect(resolveLight({ theme: 'auto', systemDark: false })).toBe(true)
  expect(resolveLight({ theme: 'auto', systemDark: true })).toBe(false)
  expect(resolveLight({ theme: 'auto' })).toBe(false)
})

test('a pinned folder keeps its own prefs, others follow the default', async () => {
  const pinned = { ...DEFAULT_PREFS, skin: 'nord' }
  const folders = parseFolders({ '/a': pinned, '/b': { skin: 'nope' } }, NAMES)

  expect(prefsFor('/a', folders, DEFAULT_PREFS).skin).toBe('nord')
  expect(prefsFor('/b', folders, DEFAULT_PREFS).skin).toBe(DEFAULT_PREFS.skin)
  expect(prefsFor('/c', folders, DEFAULT_PREFS)).toBe(DEFAULT_PREFS)
  expect(Object.keys(withoutFolder(withFolder(folders, '/c', pinned), '/a'))).toEqual(['/b', '/c'])
  expect(parseFolders('junk', NAMES)).toEqual({})
})

test('every skin reads at 4.5:1 on both host backgrounds, dark and light', async () => {
  const roles = ['read', 'write', 'run', 'search', 'web', 'mcp', 'other', 'user', 'fg', 'muted', 'ok', 'err', 'warn'] as const
  const made = resolveSkin('my-noir', { 'my-noir': { name: 'my-noir', label: 'x', base: 'noir', palette: {}, spinner: [], done: [] } })
  const dark = ['#262624', '#1f1e1d']

  for (const skin of [...SKINS, ...(made === undefined ? [] : [made])]) {
    for (const role of roles) {
      for (const bg of dark) {
        expect(`${skin.name} dark ${role} ${contrast(skin.palette[role], bg) >= 4.5}`).toBe(`${skin.name} dark ${role} true`)
      }

      const light = forTheme(skin, true).palette[role]

      expect(`${skin.name} light ${role} ${contrast(light, LIGHT_BG) >= 4.5}`).toBe(`${skin.name} light ${role} true`)
    }

    for (const [mode, palette, bgs] of [['dark', skin.palette, dark], ['light', forTheme(skin, true).palette, [LIGHT_BG]]] as const) {
      for (const bg of bgs) {
        // A changed line's text, numbers and sign sit on its tint, at 4.5:1.
        for (const tint of [palette.ok, palette.err]) {
          expect(`${skin.name} ${mode} text on tint ${contrast(palette.fg, over(tint, TINT_OPACITY, bg)) >= 4.5}`).toBe(`${skin.name} ${mode} text on tint true`)
        }

        // A meter's fill reads at 3:1 against the page and against its track.
        // So does each segment of the context breakdown bar.
        for (const fill of [palette.user, palette.warn, palette.err, ...PART_SLOTS.map(slot => palette[slot])]) {
          const track = over(palette.muted, TRACK_OPACITY, bg)
          expect(`${skin.name} ${mode} ${fill} ${Math.min(contrast(fill, bg), contrast(fill, track)) >= 3}`).toBe(`${skin.name} ${mode} ${fill} true`)
        }
      }
    }
  }
})

// `top` at `alpha` over `bg`, as the card paints it.
const over = (top: string, alpha: number, bg: string): string =>
  `#${[1, 3, 5]
    .map(at => Math.round(parseInt(top.slice(at, at + 2), 16) * alpha + parseInt(bg.slice(at, at + 2), 16) * (1 - alpha)).toString(16).padStart(2, '0'))
    .join('')}`

test('a made skin keeps its base skin\'s light palette, and derives the slots it changed', async () => {
  const custom = { mine: { name: 'mine', label: 'Mine', base: 'noir', palette: { read: '#ffffff' }, spinner: [], done: [] } }
  const light = resolveSkin('mine', custom)?.light

  expect(light?.write).toBe('#111111')
  expect(light?.read).not.toBe('#111111')
  expect(contrast(light?.read ?? '#ffffff', LIGHT_BG)).toBeGreaterThanOrEqual(4.5)
})
