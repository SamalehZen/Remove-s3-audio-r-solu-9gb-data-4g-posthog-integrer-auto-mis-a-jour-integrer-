const log = {
  info: console.log,
  warn: console.warn,
  error: console.error,
  debug: console.debug,
  verbose: console.debug,
  silly: console.debug,
  log: console.log,
  functions: {
    info: console.log,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
    log: console.log,
  },
  transports: {
    file: {
      getFile: () => ({ path: '' }),
    },
  },
}
export default log
