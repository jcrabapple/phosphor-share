// Phosphor Share: popup logic. Talks to background.js via chrome.runtime messages.
const BASE = 'https://bbs.snakepit.us';
const $ = (id) => document.getElementById(id);

const shareView = $('share-view');
const statusView = $('status-view');
const settingsView = $('settings-view');
const shareBtn = $('share-btn');
const pageTitle = $('page-title');
const shareResult = $('share-result');
const settingsResult = $('settings-result');
const statusNote = $('status-note');

let base = BASE; // replaced by devBase (dev builds only) before anything renders
let sourceTab = null; // the page being shared
let settingsMode = false;
let shareBlocked = false; // true when the source page can't be shared at all
let onPhosphor = false; // the source page is Phosphor itself: hide the form, show a note
const restingNote = () => (onPhosphor ? 'You are already on Phosphor. Nothing to share here.' : '');

const send = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));

function setNote(text, kind = 'info') {
	statusNote.textContent = text;
	statusNote.className = `note ${kind}`;
	statusNote.hidden = !text;
}

function showResult(el, ok, message, linkUrl) {
	el.className = `result ${ok ? 'ok' : 'err'}`;
	el.replaceChildren(document.createTextNode(message));
	if (linkUrl) {
		el.appendChild(document.createTextNode(' '));
		const a = document.createElement('a');
		a.href = linkUrl;
		a.target = '_blank';
		a.textContent = 'Open it';
		el.appendChild(a);
	}
}

function renderTally(data) {
	const unread = data.unread ?? null;
	const mail = data.mail ?? null;
	$('unread-count').textContent = unread === null ? '–' : String(unread);
	$('mail-count').textContent = mail === null ? '–' : String(mail);
	$('alerts-link').classList.toggle('hot', unread > 0);
	$('mail-link').classList.toggle('hot', mail > 0);
	$('fetched-at').textContent = data.fetchedAt ? `checked ${new Date(data.fetchedAt).toLocaleTimeString()}` : '';
}

/** Categories into the select, restoring the last one used if it's still offered. */
async function renderCategories(groups) {
	if (!Array.isArray(groups)) return;
	const select = $('share-category');
	const previous = select.value;
	const { lastCategoryId } = await chrome.storage.local.get('lastCategoryId');
	select.replaceChildren();
	for (const group of groups) {
		const og = document.createElement('optgroup');
		og.label = group.name;
		for (const c of group.categories) {
			const opt = document.createElement('option');
			opt.value = String(c.id);
			opt.textContent = c.name;
			og.appendChild(opt);
		}
		select.appendChild(og);
	}
	const ids = groups.flatMap((g) => g.categories.map((c) => String(c.id)));
	const want = previous || (lastCategoryId != null ? String(lastCategoryId) : '');
	if (ids.includes(want)) select.value = want;
	updateShareEnabled();
}

function updateShareEnabled() {
	shareBtn.disabled = shareBlocked || !sourceTab || !$('share-category').value;
}

/**
 * The page to share is the active tab of the window the popup belongs to. There is no
 * fallback to "some other tab": sharing a page the user isn't looking at is worse than
 * sharing nothing. Test harnesses (which can't open a real popup) pass ?tab=<id>.
 */
async function loadSourceTab() {
	const forced = Number(new URLSearchParams(location.search).get('tab'));
	let tab = null;
	try {
		if (Number.isInteger(forced) && forced > 0) {
			tab = await chrome.tabs.get(forced);
		} else {
			[tab] = await chrome.tabs.query({ active: true, currentWindow: true });
		}
	} catch {
		tab = null;
	}
	sourceTab = null;
	let url = null;
	try {
		url = tab && tab.url ? new URL(tab.url) : null;
	} catch {
		url = null;
	}
	if (!url || !/^https?:$/.test(url.protocol)) {
		shareBlocked = true;
		pageTitle.textContent = tab && tab.title ? tab.title : '(no page)';
		showResult(shareResult, false, 'This page has no shareable web address.');
	} else if (url.origin === base) {
		shareBlocked = true;
		onPhosphor = true;
		shareView.hidden = true;
		setNote(restingNote());
	} else {
		sourceTab = tab;
		pageTitle.textContent = tab.title || url.hostname;
		$('share-title').value = (tab.title || url.hostname).slice(0, 200);
	}
	updateShareEnabled();
}

