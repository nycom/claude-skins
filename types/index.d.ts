// Every colour a skin names. `fg` is body text, `muted` secondary text, `surface` the
// band behind a table header, `zebra` every other table row.
export type SkinSlot =
  | 'read'
  | 'write'
  | 'run'
  | 'search'
  | 'web'
  | 'mcp'
  | 'other'
  | 'user'
  | 'fg'
  | 'muted'
  | 'surface'
  | 'zebra'
  | 'ok'
  | 'err'
  | 'warn'

// What /skin and the settings pane change. `skin` is a skin's name, or 'off'.
export type Prefs = {
  skin: string
  icons: 'unicode' | 'ascii'
  rail: boolean
  tables: boolean
  shimmer: boolean
  band: boolean
  clipOutput: boolean
}

// A skin someone made in the settings pane or through their agent: a built-in skin
// with some slots and words changed.
export type CustomSkin = {
  name: string
  label: string
  base: string
  palette: Partial<Record<SkinSlot, string>>
  spinner: string[]
  done: string[]
}

// How full the context window is and how much of each plan limit is spent, in percent,
// as the band above the prompt shows them: the context's tokens of its window, when each
// limit resets (ISO 8601), and the tokens of each part of the context that fills it.
export type UsageSnap = {
  context: number | null
  tokens?: number
  window?: number
  limits: { label: string; percent: number; resetsAt?: string }[]
  parts?: { name: string; tokens: number }[]
}

// The selected skin's colours for other mods' panels, in Omarchy colors.toml terms:
// `dim` is secondary text, `muted` a border tone. null while the skin is 'off'.
export type PanelTheme = { mode: 'dark' | 'light'; accent: string; foreground: string; dim: string; muted: string; red: string; selection: string; background: string }

// What one turn did, shown in its footer.
export type TurnStats = { tools: number; added: number; removed: number }

declare module 'claude-code' {
  interface PluginState {
    skins: {
      prefs: Prefs
      custom: Record<string, CustomSkin>
      startedAt: number
      frame: number
      turns: Record<string, TurnStats>
      duration: StateFamily<number>
      editing: SkinSlot
      usage: UsageSnap
      isLight: boolean
      images: StateFamily<boolean>
      settled: StateFamily<number>
      compacting: boolean
      pinned: boolean
      theme: PanelTheme | null
      // Per call, whether its icon may move; how many calls' icons do.
      loop: StateFamily<boolean>
      toolLoops: number
    }
  }
}
