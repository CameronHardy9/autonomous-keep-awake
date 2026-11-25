const checkbox = document.getElementById('enabled')
const statusLine = document.getElementById('status')
const sessionLine = document.getElementById('session')
const editorView = document.getElementById('editor-view')
const elsewhereMessage = document.getElementById('elsewhere')

let enabled = null
let limitMinutes = null // the active session's limit, or what a new session would get
let configLimitRequested = false

const formatMinutes = (n) => `${n} minute${n === 1 ? '' : 's'}`

function renderStatus() {
  if (enabled === null) return
  checkbox.checked = enabled
  if (!enabled) {
    statusLine.textContent = 'Off. The interactive browser will automatically disconnect after inactivity.'
  } else if (limitMinutes !== null) {
    statusLine.textContent = `On. The interactive browser session will be kept alive for ${formatMinutes(limitMinutes)} of inactivity on the page.`
  } else {
    statusLine.textContent = '' // filled in once the limit arrives (a few seconds at most)
  }
}

// Session state comes from this tab's content script. A tab without one (any site other
// than Autonomous, or a tab opened before the extension loaded) or an Autonomous page
// whose URL isn't the custom flow editor (onEditor: false) gets the "navigate to the
// editor" view instead of the controls.
async function renderSession() {
  let state = null
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    state = await chrome.tabs.sendMessage(tab.id, { type: 'get-state' })
  } catch {}

  const onEditor = !!state?.onEditor
  editorView.hidden = !onEditor
  elsewhereMessage.hidden = onEditor
  if (!onEditor) return

  if (state.limitReached) {
    sessionLine.textContent = 'Limit reached. Interact with the page or reconnect to the interactive browser to continue.'
  } else if (!state.open) {
    sessionLine.textContent = 'No active session'
  } else if (!state.expiresAt) {
    sessionLine.textContent = 'Starting session timer…'
  } else {
    sessionLine.textContent = `${Math.max(1, Math.ceil((state.expiresAt - Date.now()) / 60_000))} min left`
  }

  // A session keeps the limit it started with; otherwise show what the config gives now.
  if (state.limitMinutes) {
    limitMinutes = state.limitMinutes
    renderStatus()
  } else if (!configLimitRequested) {
    configLimitRequested = true
    chrome.runtime
      .sendMessage({ type: 'get-limit' })
      .then((limit) => {
        if (limit?.minutes && limitMinutes === null) {
          limitMinutes = limit.minutes
          renderStatus()
        }
      })
      .catch(() => {})
  }
}

chrome.storage.local.get('enabled').then((r) => {
  enabled = r.enabled !== false
  renderStatus()
})

checkbox.addEventListener('change', () => {
  enabled = checkbox.checked
  chrome.storage.local.set({ enabled })
  renderStatus()
})

renderSession()
setInterval(renderSession, 5000)
