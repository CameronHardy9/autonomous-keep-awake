// Keeps an Autonomous Interactive Browser session alive while the user has been idle
// for less than a staff-controlled time limit. While a session is open in this tab and
// the user's last activity is within the limit, clicks the inactivity modal's confirm
// button as soon as it appears.
//
// A session is detected two ways, and whichever fires first wins:
//   - page-hook.js reports the Guacamole WebSocket opening/closing, plus the session ID
//   - the remote browser element appearing/disappearing in the DOM
//
// User activity mirrors the app's own rule: the app treats the user as active while
// navigator.userActivation.isActive, which only a real pointerdown or keydown (anywhere
// on the page) sets. Mouse moves and scrolling don't count. Our own button.click() is
// synthetic (isTrusted false), so it never counts as activity.
//
// The background worker owns the timer; this script enforces it at click time.

(() => {
  // The manifest matches all of *.applitools.com because Autonomous runs on several hosts
  // (autonomous.applitools.com, <company>autonomous.applitools.com, ...). Only run on those.
  if (!location.hostname.endsWith('autonomous.applitools.com')) return

  const TAG = '__autonomousKeepAwake'
  const STORAGE_KEY = 'enabled'
  const MODAL_CONFIRM = '.interactionTimeoutModal button.confirmButton'
  const REMOTE_BROWSER = '.guacamoleComponent.guacamoleBrowser'
  // The custom flow editor: /applications/<appId>/tests/edit/<testId> or /applications/<appId>/tests/new/custom-flow
  const EDITOR_PATH = /^\/applications\/[^/]+\/tests\/(edit\/[^/]+|new\/custom-flow)\/?$/
  const ACTIVITY_REPORT_INTERVAL_MS = 15_000

  let enabled = true
  let executionId = null // latest session ID reported by page-hook.js
  let open = false // a remote browser session is open in this tab
  let session = null // { sessionId, limitMinutes, expiresAt, ... } from the background worker
  let limitReached = false // the limit ran out; stays true after the session closes, until a new one opens
  let domPresent = false
  let lastActivityReport = 0

  const isExpired = () => !!session && Date.now() >= session.expiresAt

  function sessionOpened() {
    if (open) return
    open = true
    limitReached = false
    chrome.runtime
      .sendMessage({ type: 'session-start', sessionId: executionId })
      .then((record) => {
        if (!open || !record) return
        session = record
        dismissTimeoutModal()
      })
      .catch(() => {})
  }

  function sessionClosed() {
    if (!open) return
    open = false
    limitReached = isExpired()
    session = null
    chrome.runtime.sendMessage({ type: 'session-end', limitReached }).catch(() => {})
  }

  function onUserActivity(event) {
    if (!event.isTrusted || !open) return
    const now = Date.now()
    const wasExpired = isExpired()
    if (session) session.expiresAt = now + session.limitMinutes * 60_000
    if (wasExpired) console.log('[Keep Awake] User activity after the time limit. Timer reset.')
    limitReached = false
    // Throttle reports to the worker, but report right away when the timer had run out.
    if (!wasExpired && now - lastActivityReport < ACTIVITY_REPORT_INTERVAL_MS) return
    lastActivityReport = now
    chrome.runtime
      .sendMessage({ type: 'activity' })
      .then((record) => {
        if (open && record) session = record
      })
      .catch(() => {})
  }

  function dismissTimeoutModal() {
    if (!enabled || !open) return
    const button = document.querySelector(MODAL_CONFIRM)
    if (!button) return
    // While the worker is still fetching the limit (a few seconds at most), session is null: allow.
    if (isExpired()) {
      if (!limitReached) {
        console.log('[Keep Awake] Time limit reached. Leaving the inactivity prompt for the user.')
        limitReached = true
      }
      return
    }
    button.click()
    console.log('[Keep Awake] Dismissed inactivity prompt at', new Date().toLocaleTimeString())
  }

  // DOM signal: act only on transitions, so it never overrides the WebSocket signal.
  function onMutations() {
    const present = !!document.querySelector(REMOTE_BROWSER)
    if (present !== domPresent) {
      domPresent = present
      present ? sessionOpened() : sessionClosed()
    }
    dismissTimeoutModal()
  }

  // Messages from page-hook.js. Only accept ones posted by this window.
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.[TAG] !== true) return
    const { type, id } = event.data
    if (type === 'execution') executionId = id
    else if (type === 'remote-browser-open') sessionOpened()
    else if (type === 'remote-browser-close') sessionClosed()
  })

  // Capture phase on window, so the app can't stop these before we see them.
  window.addEventListener('pointerdown', onUserActivity, true)
  window.addEventListener('keydown', onUserActivity, true)

  // Messages from the popup and background worker.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'ping') sendResponse({ open })
    else if (message?.type === 'get-state') {
      sendResponse({
        onEditor: EDITOR_PATH.test(location.pathname), // the app is a SPA: read the current URL each time
        open,
        expiresAt: session?.expiresAt ?? null,
        limitMinutes: session?.limitMinutes ?? null,
        limitReached: limitReached || (open && isExpired()),
      })
    }
  })

  // On by default: only an explicit `false` disables it.
  chrome.storage.local
    .get(STORAGE_KEY)
    .then((r) => (enabled = r[STORAGE_KEY] !== false))
    .catch(() => {})
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && STORAGE_KEY in changes) {
      enabled = changes[STORAGE_KEY].newValue !== false
      dismissTimeoutModal() // in case the modal is already open
    }
  })

  // A new document means any earlier session in this tab is gone (a refresh closes it).
  chrome.runtime.sendMessage({ type: 'page-loaded' }).catch(() => {})

  new MutationObserver(onMutations).observe(document, { childList: true, subtree: true })
})()
