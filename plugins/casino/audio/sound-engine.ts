import { AudioOutput } from "./output.ts"
import { synthesize, type SoundName } from "./synth.ts"

const COOLDOWN_MS: Record<SoundName, number> = {
  on: 0,
  off: 0,
  agentStart: 350,
  toolStart: 240,
  toolSuccess: 140,
  toolError: 220,
  turnEnd: 350,
  settled: 600,
}

const MAX_PENDING_SOUNDS = 3

export class SoundEngine {
  private output: AudioOutput | undefined
  private queue: Promise<void> = Promise.resolve()
  private enabled = false
  private pendingSounds = 0
  private readonly lastPlayedAt = new Map<SoundName, number>()

  enable(): void {
    this.enabled = true
    this.output ??= new AudioOutput()
  }

  play(name: SoundName): void {
    if (!this.enabled) return
    const now = Date.now()
    const lastPlayed = this.lastPlayedAt.get(name) ?? 0
    if (now - lastPlayed < COOLDOWN_MS[name]) return
    if (this.pendingSounds >= MAX_PENDING_SOUNDS && name !== "off") return
    this.lastPlayedAt.set(name, now)

    const sound = synthesize(name)
    const output = (this.output ??= new AudioOutput())
    this.pendingSounds += 1
    this.queue = this.queue
      .then(() => output.play(sound))
      .catch(() => undefined)
      .finally(() => {
        this.pendingSounds = Math.max(0, this.pendingSounds - 1)
      })
  }

  async disableAfterQueuedSounds(): Promise<void> {
    this.enabled = false
    await this.queue
    this.output?.close()
    this.output = undefined
  }

  stopImmediately(): void {
    this.enabled = false
    this.output?.close()
    this.output = undefined
  }
}
