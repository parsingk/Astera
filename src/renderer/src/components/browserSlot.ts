/** How a browser tab's slot is drawn.
 *
 *  `shown` is the ordinary case: the tab the pane is showing. `off` is every other tab — placed
 *  nowhere and drawn not at all, which is what keeps a dozen background pages cheap.
 *
 *  `drawn` is the agent's tab while its script runs, and it exists because those two states are not
 *  enough for it. The agent's tab is deliberately a background tab — the agent must never take the
 *  tab or the window the user is on — but Chromium draws nothing for a slot that is `display:none`,
 *  and a page that is not being drawn cannot be photographed: `screenshot()` came back empty every
 *  time, and a session that could not get a screenshot went around the browser and captured the whole
 *  desktop instead. So while a script is running, the slot is placed like the shown one and made
 *  invisible with opacity: the guest produces frames, nothing appears on screen, and pointer events
 *  fall through to the tab the user is actually looking at. See agentBrowser/helpers.ts `firstFrame`
 *  for the measurements.
 *
 *  Kept out of the grid's JSX so "only the busy session's own tab, and only while it is not shown"
 *  is a rule with a test rather than a ternary. */
export type BrowserSlotDraw = 'shown' | 'drawn' | 'off'

export function browserSlotDraw(
  tab: { agentSessionId?: string },
  visible: boolean,
  agentBusy: Record<string, boolean>
): BrowserSlotDraw {
  if (visible) return 'shown'
  // Keyed by this tab's own session: with two sessions and one running script, drawing every agent
  // tab would put an invisible page in front of the user for a script that is not theirs.
  if (tab.agentSessionId !== undefined && agentBusy[tab.agentSessionId] === true) return 'drawn'
  return 'off'
}
