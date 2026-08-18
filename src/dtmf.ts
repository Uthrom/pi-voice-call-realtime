// Adapted from openclaw-voice-call-realtime (MIT) — https://github.com/TristanBrotherton/openclaw-voice-call-realtime

/**
 * DTMF tone synthesis for in-call keypad input (IVR menu navigation).
 *
 * Generates standard dual-tone frequencies as 8kHz mu-law audio that can be
 * injected into the Twilio media stream. Twilio's Calls-API DTMF path
 * (TwiML <Play digits>) cannot be used in conversation mode because updating
 * TwiML replaces the active <Connect><Stream> and drops the call.
 */

const SAMPLE_RATE = 8000;
const DEFAULT_TONE_MS = 120;
const DEFAULT_GAP_MS = 80;

/** Mu-law encoded byte for zero-amplitude PCM (silence). */
export const MULAW_SILENCE = 0xff;

/** ITU-T Q.23 dual-tone frequency pairs [low, high] per key. */
const DTMF_FREQUENCIES: Record<string, [number, number]> = {
  "1": [697, 1209],
  "2": [697, 1336],
  "3": [697, 1477],
  A: [697, 1633],
  "4": [770, 1209],
  "5": [770, 1336],
  "6": [770, 1477],
  B: [770, 1633],
  "7": [852, 1209],
  "8": [852, 1336],
  "9": [852, 1477],
  C: [852, 1633],
  "*": [941, 1209],
  "0": [941, 1336],
  "#": [941, 1477],
  D: [941, 1633],
};

function generateTonePcm(low: number, high: number, durationMs: number): Buffer {
  const samples = Math.round((SAMPLE_RATE * durationMs) / 1000);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / SAMPLE_RATE;
    // -6 dBFS per tone so the dual-tone sum stays well below clipping.
    const value =
      0.35 * Math.sin(2 * Math.PI * low * t) + 0.35 * Math.sin(2 * Math.PI * high * t);
    pcm.writeInt16LE(Math.round(value * 32767), i * 2);
  }
  return pcm;
}

function generateSilencePcm(durationMs: number): Buffer {
  return Buffer.alloc(Math.round((SAMPLE_RATE * durationMs) / 1000) * 2);
}

function linearToMulaw(sample: number): number {
  const BIAS = 132;
  const CLIP = 32635;

  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) {
    sample = -sample;
  }
  if (sample > CLIP) {
    sample = CLIP;
  }

  sample += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--) {
    expMask >>= 1;
  }

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function pcmToMulaw(pcm: Buffer): Buffer {
  const samples = Math.floor(pcm.length / 2);
  const mulaw = Buffer.alloc(samples);

  for (let i = 0; i < samples; i++) {
    const sample = pcm.readInt16LE(i * 2);
    mulaw[i] = linearToMulaw(sample);
  }

  return mulaw;
}

/**
 * Generate a mu-law audio buffer for a DTMF key sequence.
 * Each key is TONE_MS of dual-tone audio followed by GAP_MS of silence.
 */
export function generateDtmfMulaw(
  digits: string,
  opts?: { toneMs?: number; gapMs?: number }
): Buffer {
  const toneMs = opts?.toneMs ?? DEFAULT_TONE_MS;
  const gapMs = opts?.gapMs ?? DEFAULT_GAP_MS;

  const parts: Buffer[] = [];
  for (const raw of digits.toUpperCase()) {
    const freqs = DTMF_FREQUENCIES[raw];
    if (!freqs) {
      throw new Error(`Invalid DTMF key: ${raw}`);
    }
    parts.push(generateTonePcm(freqs[0], freqs[1], toneMs));
    parts.push(generateSilencePcm(gapMs));
  }
  if (parts.length === 0) {
    return Buffer.alloc(0);
  }
  return pcmToMulaw(Buffer.concat(parts));
}
