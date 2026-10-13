// Phosphor Share: background script. Runs as a Chrome MV3 service worker and as a
// Firefox MV3 event page (same file: no DOM APIs, only fetch/storage/alarms/tabs).
//
// Auth: per-user Bearer token minted on the Phosphor Settings page. The session
// cookie is SameSite=lax and never travels with cross-origin extension fetches.
//
// The server is fixed to BASE because host_permissions are fixed in the manifest
// and the API sends no CORS headers, so a user-configurable URL could never work.
// Developers can point a local build elsewhere by setting `devBase` in
// chrome.storage.local from the extension's devtools AND adding that origin to
// host_permissions. There is deliberately no UI for it.
const BASE = 'https://bbs.snakepit.us';

const BADGE_COLOR = '#b9622e';
const BADGE_ERROR_COLOR = '#c23a3a';
const POLL_ALARM = 'phosphor-poll';
const POLL_MINUTES = 5;

async function settings() {
	const { devBase, token = '' } = await chrome.storage.local.get(['devBase', 'token']);
	return { base: String(devBase || BASE).replace(/\/+$/, ''), token };
}

/** Badge = unread notifications (99+ beyond that), cleared at zero. */
async function setUnreadBadge(unread) {
	if (unread > 0) {
		await chrome.action.setBadgeText({ text: unread > 99 ? '99+' : String(unread) });
		await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
	} else {
		await chrome.action.setBadgeText({ text: '' });
	}
}

async function markTokenRejected() {
	await chrome.action.setBadgeText({ text: '!' });
	await chrome.action.setBadgeBackgroundColor({ color: BADGE_ERROR_COLOR });
	await chrome.storage.local.set({ tokenRejected: true });
}

/**
 * GET /api/extension: unread counts + shareable categories.
 * Returns { ok: true, ...data } or { ok: false, status, error }.
 * A rejected token always flips the badge to "!" (background polls included);
 * transient failures (offline, 5xx) leave the last known badge alone.
 */
async function fetchContext() {
	const { base, token } = await settings();
	if (!token) {
		await chrome.action.setBadgeText({ text: '' });
		return { ok: false, status: 0, error: 'No token yet. Tap SET and paste one from Phosphor settings.' };
	}
	let res;
	try {
		res = await fetch(`${base}/api/extension`, {
			method: 'GET',
			headers: { authorization: 'Bearer ' + token },
			credentials: 'omit',
			signal: AbortSignal.timeout(10_000)
		});
	} catch (err) {
		return { ok: false, status: 0, error: `Could not reach Phosphor (${err && err.message ? err.message : 'network error'}).` };
	}
	if (res.status === 401) {
		await markTokenRejected();
		return {
			ok: false,
			status: 401,
			error: 'Token rejected. It was revoked, regenerated, or your password changed. Generate a new one in Phosphor settings.'
		};
	}
	if (!res.ok) return { ok: false, status: res.status, error: `Phosphor answered ${res.status}. Try again shortly.` };
	const data = await res.json();
	const fetchedAt = Date.now();
	await chrome.storage.local.set({ context: { ...data, fetchedAt }, tokenRejected: false });
	await setUnreadBadge(data.unread);
	return { ok: true, ...data, fetchedAt };
}

/** POST /api/extension: share a page as a new topic. */
async function sharePage({ categoryId, title, url, comment }) {
	const { base, token } = await settings();
	if (!token) return { ok: false, error: 'Set your token first (tap SET).' };
	if (!url || !/^https?:\/\//i.test(url)) return { ok: false, error: 'This page has no shareable URL.' };
	let res;
	try {
		res = await fetch(`${base}/api/extension`, {
			method: 'POST',
			headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
			credentials: 'omit',
			body: JSON.stringify({ categoryId, title, url, comment }),
			signal: AbortSignal.timeout(15_000)
		});
	} catch (err) {
		return { ok: false, error: `Could not reach Phosphor (${err && err.message ? err.message : 'network error'}).` };
	}
	let body = null;
	try {
		body = await res.json();
	} catch {
		/* non-JSON error page */
	}
	if (res.status === 401) await markTokenRejected();
	if (!res.ok) return { ok: false, status: res.status, error: (body && body.error) || `Phosphor answered ${res.status}.` };
	return { ok: true, topicId: body.topicId, url: `${base}${body.path}` };
}

// --- polling ---------------------------------------------------------------

/** Alarms aren't guaranteed to survive a browser restart (Firefox drops them),
 *  so check and (re)create on every background start, not only on install. */
async function ensureAlarm() {
	const existing = await chrome.alarms.get(POLL_ALARM);
	if (!existing) await chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_MINUTES });
}

ensureAlarm();

chrome.runtime.onInstalled.addListener(() => {
	fetchContext();
});

chrome.runtime.onStartup.addListener(() => {
	fetchContext();
});

chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === POLL_ALARM) fetchContext();
});

// Reading alerts on the site clears them server-side. Re-poll when a Phosphor tab
// finishes loading so the badge doesn't lag up to POLL_MINUTES behind.
let tabPollTimer = null;
chrome.tabs.onUpdated.addListener(async (_tabId, info, tab) => {
	if (info.status !== 'complete' || !tab.url) return;
	const { base, token } = await settings();
	if (!token || !tab.url.startsWith(base + '/')) return;
	clearTimeout(tabPollTimer);
	tabPollTimer = setTimeout(fetchContext, 1500);
});

// --- popup message API -----------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
	if (msg.type === 'getContext') {
		fetchContext().then(sendResponse);
		return true; // async sendResponse
	}
	if (msg.type === 'share') {
		sharePage(msg.payload).then(async (result) => {
			if (result.ok) await fetchContext(); // refresh counts after posting
			sendResponse(result);
		});
		return true;
	}
	if (msg.type === 'saveToken') {
		const token = String(msg.token || '').trim();
		if (!token) {
			sendResponse({ ok: false, error: 'Token is empty.' });
			return undefined;
		}
		// Drop the previous account's cached categories/counts before verifying.
		chrome.storage.local
			.remove(['context', 'tokenRejected', 'lastCategoryId'])
			.then(() => chrome.storage.local.set({ token }))
			.then(fetchContext)
			.then((check) => sendResponse(check.ok ? { ok: true } : { ok: false, error: check.error }));
		return true;
	}
	return undefined;
});
