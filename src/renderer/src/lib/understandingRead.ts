// When the How It Works data is read (audit UI-12): while it is on screen, the sidebar or a record tab. A change pushed
// meanwhile is read when it is next shown.

export function needsUnderstanding(a: { hiwOpen: boolean; activeKind: string | undefined }): boolean {
  return a.hiwOpen || a.activeKind === 'record'
}
