// Runs in the Autonomous app's own JS context (MAIN world) so it can see the app's
// fetch and WebSocket traffic. It only observes: requests and sockets pass through unchanged.
// Findings are posted to content.js (ISOLATED world) with window.postMessage.

(() => {
  // Same host guard as content.js: Autonomous runs on several *autonomous.applitools.com hosts.
  if (!location.hostname.endsWith('autonomous.applitools.com')) return

  const TAG = '__autonomousKeepAwake'
  const EXECUTE_PATH = /\/api\/testsuite-executions\/preview-execute$/
  const REMOTE_BROWSER_PATH = /\/guacamole$/

  const post = (type, data = {}) => window.postMessage({ [TAG]: true, type, ...data }, location.origin)

  // Starting the Interactive Browser POSTs preview-execute; the response's metadata.id
  // is a new ID for every session, so it identifies the session.
  const nativeFetch = window.fetch
  window.fetch = function (input, init) {
    const promise = nativeFetch.apply(this, arguments)
    try {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href)
      if (EXECUTE_PATH.test(url.pathname)) {
        promise
          .then((res) => (res.ok ? res.clone().json() : null))
          .then((body) => {
            const id = body?.metadata?.id
            if (typeof id === 'string') post('execution', { id })
          })
          .catch(() => {})
      }
    } catch {}
    return promise
  }

  // The remote browser is streamed over a Guacamole WebSocket (wss://exec-ws-<region>.applitools.com/guacamole).
  // It opens when the session connects and closes when the session ends.
  window.WebSocket = new Proxy(window.WebSocket, {
    construct(target, args, newTarget) {
      const ws = Reflect.construct(target, args, newTarget)
      try {
        if (REMOTE_BROWSER_PATH.test(new URL(String(args[0]), location.href).pathname)) {
          ws.addEventListener('open', () => post('remote-browser-open'))
          ws.addEventListener('close', () => post('remote-browser-close'))
        }
      } catch {}
      return ws
    },
  })
})()
