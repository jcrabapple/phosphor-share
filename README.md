# Phosphor Share

Browser extension for [Phosphor](https://bbs.snakepit.us), a retro bulletin board.
It shares whatever page you're reading as a new topic on Phosphor and puts an
unread-alerts badge on the toolbar icon. Chrome and Firefox, one codebase, no build
step, no dependencies.

**Install instructions and downloads: https://bbs.snakepit.us/extensions**

Downloads are on the [releases page](https://github.com/jcrabapple/phosphor-share/releases/latest).
This repo is a published mirror; development happens alongside the Phosphor server.

## What it sends, and where

Only to `https://bbs.snakepit.us`, and only:

- every 5 minutes (and when a Phosphor tab finishes loading): a request for your unread
  alert and mail counts plus the categories you can post in;
- when you press Share: the page's address, the title you typed, your chosen category and
  your optional comment.

It never reads page contents, browsing history, or any other site. The extension token
lives in the browser's local extension storage, never synced. Revoke it any time from
Phosphor's Settings; changing your Phosphor password revokes it too.

## How it works

- `manifest.json`: Manifest V3. `background.service_worker` (Chrome) and
  `background.scripts` (Firefox) point at the same file; each browser ignores the other.
- `background.js`: polling, badge, Bearer-token auth, message API for the popup.
- `popup.html/css/js`: share form, alert/mail tallies, token setup.
- `icons/`: amber-on-black "P".

The token is a per-account Bearer credential minted on Phosphor's Settings page, because
Phosphor's session cookie (`SameSite=lax`) never travels with an extension's requests.
The server stores only a hash of it. Shares go through Phosphor's normal posting rules:
filters, slow mode and rate limits all apply.

The server address is fixed to bbs.snakepit.us on purpose: the manifest's
`host_permissions` are fixed and the API sends no CORS headers, so any other address
would simply fail.

## Development

- Load the folder unpacked (`chrome://extensions` with Developer mode on, or Firefox's
  `about:debugging#/runtime/this-firefox`).
- To point a local build at a dev server, run
  `chrome.storage.local.set({ devBase: 'http://127.0.0.1:3499' })` in the extension's
  devtools and add that origin to `host_permissions`. There's no UI for this on purpose.
- Test harnesses can't open a real popup: open `popup.html?tab=<tabId>` to say which tab
  to share. Without the parameter it uses the active tab and never guesses.
- `npx web-ext lint` should report 0 errors. Two warnings are expected: Firefox ignores
  `service_worker`, and `permissions.request` doesn't exist on Firefox for Android.
