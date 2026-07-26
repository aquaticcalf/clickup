const SAMPLE_RATE = 44_100;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;

export type SoundName =
  | "on"
  | "off"
  | "agentStart"
  | "toolStart"
  | "toolSuccess"
  | "toolError"
  | "turnEnd"
  | "settled";

type Note = {
  frequency: number;
  start: number;
  duration: number;
  volume: number;
};

const EFFECTS: Record<SoundName, Note[]> = {
  on: [
    { frequency: 523.25, start: 0, duration: 0.11, volume: 0.09 },
    { frequency: 659.25, start: 0.07, duration: 0.14, volume: 0.075 },
    { frequency: 783.99, start: 0.14, duration: 0.2, volume: 0.06 },
  ],
  off: [
    { frequency: 659.25, start: 0, duration: 0.12, volume: 0.075 },
    { frequency: 523.25, start: 0.09, duration: 0.18, volume: 0.06 },
  ],
  agentStart: [
    { frequency: 196, start: 0, duration: 0.16, volume: 0.055 },
    { frequency: 293.66, start: 0.04, duration: 0.16, volume: 0.05 },
  ],
  toolStart: [{ frequency: 740, start: 0, duration: 0.035, volume: 0.025 }],
  toolSuccess: [
    { frequency: 987.77, start: 0, duration: 0.07, volume: 0.055 },
    { frequency: 1318.51, start: 0.05, duration: 0.11, volume: 0.045 },
  ],
  toolError: [
    { frequency: 180, start: 0, duration: 0.12, volume: 0.07 },
    { frequency: 140, start: 0.08, duration: 0.14, volume: 0.055 },
  ],
  turnEnd: [
    { frequency: 392, start: 0, duration: 0.11, volume: 0.05 },
    { frequency: 523.25, start: 0.08, duration: 0.16, volume: 0.045 },
  ],
  settled: [
    { frequency: 261.63, start: 0, duration: 0.34, volume: 0.018 },
    { frequency: 329.63, start: 0, duration: 0.34, volume: 0.015 },
    { frequency: 523.25, start: 0, duration: 0.1, volume: 0.045 },
    { frequency: 659.25, start: 0.08, duration: 0.11, volume: 0.045 },
    { frequency: 783.99, start: 0.17, duration: 0.12, volume: 0.05 },
    { frequency: 1046.5, start: 0.27, duration: 0.15, volume: 0.055 },
    { frequency: 1318.51, start: 0.4, duration: 0.18, volume: 0.05 },
    { frequency: 1567.98, start: 0.52, duration: 0.28, volume: 0.045 },
  ],
};

export type SynthesizedSound = {
  pcm: Buffer;
  wav: Buffer;
};

function sampleAt(note: Note, time: number): number {
  const local = time - note.start;
  if (local < 0 || local >= note.duration) return 0;

  const attack = Math.min(0.012, note.duration / 4);
  const release = Math.min(0.045, note.duration / 3);
  const envelope = local < attack
    ? local / attack
    : local > note.duration - release
      ? (note.duration - local) / release
      : 1;
  const fundamental = Math.sin(2 * Math.PI * note.frequency * local);
  const harmonic = 0.18 * Math.sin(4 * Math.PI * note.frequency * local);
  return (fundamental + harmonic) * envelope * note.volume;
}

function makeWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(CHANNELS * BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function synthesize(name: SoundName): SynthesizedSound {
  const notes = EFFECTS[name];
  const duration = Math.max(...notes.map((note) => note.start + note.duration)) + 0.02;
  const pcm = Buffer.alloc(Math.ceil(duration * SAMPLE_RATE) * BYTES_PER_SAMPLE);

  for (let index = 0; index < pcm.length / BYTES_PER_SAMPLE; index += 1) {
    const time = index / SAMPLE_RATE;
    const value = Math.max(-1, Math.min(1, notes.reduce((sum, note) => sum + sampleAt(note, time), 0)));
    pcm.writeInt16LE(Math.round(value * 0x7fff), index * BYTES_PER_SAMPLE);
  }

  return { pcm, wav: makeWav(pcm) };
}
