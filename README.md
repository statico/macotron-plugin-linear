# Linear for Macotron

Search your [Linear](https://linear.app) issues from the [Macotron](https://github.com/statico/macotron) launch bar. Type a couple of characters, see matching tickets, hit Enter to open one in your browser.

- Full-text search across your whole workspace
- Shows issue identifier, title, state, and assignee
- Results appear below whatever you literally typed, so they never hijack the launch bar
- API key lives in the macOS Keychain, not in `settings.json`
- Debounced and cached, so typing a word is a couple of requests rather than one per keystroke

## Install

1. Open Macotron Settings → Plugins → Catalog → Community.
2. Click Add and paste this repo: `statico/macotron-plugin-linear`.
3. Read the source in the review sheet, then click Add again.

Macotron scans the plugin before it runs.

## Setup

Get a personal API key from Linear: **Settings → Security & access → Personal API keys → New key**. Paste it into the plugin's API key field in Macotron Settings.

The key is user-scoped and does not expire. Anyone holding it can read and write your Linear workspace, so treat it like a password — Macotron keeps it in the Keychain, and it is never written to `settings.json` or the log.

## How it works

One `POST` to `https://api.linear.app/graphql` per search, using the `searchIssues` field. The key travels in the `Authorization` header raw, with no `Bearer ` prefix — that prefix is for OAuth access tokens, and sending it with a personal key fails.

Issue URLs are cached in `localStorage` so a saved launch-bar shortcut still opens the right ticket after the plugin reloads and the original row closure is gone.

## Test

```sh
node test.js
```

## License

MIT
