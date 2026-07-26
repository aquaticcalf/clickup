import * as cheerio from "cheerio"

export interface SearchHit {
  title: string
  url: string
  snippet: string
  backend: string
  score: number
  consensus: number
}

export interface SearchResponse {
  results: SearchHit[]
  backendStatus: Record<string, string>
}

interface RawHit {
  title: string
  url: string
  snippet: string
}

interface Backend {
  name: string
  search(query: string, recency: string | undefined, signal: AbortSignal): Promise<RawHit[]>
}

const REQUEST_TIMEOUT_MS = 8_000
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
])

function clean(value: string | undefined | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim()
}

function decodeHtml(value: string): string {
  const $ = cheerio.load(`<span>${value}</span>`, { xmlMode: false })
  return clean($("span").text())
}

function unwrapUrl(raw: string): string {
  const value = raw.startsWith("//") ? `https:${raw}` : raw
  try {
    const url = new URL(value)
    const uddg = url.searchParams.get("uddg")
    if (uddg) return decodeURIComponent(uddg)
    const bing = url.searchParams.get("u")
    if (url.hostname.includes("bing.com") && bing?.startsWith("a1")) {
      const bytes = Buffer.from(bing.slice(2), "base64url").toString("utf8")
      if (bytes.startsWith("http://") || bytes.startsWith("https://")) return bytes
    }
    if (url.pathname.includes("/RU=")) {
      const encoded = url.pathname.split("/RU=", 2)[1]?.split("/RK=", 1)[0]
      if (encoded) return decodeURIComponent(encoded)
    }
    return url.toString()
  } catch {
    return raw
  }
}

function normalizeUrl(raw: string): string {
  const unwrapped = unwrapUrl(raw)
  try {
    const url = new URL(unwrapped)
    url.hash = ""
    for (const key of url.searchParams.keys()) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key)
    }
    return url.toString().replace(/\/$/, "")
  } catch {
    return ""
  }
}

function requestSignal(parent: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const onAbort = () => controller.abort()
  parent.addEventListener("abort", onAbort, { once: true })
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout)
      parent.removeEventListener("abort", onAbort)
    },
  }
}

async function fetchText(url: string, init: RequestInit, parent: AbortSignal): Promise<string> {
  const request = requestSignal(parent)
  const headers = new Headers(init.headers)
  if (!headers.has("user-agent")) headers.set("user-agent", USER_AGENT)
  if (!headers.has("accept"))
    headers.set("accept", "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8")
  try {
    const response = await fetch(url, {
      ...init,
      signal: request.signal,
      headers,
    })
    if (!response.ok) throw new Error(`http_${response.status}`)
    return response.text()
  } finally {
    request.dispose()
  }
}

function parseHtmlResults(
  html: string,
  selectors: {
    cards: string
    title: string
    snippet: string
  },
): RawHit[] {
  const $ = cheerio.load(html)
  const results: RawHit[] = []
  $(selectors.cards).each((_index, element) => {
    const link = $(element).find(selectors.title).first()
    const href = link.attr("href")
    const title = clean(link.text())
    if (!href || !title || title.length < 2) return
    if (/^(skip to content|accessibility feedback|sign in|privacy|terms)$/i.test(title)) return
    results.push({
      title: decodeHtml(title),
      url: unwrapUrl(href),
      snippet: decodeHtml($(element).find(selectors.snippet).first().text()),
    })
  })
  return results
}

const duckduckgo: Backend = {
  name: "duckduckgo",
  async search(query, recency, signal) {
    const body = new URLSearchParams({ q: query, b: "", l: "us-en" })
    if (recency)
      body.set(
        "df",
        recency === "day" ? "d" : recency === "week" ? "w" : recency === "month" ? "m" : "y",
      )
    const html = await fetchText(
      "https://html.duckduckgo.com/html/",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          referer: "https://html.duckduckgo.com/",
        },
        body,
      },
      signal,
    )
    return parseHtmlResults(html, {
      cards: ".result",
      title: "a.result__a",
      snippet: ".result__snippet",
    }).slice(0, 10)
  },
}

