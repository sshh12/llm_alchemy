// Synthesized sound effects (Web Audio, no downloads). Off by default; the AudioContext is
// only created from the settings toggle (a user gesture) and resumed lazily afterwards.
import { useSettings } from "../state/settings.ts";

export type SoundKind = "pickup" | "merge" | "new" | "first" | "error";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

/** Call from a user gesture (the settings toggle) to unlock audio. */
export function unlockAudio(): void {
  try {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = 0.35;
      master.connect(ctx.destination);
      // Safari: mix with the user's music instead of interrupting it.
      const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
      if (session) session.type = "ambient";
    }
    void ctx.resume();
  } catch {
    ctx = null;
  }
}

function tone(freq: number, start: number, dur: number, type: OscillatorType, gain: number, detune = 0): void {
  if (!ctx || !master) return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  osc.detune.value = detune;
  const t = ctx.currentTime + start;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

function thud(start: number): void {
  if (!ctx || !master) return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  const t = ctx.currentTime + start;
  osc.frequency.setValueAtTime(140, t);
  osc.frequency.exponentialRampToValueAtTime(55, t + 0.25);
  g.gain.setValueAtTime(0.5, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
  osc.connect(g).connect(master);
  osc.start(t);
  osc.stop(t + 0.35);
}

export function playSound(kind: SoundKind): void {
  if (!useSettings.getState().sound || !ctx) return;
  if (ctx.state === "suspended") void ctx.resume();
  switch (kind) {
    case "pickup":
      tone(880, 0, 0.03, "sine", 0.15);
      break;
    case "merge": // two-note pentatonic pluck
      tone(523.25, 0, 0.18, "triangle", 0.3);
      tone(659.25, 0.07, 0.22, "triangle", 0.25);
      break;
    case "new": // rising arpeggio
      [523.25, 659.25, 783.99].forEach((f, i) => tone(f, i * 0.08, 0.28, "triangle", 0.26));
      break;
    case "first": // shimmer chord + seal thud
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
        tone(f, i * 0.05, 0.9, "triangle", 0.12, -6);
        tone(f, i * 0.05, 0.9, "triangle", 0.12, 6);
      });
      thud(0.55);
      break;
    case "error":
      tone(220, 0, 0.16, "sine", 0.22);
      tone(196, 0.12, 0.2, "sine", 0.2);
      break;
  }
}
