import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { chromium, type Browser, type Page } from "playwright-core";

const execFileAsync = promisify(execFile);
const CDP_WAIT_TIMEOUT_MS = 15_000;
const NAVIGATION_TIMEOUT_MS = 20_000;
const MAX_BROWSER_LIFETIME_MS = 5 * 60 * 1000;

export interface BrowserState {
  page: Page;
  url: string;
}

interface ManagedBrowser {
  browser: Browser;
  child: ChildProcess;
  profileDir: string;
  lifetimeTimer: NodeJS.Timeout;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Browser operation cancelled.");
}

async function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return promise;

  let onAbort: (() => void) | undefined;
  const abort = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("Browser operation cancelled."));
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([promise, abort]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("Could not reserve a local port.");
  return address.port;
}

function braveCandidates(): string[] {
  const envPath = process.env.BRAVE_PATH?.trim();
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  const localAppData = process.env.LOCALAPPDATA;

  return [
    envPath,
    programFiles && join(programFiles, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    programFilesX86 && join(programFilesX86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    localAppData && join(localAppData, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    process.platform !== "win32" ? "brave-browser" : undefined,
    process.platform !== "win32" ? "brave" : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));
}

async function findBrave(): Promise<string> {
  for (const candidate of braveCandidates()) {
    if (candidate.includes("\\") || candidate.includes("/")) {
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Try the next known installation path.
      }
      continue;
    }

    try {
      await execFileAsync(process.platform === "win32" ? "where.exe" : "which", [candidate]);
      return candidate;
    } catch {
      // Try the next executable name.
    }
  }

  throw new Error("Brave Browser was not found. Set BRAVE_PATH to the brave executable.");
}

async function waitForCdp(port: number, child: ChildProcess, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + CDP_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    if (child.exitCode !== null) throw new Error(`Brave exited before CDP became available (code ${child.exitCode}).`);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal });
      if (response.ok) return;
    } catch {
      // Brave may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Timed out waiting for Brave's CDP endpoint.");
}

async function killProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid || child.exitCode !== null) return;

  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"]);
    } catch {
      // The process may have exited between the check and taskkill.
    }
    return;
  }

  child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function launchBrave(signal?: AbortSignal): Promise<ManagedBrowser> {
  const executable = await findBrave();
  const port = await reservePort();
  const profileDir = await mkdtemp(join(tmpdir(), "pi-brave-search-"));
  let child: ChildProcess | undefined;

  try {
    throwIfAborted(signal);
    child = spawn(executable, [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-extensions",
      "--disable-search-engine-choice-screen",
      "--remote-allow-origins=*",
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
    ], {
      stdio: "ignore",
      windowsHide: true,
    });

    await waitForCdp(port, child, signal);
    const browser = await withAbort(
      chromium.connectOverCDP(`http://127.0.0.1:${port}`),
      signal,
    );
    return { browser, child, profileDir, lifetimeTimer: undefined as unknown as NodeJS.Timeout };
  } catch (error) {
    if (child) await killProcessTree(child);
    await rm(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    throw new Error(`Could not start Brave: ${errorText(error)}`);
  }
}

async function closeManagedBrowser(managed: ManagedBrowser): Promise<void> {
  clearTimeout(managed.lifetimeTimer);
  try {
    await managed.browser.close();
  } catch {
    // The browser may already have exited.
  }
  await killProcessTree(managed.child);
  await rm(managed.profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

export class BraveBrowser {
  private managed: ManagedBrowser | undefined;
  private queue: Promise<void> = Promise.resolve();

  async run<T>(signal: AbortSignal | undefined, operation: (page: Page) => Promise<T>): Promise<T> {
    const previous = this.queue;
    const current = previous.then(async () => {
      throwIfAborted(signal);
      if (!this.managed) {
        this.managed = await launchBrave(signal);
        const managed = this.managed;
        managed.lifetimeTimer = setTimeout(() => {
          void this.close();
        }, MAX_BROWSER_LIFETIME_MS);
        managed.lifetimeTimer.unref();
      }
      const contexts = this.managed.browser.contexts();
      const context = contexts[0] ?? await this.managed.browser.newContext();
      const pages = context.pages();
      const page = pages[0] ?? await context.newPage();
      page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
      return operation(page);
    });
    this.queue = current.then(() => undefined, () => undefined);
    return current;
  }

  async state(signal?: AbortSignal): Promise<BrowserState> {
    return this.run(signal, async (page) => ({ page, url: page.url() }));
  }

  async close(): Promise<void> {
    const previous = this.queue;
    const current = previous.then(async () => {
      const managed = this.managed;
      this.managed = undefined;
      if (managed) await closeManagedBrowser(managed);
    });
    this.queue = current.then(() => undefined, () => undefined);
    await current;
  }

  static async navigate(page: Page, url: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await withAbort(page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS }), signal);
    await page.waitForLoadState("load", { timeout: 5_000 }).catch(() => undefined);
    await withAbort(page.waitForTimeout(2_500), signal);
  }

  static async readPage(page: Page, signal?: AbortSignal): Promise<string> {
    return withAbort(page.locator("body").innerText({ timeout: NAVIGATION_TIMEOUT_MS }), signal);
  }
}
