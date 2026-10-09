// When the How It Works data is read (audit UI-12): while it is on screen, the sidebar or a record tab. A change pushed
// meanwhile is read when it is next shown.

export function needsUnderstanding(a: { hiwOpen: boolean; activeKind: string | undefined; recordTabs: number }): boolean {
  // Any record tab open, not only the focused one (final review I-7): its status mark and a record in an unfocused
  // pane read this too.
  return a.hiwOpen || a.activeKind === 'record' || a.recordTabs > 0
}
