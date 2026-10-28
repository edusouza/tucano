// Which system the app runs on, read the same way in the core (Node) and in the
// window (a sandboxed page with no `process`): both have navigator.platform.
export const onWindows = typeof navigator !== 'undefined' && /^win/i.test(navigator.platform)

// What the person's computer is called where the app offers it to an agent ("This Mac", "This PC").
// The same word in both languages, so it can be a constant.
export const MACHINE = onWindows ? 'PC' : 'Mac'

// The shortcut modifier: ⌘ on the Mac, Ctrl on Windows. `mod` is how a shortcut is written ("⌘K", "Ctrl+K").
export const mod = onWindows ? 'Ctrl+' : '⌘'
export const modDown = (e: { metaKey: boolean; ctrlKey: boolean }): boolean => (onWindows ? e.ctrlKey && !e.metaKey : e.metaKey && !e.ctrlKey)
