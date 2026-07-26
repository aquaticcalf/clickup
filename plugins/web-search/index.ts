import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { Page } from "playwright-core";
import { BraveBrowser } from "./browser.ts";
import { multiSearch, type SearchResponse } from "./search.ts";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface SearchDetails {
  query: string;
  results: SearchResult[];
}

function output(text: string, maxBytes = DEFAULT_MAX_BYTES): string {
  const result = truncateHead(text, { maxBytes, maxLines: DEFAULT_MAX_LINES });
  if (!result.truncated) return result.content;
  return `${result.content}\n\n[Output truncated: ${result.outputLines} of ${result.totalLines} lines.]`;
}

function validateUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The URL is invalid.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs are allowed.");
  }
  return url.toString();
}

async function pageSummary(page: Page): Promise<string> {
  const title = await page.title().catch(() => "");
  const text = await BraveBrowser.readPage(page).catch(() => "");
  return [`Title: ${title || "(untitled)"}`, `URL: ${page.url()}`, "", output(text, 20_000)].join("\n");
}


function formatSearchResults(query: string, response: SearchResponse): string {
  if (response.results.length === 0) {
    return `No results for: ${query}\nBackends: ${JSON.stringify(response.backendStatus)}`;
  }

  const lines = [`Search results for: ${query}`, ""];
  response.results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.title}`, `   ${result.url}`);
    if (result.snippet) lines.push(`   ${result.snippet}`);
    lines.push("");
  });
  return lines.join("\n");
}

export default function webSearch(pi: ExtensionAPI): void {
  const brave = new BraveBrowser();

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web when current web information or external sources are needed.",
    parameters: Type.Object({
      query: Type.String({ description: "The web search query" }),
      maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
      recency: Type.Optional(StringEnum(["day", "week", "month", "year"] as const)),
    }),
    renderCall(args, theme) {
      const query = String(args.query ?? "").replace(/\s+/g, " ").trim();
      const shown = query.length > 72 ? `${query.slice(0, 69)}...` : query;
      return new Text(
        theme.fg("toolTitle", theme.bold("Web Search: ")) + theme.fg("accent", `"${shown}"`),
        0,
        0,
      );
    },
    async execute(_toolCallId, params, signal) {
      const query = params.query.trim();
      if (!query) throw new Error("A search query is required.");
      if (query.length > 500) throw new Error("The search query is limited to 500 characters.");

      const response = await multiSearch(query, params.maxResults ?? 5, params.recency, signal);
      const text = formatSearchResults(query, response);
      const results: SearchResult[] = response.results.map(({ title, url, snippet }) => ({ title, url, snippet }));
      const details: SearchDetails = { query, results };
      return { content: [{ type: "text", text: output(text) }], details };
    },
  });

  pi.registerTool({
    name: "browser_open",
    label: "Open Web Page",
    description: "Open an http or https URL in the temporary browser session.",
    parameters: Type.Object({
      url: Type.String({ description: "The http or https URL to open" }),
    }),
    renderCall(args, theme) {
      const url = String(args.url ?? "").replace(/\s+/g, " ").trim();
      const shown = url.length > 72 ? `${url.slice(0, 69)}...` : url;
      return new Text(
        theme.fg("toolTitle", theme.bold("Browser Open: ")) + theme.fg("accent", `"${shown}"`),
        0,
        0,
      );
    },
    async execute(_toolCallId, params, signal) {
      const url = validateUrl(params.url);
      return brave.run(signal, async (page) => {
        await BraveBrowser.navigate(page, url, signal);
        return {
          content: [{ type: "text", text: await pageSummary(page) }],
          details: { url: page.url(), title: await page.title().catch(() => "") },
        };
      });
    },
  });

  pi.on("agent_settled", async () => {
    await brave.close();
  });

  pi.on("session_shutdown", async () => {
    await brave.close();
  });
}
