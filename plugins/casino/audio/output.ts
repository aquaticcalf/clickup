import { spawn } from "node:child_process";
import { once } from "node:events";
import type { SynthesizedSound } from "./synth.ts";

const SPEAKER_OPTIONS = {
  channels: 1,
  bitDepth: 16,
  sampleRate: 44_100,
};

type SpeakerStream = {
  write(chunk: Buffer): boolean;
  end(): void;
  once(event: string, listener: (...args: unknown[]) => void): void;
};

type SpeakerConstructor = new (options: typeof SPEAKER_OPTIONS) => SpeakerStream;

async function loadSpeaker(): Promise<SpeakerStream | undefined> {
  try {
    const imported = await import("speaker");
    const Speaker = (imported.default ?? imported) as unknown as SpeakerConstructor;
    return new Speaker(SPEAKER_OPTIONS);
  } catch {
    return undefined;
  }
}

async function writeToSpeaker(speaker: SpeakerStream, pcm: Buffer): Promise<void> {
  if (speaker.write(pcm)) return;
  await once(speaker as unknown as NodeJS.EventEmitter, "drain");
}

function runProcess(command: string, args: string[], input: Buffer): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    let settled = false;
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      resolve(success);
    };
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
    child.stdin?.end(input);
  });
}

async function playFallback(wav: Buffer): Promise<void> {
  if (process.platform === "win32") {
    const encoded = wav.toString("base64");
    const script = "$b=[Convert]::FromBase64String('" + encoded + "');$m=[IO.MemoryStream]::new($b);$p=[System.Media.SoundPlayer]::new($m);$p.PlaySync();$p.Dispose();$m.Dispose()";
    if (await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], Buffer.alloc(0))) return;
  } else if (process.platform === "darwin") {
    if (await runProcess("afplay", ["-"], wav)) return;
  } else {
    if (await runProcess("aplay", ["-q", "-"], wav)) return;
    if (await runProcess("paplay", ["--file-format=wav"], wav)) return;
  }

  // Terminal bell is the final no-dependency fallback. It emits no visible text.
  process.stdout.write("\x07");
}

export class AudioOutput {
  private speaker: SpeakerStream | undefined;
  private speakerAttempted = false;

  async play(sound: SynthesizedSound): Promise<void> {
    if (!this.speakerAttempted) {
      this.speakerAttempted = true;
      this.speaker = await loadSpeaker();
    }

    if (this.speaker) {
      try {
        await writeToSpeaker(this.speaker, sound.pcm);
        return;
      } catch {
        this.speaker = undefined;
      }
    }

    await playFallback(sound.wav);
  }

  close(): void {
    this.speaker?.end();
    this.speaker = undefined;
  }
}
