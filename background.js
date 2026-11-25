// Owns one timer per tab. The timer counts down from the user's last activity in the
// session (reported by content.js), so it only runs while the user is idle. The limit
// comes from a staff-controlled remote config, fetched at the start of each session,
// so users cannot change it.

// TODO: replace with the real staff-controlled config URL, and update host_permissions in manifest.json to match.
// It must be HTTPS on an Applitools-controlled host. Expected response: { "maxSessionMinutes": <positive number> }
const CONFIG_URL = 'https://keep-awake-config.invalid/autonomous-keep-awake.json'
const FALLBACK_MINUTES = 30
const CONFIG_TIMEOUT_MS = 5000
const TICK_ALARM = 'tick'

async function fetchLimit() {
  try {
    // credentials: 'omit' so no cookies are ever sent with the config request.
    const res = await fetch(CONFIG_URL, {
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS),
    })
    if (res.ok) {
      const minutes = (await res.json())?.maxSessionMinutes
      if (Number.isFinite(minutes) && minutes > 0) return { minutes, source: 'remote' }
    }
  } catch {}
  return { minutes: FALLBACK_MINUTES, source: 'fallback' }
}

// Per-tab records live in session storage: in memory, cleared when the browser closes,
// and not readable by content scripts.
const keyFor = (tabId) => `tab:${tabId}`

async function getRecord(tabId) {
  return (await chrome.storage.session.get(keyFor(tabId)))[keyFor(tabId)]
}

async function getAllRecords() {
  const all = await chrome.storage.session.get(null)
  return Object.entries(all)
    .filter(([key]) => key.startsWith('tab:'))
    .map(([key, record]) => [Number(key.slice(4)), record])
}

async function removeRecord(tabId) {
  await chrome.storage.session.remove(keyFor(tabId))
  await chrome.alarms.clear(`expire:${tabId}`)
  await updateBadge(tabId, null)
}

async function startSession(tabId, sessionId) {
  const previous = await getRecord(tabId)
  let record
  if (previous && sessionId && previous.sessionId === sessionId) {
    // Same session reconnecting (e.g. a dropped socket): keep its clock.
    record = { ...previous, open: true, limitReached: false }
  } else {
    const startedAt = Date.now()
    const { minutes, source } = await fetchLimit()
    record = {
      sessionId,
      startedAt,
      lastActivityAt: startedAt,
      limitMinutes: minutes,
      limitSource: source,
      expiresAt: startedAt + minutes * 60_000,
      open: true,
      limitReached: false,
    }
  }
  return saveOpenRecord(tabId, record)
}

async function recordActivity(tabId) {
  const record = await getRecord(tabId)
  if (!record?.open) return record ?? null
  const now = Date.now()
  return saveOpenRecord(tabId, { ...record, lastActivityAt: now, expiresAt: now + record.limitMinutes * 60_000 })
}

async function saveOpenRecord(tabId, record) {
  await chrome.storage.session.set({ [keyFor(tabId)]: record })
  await chrome.alarms.create(`expire:${tabId}`, { when: Math.max(record.expiresAt, Date.now() + 1000) })
  if (!(await chrome.alarms.get(TICK_ALARM))) await chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 })
  await updateBadge(tabId, record)
  return record
}

// limitReached: the session closed after its limit ran out. Keep showing that until a
// new session starts or the page reloads.
async function endSession(tabId, limitReached) {
  const record = await getRecord(tabId)
  if (!record) return
  // Keep the record so a reconnect of the same session resumes its clock.
  const ended = { ...record, open: false, limitReached: !!limitReached }
  await chrome.storage.session.set({ [keyFor(tabId)]: ended })
  await chrome.alarms.clear(`expire:${tabId}`)
  await updateBadge(tabId, ended)
}

// Badge phases by minutes left (as shown on the badge): green above 10, yellow 6-10,
// red 5 and under and for the `!` limit-reached state. Yellow gets dark text for contrast.
const BADGE_PHASES = {
  plenty: { background: '#0B6E69', text: '#FFFFFF' },
  warning: { background: '#F4C430', text: '#1F1A00' },
  critical: { background: '#B3261E', text: '#FFFFFF' },
}

function badgeFor(record) {
  if (record?.limitReached && !record.open) return { text: '!', phase: BADGE_PHASES.critical }
  if (!record?.open) return null
  const remaining = record.expiresAt - Date.now()
  if (remaining <= 0) return { text: '!', phase: BADGE_PHASES.critical }
  const minutes = Math.ceil(remaining / 60_000)
  const phase = minutes > 10 ? BADGE_PHASES.plenty : minutes > 5 ? BADGE_PHASES.warning : BADGE_PHASES.critical
  return { text: `${minutes}m`, phase }
}

async function updateBadge(tabId, record) {
  try {
    const badge = badgeFor(record)
    if (!badge) {
      await chrome.action.setBadgeText({ tabId, text: '' })
      return
    }
    await chrome.action.setBadgeBackgroundColor({ tabId, color: badge.phase.background })
    await chrome.action.setBadgeTextColor({ tabId, color: badge.phase.text })
    await chrome.action.setBadgeText({ tabId, text: badge.text })
  } catch {
    // The tab is gone.
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // From the popup: the limit a session started now would get.
  if (message?.type === 'get-limit') {
    fetchLimit().then(sendResponse, () => sendResponse({ minutes: FALLBACK_MINUTES, source: 'fallback' }))
    return true
  }
  const tabId = sender.tab?.id
  if (tabId === undefined) return
  const handlers = {
    'session-start': () => startSession(tabId, message.sessionId ?? null),
    'session-end': () => endSession(tabId, message.limitReached),
    activity: () => recordActivity(tabId),
    'page-loaded': () => removeRecord(tabId),
  }
  const handler = handlers[message?.type]
  if (!handler) return
  handler().then(sendResponse, () => sendResponse(null))
  return true // respond asynchronously
})

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name.startsWith('expire:')) {
    const tabId = Number(alarm.name.slice(7))
    await updateBadge(tabId, await getRecord(tabId))
    return
  }
  if (alarm.name !== TICK_ALARM) return
  let anyShown = false
  for (const [tabId, record] of await getAllRecords()) {
    if (!record.open && !record.limitReached) continue
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'ping' })
      anyShown = true
      await updateBadge(tabId, record)
    } catch {
      // The tab navigated away or closed without telling us.
      await removeRecord(tabId)
    }
  }
  if (!anyShown) await chrome.alarms.clear(TICK_ALARM)
})

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(keyFor(tabId))
  chrome.alarms.clear(`expire:${tabId}`)
})
