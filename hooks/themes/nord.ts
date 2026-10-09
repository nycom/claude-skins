import type { Skin } from '../skin'

const skin: Skin = {
  name: 'nord',
  label: 'Nord',
  palette: {
    read: '#8fbcbb',
    write: '#d08770',
    run: '#ebcb8b',
    search: '#b48ead',
    web: '#7391b7',
    mcp: '#88c0d0',
    other: '#d8dee9',
    user: '#88c0d0',
    fg: '#e5e9f0',
    muted: '#838fa7',
    surface: '#3b4252',
    zebra: '#353b49',
    ok: '#a3be8c',
    err: '#c8777f',
    warn: '#ebcb8b',
  },
  spinner: ['Drifting', 'Frosting', 'Chilling', 'Thawing', 'Skiing', 'Gliding'],
  done: ['Frozen', 'Thawed', 'Charted', 'Crossed'],
}

export default skin
