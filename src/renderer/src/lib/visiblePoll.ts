// A poll that asks nothing while the window is hidden (performance audit R2): `load` runs now, every `ms` while the
// document is shown, and once as soon as it shows again. Returns the stop.
export function pollWhileVisible(
  load: () => void,
  ms: number,
  doc: EventTarget & { hidden: boolean } = document
): () => void {
  let stopped = false
  const tick = (): void => {
    if (!stopped && !doc.hidden) load()
  }
  const onVisibility = (): void => {
    if (!doc.hidden) tick()
  }
  load()
  const timer = setInterval(tick, ms)
  doc.addEventListener('visibilitychange', onVisibility)
  return () => {
    stopped = true
    clearInterval(timer)
    doc.removeEventListener('visibilitychange', onVisibility)
  }
}
