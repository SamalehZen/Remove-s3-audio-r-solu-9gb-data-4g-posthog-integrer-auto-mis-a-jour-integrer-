const noop = (..._args: any[]) => {}
export const init = noop
export const captureException = noop
export const captureMessage = noop
export const setUser = noop
export const setTag = noop
export const setExtra = noop
export const addBreadcrumb = noop
export const withScope = (cb: (scope: any) => void) => cb({ setTag: noop, setExtra: noop })
export const startSpan = noop
export default { init, captureException, captureMessage, setUser, setTag, setExtra, addBreadcrumb, withScope, startSpan }
