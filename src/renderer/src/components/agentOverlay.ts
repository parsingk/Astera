/** The view logic behind the agent's in-use overlay in BrowserPane: where the pointer lands, and
 *  whether a key stops the script. Kept out of the JSX so both are rules with tests rather than
 *  arithmetic and conditions inside a component (the same shape as browserSlot.ts). */

/** One pointer event as App keeps it per session. `seq` counts events so a second click at the same
 *  point still animates: React remounts the ripple on the key. */
export interface AgentPointerState {
  x: number
  y: number
  w: number
  h: number
  kind: 'click' | 'fill' | 'press'
  seq: number
}

export interface ViewBox {
  left: number
  top: number
  width: number
  height: number
}

/** The guest's point, reported in its own viewport CSS px, placed onto the <webview>'s box in the
 *  stage. The ratio is 1 for an ordinary tab; under a viewport preset the guest is drawn at another
 *  size, and this is what puts the arrow on the element and not beside it. A zero-size viewport
 *  cannot be mapped and goes to the box's origin rather than producing Infinity. */
export function pointerToView(p: { x: number; y: number; w: number; h: number }, view: ViewBox): { left: number; top: number } {
  const sx = p.w > 0 ? view.width / p.w : 0
  const sy = p.h > 0 ? view.height / p.h : 0
  return { left: view.left + p.x * sx, top: view.top + p.y * sy }
}
