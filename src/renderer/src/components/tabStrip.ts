/** The arithmetic behind a pane's tab bar (WorkbenchTabs.tsx): how far a tab may shrink, what a wheel
 *  does over the bar, and where the scroll thumb sits. Kept out of the component so each rule has a
 *  test — the component only measures the DOM and hands the numbers here. */

/** The narrowest a tab may get: everything but its name at full width, and at least half the name.
 *
 *  `fixed` is what never shrinks — icon, close button, tags, gaps, padding. `nameWidths` is what each
 *  part of the name (the title, a file tab's hint) needs to show in full, which the bar reads as the
 *  part's scrollWidth: that stays the same however squeezed the tab already is, so measuring again
 *  gives the same floor. Half the whole tab was the first rule tried, and it left a short name nothing
 *  at all — the fixed parts alone are wider than half of such a tab. */
export function tabFloor(fixed: number, nameWidths: number[]): number {
  let name = 0
  for (const width of nameWidths) name += width
  return Math.ceil(fixed + name / 2)
}

/** How far a wheel over the bar moves it sideways, or null to leave the wheel to the browser.
 *
 *  A mouse wheel only goes up and down, and the bar only scrolls sideways, so a vertical wheel is
 *  turned into a sideways scroll. A sideways trackpad swipe already scrolls the bar on its own. */
export function wheelShift(deltaX: number, deltaY: number, overflowing: boolean): number | null {
  if (!overflowing || Math.abs(deltaX) >= Math.abs(deltaY)) return null
  return deltaY
}

/** Where the scroll thumb sits along the bar, in the bar's own pixels, or null while every tab fits. */
export function scrollThumb(
  scrollLeft: number,
  scrollWidth: number,
  clientWidth: number
): { left: number; width: number } | null {
  if (scrollWidth <= clientWidth) return null
  return {
    left: (scrollLeft / scrollWidth) * clientWidth,
    width: (clientWidth / scrollWidth) * clientWidth
  }
}