const mojeek: Backend = {
  name: "mojeek",
  async search(query, _recency, signal) {
    const html = await fetchText(
      `https://www.mojeek.com/search?q=${encodeURIComponent(query)}`,
      {},
      signal,
    )
    return parseHtmlResults(html, {
      cards: "ul.results > li",
      title: "h2 a",
      snippet: "p.s",
    }).slice(0, 10)
  },
}

const yahoo: Backend = {
  name: "yahoo",
  async search(query, _recency, signal) {
    const html = await fetchText(
      `https://search.yahoo.com/search?p=${encodeURIComponent(query)}`,
      {},
      signal,
    )
    return parseHtmlResults(html, {
      cards: ".algo, .algo-sr, .relsrch",
      title: "h3 a, h2 a",
      snippet: ".compText, .Text, p",
    }).slice(0, 10)
  },
}

const bing: Backend = {
  name: "bing-http",
  async search(query, recency, signal) {
    const params = new URLSearchParams({ q: query, count: "10" })
    if (recency) params.set("freshness", recency)
    const html = await fetchText(`https://www.bing.com/search?${params}`, {}, signal)
    return parseHtmlResults(html, {
      cards: ".b_algo",
      title: "h2 a",
      snippet: ".b_caption, p",
    }).slice(0, 10)
  },
}

const wikipedia: Backend = {
  name: "wikipedia",
  async search(query, _recency, signal) {
    const params = new URLSearchParams({
      action: "opensearch",
      profile: "fuzzy",
      limit: "5",
      search: query,
      format: "json",
      origin: "*",
    })
    const text = await fetchText(`https://en.wikipedia.org/w/api.php?${params}`, {}, signal)
    const data = JSON.parse(text) as [string, string[], string[], string[]]
    return (data[1] ?? []).map((title, index) => ({
      title,
      url:
        data[3]?.[index] ??
        `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
      snippet: data[2]?.[index] ?? "",
    }))
  },
}

const backends: Backend[] = [duckduckgo, mojeek, yahoo, bing, wikipedia]

function titleRelevance(query: string, title: string): number {
  const terms = query.toLowerCase().split(/\W+/).filter(Boolean)
  const haystack = title.toLowerCase()
  return terms.length === 0
    ? 0
    : terms.filter((term) => haystack.includes(term)).length / terms.length
}

export async function multiSearch(
  query: string,
  maxResults: number,
  recency: string | undefined,
  signal: AbortSignal | undefined,
): Promise<SearchResponse> {
  const effectiveSignal = signal ?? new AbortController().signal
  const settled = await Promise.allSettled(
    backends.map(async (backend) => ({
      backend: backend.name,
      results: await backend.search(query, recency, effectiveSignal),
    })),
  )
  const backendStatus: Record<string, string> = {}
  const grouped = new Map<string, SearchHit>()

  for (const result of settled) {
    if (result.status === "rejected") continue
    backendStatus[result.value.backend] = result.value.results.length > 0 ? "ok" : "empty"
    result.value.results.forEach((hit, index) => {
      const url = normalizeUrl(hit.url)
      if (!url) return
      const existing = grouped.get(url)
      if (existing) {
        existing.consensus += 1
        existing.score += 1.5
        if (!existing.snippet && hit.snippet) existing.snippet = hit.snippet
        return
      }
      grouped.set(url, {
        title: hit.title,
        url,
        snippet: hit.snippet,
        backend: result.value.backend,
        score: 10 - index + titleRelevance(query, hit.title) * 3,
        consensus: 1,
      })
    })
  }

  for (const backend of backends) {
    if (!(backend.name in backendStatus)) backendStatus[backend.name] = "error"
  }

  const results = [...grouped.values()]
    .sort((left, right) => right.score - left.score || right.consensus - left.consensus)
    .slice(0, maxResults)
  return { results, backendStatus }
}
