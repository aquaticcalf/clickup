import { AudioOutput } from "./output.ts";
import { synthesize, type SoundName } from "./synth.ts";

export class SoundEngine {
  private output: AudioOutput | undefined;
  private queue: Promise<void> = Promise.resolve();
  private enabled = false;

  enable(): void {
    this.enabled = true;
    this.output ??= new AudioOutput();
  }

  play(name: SoundName): void {
    if (!this.enabled) return;
    const sound = synthesize(name);
    const output = (this.output ??= new AudioOutput());
    this.queue = this.queue
      .then(() => output.play(sound))
      .catch(() => undefined);
  }

  async disableAfterQueuedSounds(): Promise<void> {
    this.enabled = false;
    await this.queue;
    this.output?.close();
    this.output = undefined;
  }

  stopImmediately(): void {
    this.enabled = false;
    this.output?.close();
    this.output = undefined;
  }
}
