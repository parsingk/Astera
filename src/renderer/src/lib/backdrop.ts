// A modal's backdrop that closes only for a press that began on it (audit UI-5). A drag that starts inside the modal
// (selecting a pasted token) and ends outside fires its click on the backdrop, the common ancestor, and the modal closed
// with what was typed in it. What the press landed on is kept per backdrop element, since every render makes new handlers.

type BackdropEvent = { target: unknown; currentTarget: unknown }

const pressedOnBackdrop = new WeakMap<object, boolean>()

export function backdropProps(close: () => unknown): {
  onMouseDown(e: BackdropEvent): void
  onClick(e: BackdropEvent): void
} {
  return {
    onMouseDown: (e) => {
      if (typeof e.currentTarget === 'object' && e.currentTarget !== null) pressedOnBackdrop.set(e.currentTarget, e.target === e.currentTarget)
    },
    onClick: (e) => {
      if (typeof e.currentTarget !== 'object' || e.currentTarget === null) return
      const began = pressedOnBackdrop.get(e.currentTarget)
      pressedOnBackdrop.delete(e.currentTarget)
      if (began === true && e.target === e.currentTarget) close()
    }
  }
}
