# web search

adds multi-backend HTTP search plus temporary browser tools:

- `web_search` runs DuckDuckGo, Mojeek, Yahoo, Bing, and Wikipedia in parallel, then deduplicates and ranks by title relevance and backend consensus.
- `browser_open`

search does not launch Brave. Brave is launched lazily only when a browser tool is called. it runs with a temporary profile and a localhost-only chrome devtools protocol port. the browser is closed when the agent settles, when the session shuts down, when `browser_close` is called, or after the five-minute safety limit.

set `BRAVE_PATH` if brave is not installed in a standard location.

this plugin requires `playwright-core`, but does not download or install another browser.
