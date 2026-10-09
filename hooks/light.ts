import type { Palette, Skin } from './skin'

// Every skin works on a light background too. A skin may carry its own light palette;
// the rest are derived: body text goes near-black, bands go near-white, and each colour
// is deepened until it reads on white.

const channels = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
]

const toHex = (rgb: readonly number[]): string =>
  `#${rgb.map(value => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, '0')).join('')}`

// `amount` of the way from `hex` to black.
export const deepen = (hex: string, amount: number): string =>
  toHex(channels(hex).map(value => value * (1 - amount)))

// WCAG contrast ratio of two #rrggbb colours.
export const contrast = (a: string, b: string): number => {
  const luminance = (hex: string) => {
    const [r = 0, g = 0, bl = 0] = channels(hex).map(value => {
      const c = value / 255

      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    })

    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)

  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05)
}

// The light host background the derived palettes are checked against.
export const LIGHT_BG = '#faf9f5'

// `hex` deepened by `amount`, then further in 4% steps until it reads at `min`:1 on the page.
// Darkening towards black keeps the hue.
const reads = (hex: string, amount: number, min = 4.5): string => {
  let out = deepen(hex, amount)

  for (let step = 0.04; contrast(out, LIGHT_BG) < min && step < 1; step += 0.04) {
    out = deepen(hex, amount + (1 - amount) * step)
  }

  return out
}

export function toLight(palette: Palette): Palette {
  const deep = (hex: string) => reads(hex, 0.45)

  return {
    read: deep(palette.read),
    write: deep(palette.write),
    run: deep(palette.run),
    search: deep(palette.search),
    web: deep(palette.web),
    mcp: deep(palette.mcp),
    other: deep(palette.other),
    user: deep(palette.user),
    fg: '#1f1f1f',
    muted: '#6b6b6b',
    surface: '#ffffff',
    zebra: '#f2f2f2',
    ok: reads(palette.ok, 0.5),
    err: reads(palette.err, 0.25),
    warn: reads(palette.warn, 0.5),
  }
}

export const forTheme = (skin: Skin, isLight: boolean): Skin =>
  isLight ? { ...skin, palette: skin.light ?? toLight(skin.palette) } : skin

// Claude Code's theme names say light or dark in them: `light`, `light-daltonized`, ...
export const isLightTheme = (value: unknown): boolean => typeof value === 'string' && value.includes('light')

// Light, dark, or undefined when the name says neither (`auto`).
const named = (value: unknown): boolean | undefined => {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : ''

  return name.includes('light') ? true : name.includes('dark') ? false : undefined
}

// `COLORFGBG` is `<fg>;<bg>` (sometimes `<fg>;<default>;<bg>`); background 7 or 15 is a light one.
const terminalLight = (colorfgbg: string | undefined): boolean | undefined => {
  const bg = Number(colorfgbg?.split(';').at(-1))

  return colorfgbg === undefined || Number.isNaN(bg) ? undefined : bg === 7 || bg === 15
}

export type ThemeHints = {
  // `SKINS_THEME`, for a session whose theme comes from somewhere skins cannot read (`--settings`).
  override?: string
  // Claude Code's `theme` setting.
  theme?: unknown
  colorfgbg?: string
  // The system's appearance, when it could be read.
  systemDark?: boolean
}

// `SKINS_THEME` wins, then a theme that names light or dark, then, for `auto`, the
// terminal's background and the system's appearance. Dark when nothing says.
export const resolveLight = (hints: ThemeHints): boolean =>
  named(hints.override) ??
  named(hints.theme) ??
  terminalLight(hints.colorfgbg) ??
  (hints.systemDark === undefined ? false : !hints.systemDark)
