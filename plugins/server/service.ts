import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const SERVICE_LABEL = "lol.calf.pi";
const WINDOWS_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const LINUX_UNIT = "lol.calf.pi.service";
const DAEMON_ENTRYPOINT = fileURLToPath(new URL("./daemon.ts", import.meta.url));

export type ServicePlatform = "windows" | "macos" | "linux" | "unsupported";

function platform(): ServicePlatform {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") return "linux";
  return "unsupported";
}

function nodeCommand(host: string, port: number): string[] {
  return [
    process.execPath,
    "--experimental-strip-types",
    DAEMON_ENTRYPOINT,
    "--host",
    host,
    "--port",
    String(port),
  ];
}

function quoteWindows(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function quoteSystemd(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function uid(): number {
  if (!process.getuid) throw new Error("the current platform does not expose a user id");
  return process.getuid();
}

function launchAgentPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}

function linuxUnitPath(unit = LINUX_UNIT): string {
  return join(homedir(), ".config", "systemd", "user", unit);
}

function launchAgentXml(host: string, port: number): string {
  const argumentsXml = nodeCommand(host, port)
    .map((argument) => `<string>${argument.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</string>`)
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key><array>${argumentsXml}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(homedir(), ".pi", "agent", "pi-host.log")}</string>
  <key>StandardErrorPath</key><string>${join(homedir(), ".pi", "agent", "pi-host.error.log")}</string>
</dict>
</plist>
`;
}

function linuxUnit(host: string, port: number): string {
  const command = nodeCommand(host, port).map(quoteSystemd).join(" ");
  return `[Unit]
Description=pi host server

[Service]
ExecStart=${command}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
}

async function command(command: string, args: string[]): Promise<void> {
  await execFileAsync(command, args, { windowsHide: true });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export class DaemonService {
  readonly platform = platform();

  constructor(
    private readonly host = process.env.PI_SERVER_HOST || "127.0.0.1",
    private readonly port = Number(process.env.PI_SERVER_PORT) > 0 ? Number(process.env.PI_SERVER_PORT) : 3333,
  ) {}

  async isInstalled(): Promise<boolean> {
    if (this.platform === "windows") {
      try {
        await command("reg.exe", ["QUERY", WINDOWS_RUN_KEY, "/V", SERVICE_LABEL]);
        return true;
      } catch {
        return false;
      }
    }

    if (this.platform === "macos") return exists(launchAgentPath());
    if (this.platform === "linux") {
      try {
        await command("systemctl", ["--user", "is-enabled", LINUX_UNIT]);
        return true;
      } catch {
        return false;
      }
    }

    return false;
  }

  async install(): Promise<void> {
    if (this.platform === "windows") {
      const startupCommand = nodeCommand(this.host, this.port).map(quoteWindows).join(" ");
      await command("reg.exe", [
        "ADD",
        WINDOWS_RUN_KEY,
        "/V",
        SERVICE_LABEL,
        "/T",
        "REG_SZ",
        "/D",
        startupCommand,
        "/F",
      ]);
      return;
    }

    if (this.platform === "macos") {
      const path = launchAgentPath();
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, launchAgentXml(this.host, this.port), { encoding: "utf8", mode: 0o600 });
      return;
    }

    if (this.platform === "linux") {
      const path = linuxUnitPath();
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, linuxUnit(this.host, this.port), { encoding: "utf8", mode: 0o600 });
      await command("systemctl", ["--user", "daemon-reload"]);
      await command("systemctl", ["--user", "enable", LINUX_UNIT]);
      return;
    }

    throw new Error(`automatic startup is not supported on ${process.platform}`);
  }

  async start(): Promise<void> {
    if (this.platform === "windows") {
      const child = spawn(process.execPath, ["--experimental-strip-types", DAEMON_ENTRYPOINT, "--host", this.host, "--port", String(this.port)], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, PI_SERVER_HOST: this.host, PI_SERVER_PORT: String(this.port) },
      });
      child.unref();
      return;
    }

    if (this.platform === "macos") {
      const target = `gui/${uid()}`;
      try {
        await command("launchctl", ["bootstrap", target, launchAgentPath()]);
      } catch {
        // the agent may already be loaded
      }
      await command("launchctl", ["kickstart", "-k", `${target}/${SERVICE_LABEL}`]);
      return;
    }

    if (this.platform === "linux") {
      await command("systemctl", ["--user", "start", LINUX_UNIT]);
      return;
    }

    throw new Error(`automatic startup is not supported on ${process.platform}`);
  }

  async uninstall(): Promise<void> {
    if (this.platform === "windows") {
      try {
        await command("reg.exe", ["DELETE", WINDOWS_RUN_KEY, "/V", SERVICE_LABEL, "/F"]);
      } catch {
        // the startup entry may already be absent
      }
      return;
    }

    if (this.platform === "macos") {
      try {
        await command("launchctl", ["bootout", `gui/${uid()}/${SERVICE_LABEL}`]);
      } catch {
        // the agent may not currently be loaded
      }
      await rm(launchAgentPath(), { force: true });
      return;
    }

    if (this.platform === "linux") {
      try {
        await command("systemctl", ["--user", "disable", "--now", LINUX_UNIT]);
      } catch {
        // the unit may not currently be enabled or running
      }
      await rm(linuxUnitPath(), { force: true });
      await command("systemctl", ["--user", "daemon-reload"]);
      return;
    }
  }
}