/** Apply a getContext reply: counts + categories on success, a visible reason on failure. */
function onContext(ctx) {
	if (ctx && ctx.ok) {
		setNote(restingNote());
		renderTally(ctx);
		renderCategories(ctx.categories);
		return;
	}
	const error = (ctx && ctx.error) || 'Could not refresh from Phosphor.';
	setNote(error, ctx && ctx.status === 401 ? 'err' : 'warn');
	if (ctx && ctx.status === 401) {
		// The cached counts belong to a dead token; don't present them as current.
		renderTally({});
	}
}

async function setView(toSettings) {
	settingsMode = toSettings;
	$('settings-toggle').setAttribute('aria-pressed', String(toSettings));
	$('settings-toggle').textContent = toSettings ? 'BACK' : 'SET';
	statusView.hidden = toSettings;
	shareView.hidden = toSettings || onPhosphor;
	settingsView.hidden = !toSettings;
	if (toSettings) {
		settingsResult.textContent = '';
		$('settings-token').value = '';
		$('settings-token').focus();
	}
}

// --- share ----------------------------------------------------------------

$('share-category').addEventListener('change', updateShareEnabled);

$('share-form').addEventListener('submit', async (ev) => {
	ev.preventDefault();
	const categoryId = Number($('share-category').value);
	if (!sourceTab || shareBtn.disabled || !Number.isInteger(categoryId)) return;
	shareBtn.disabled = true;
	shareBtn.textContent = 'POSTING…';
	const res = await send({
		type: 'share',
		payload: {
			categoryId,
			title: $('share-title').value.trim(),
			url: sourceTab.url,
			comment: $('share-comment').value.trim()
		}
	});
	shareBtn.textContent = 'SHARE TO PHOSPHOR';
	updateShareEnabled();
	if (res && res.ok) {
		await chrome.storage.local.set({ lastCategoryId: categoryId });
		showResult(shareResult, true, 'Topic created.', res.url);
		$('share-comment').value = '';
	} else {
		showResult(shareResult, false, (res && res.error) || 'Posting failed.');
	}
});

// --- settings -------------------------------------------------------------

$('settings-toggle').addEventListener('click', () => setView(!settingsMode));

$('settings-form').addEventListener('submit', async (ev) => {
	ev.preventDefault();
	const token = $('settings-token').value.trim();
	if (!token) return;
	// Firefox before ~127 doesn't grant MV3 host permissions at install. Asking inside
	// this click (before any other await) is a no-op where they're already granted.
	try {
		const granted = await chrome.permissions.request({ origins: [`${base}/*`] });
		if (!granted) {
			showResult(settingsResult, false, `The extension needs permission to talk to ${base}.`);
			return;
		}
	} catch {
		/* origin not requestable (dev builds); the fetch below reports the real problem */
	}
	const res = await send({ type: 'saveToken', token });
	if (res && res.ok) {
		showResult(settingsResult, true, 'Token verified.');
		const ctx = await send({ type: 'getContext' });
		onContext(ctx);
		setTimeout(() => setView(false), 400);
	} else {
		showResult(settingsResult, false, (res && res.error) || 'Could not verify that token.');
	}
});

// --- first paint ------------------------------------------------------------

(async () => {
	const { devBase, context, token, tokenRejected } = await chrome.storage.local.get(['devBase', 'context', 'token', 'tokenRejected']);
	if (devBase) base = String(devBase).replace(/\/+$/, '');
	$('alerts-link').href = `${base}/notifications`;
	$('mail-link').href = `${base}/mail`;

	// Cached state first so the popup is usable even if the refresh fails.
	if (context && !tokenRejected) {
		renderTally(context);
		await renderCategories(context.categories);
	}
	await loadSourceTab();

	if (!token) {
		setNote('No token yet. Tap SET and paste one from Phosphor settings.');
		return;
	}
	onContext(await send({ type: 'getContext' }));
})();
