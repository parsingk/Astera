import { useEffect, useState } from 'react'

/** Whether the window is shown: false while it is minimised or hidden (the window's X hides it to the tray on Windows
 *  and macOS), followed through `visibilitychange`. */
export function useDocumentShown(): boolean {
  const [shown, setShown] = useState(() => !document.hidden)
  useEffect(() => {
    const onChange = (): void => setShown(!document.hidden)
    onChange()
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])
  return shown
}
