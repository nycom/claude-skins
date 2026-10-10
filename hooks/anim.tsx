import type { ClientModule, RenderElement } from 'claude-code'

// A looping image on the desktop. The desktop builds an Svg again as a new image on every
// redraw, which starts its loop over; a Client under one key is kept across redraws and draws
// again only on new props, so the image it holds runs on. The element table a module draws
// with names no Svg, but the desktop draws one a module returns.
export type LoopProps = { source: string; alt: string; width: number; height: number; isInteractive?: boolean }

const Loop: ClientModule<LoopProps> = props => h('Svg', props) as RenderElement

export default Loop
