import { describe, it, expect } from "vitest";
import { generateDtmfMulaw, MULAW_SILENCE } from "../src/dtmf.js";

const TONE_MS = 120;
const GAP_MS = 80;
const SAMPLES_PER_MS = 8; // 8kHz

describe("generateDtmfMulaw", () => {
  it("returns (toneMs+gapMs)*8 bytes for a single digit at 8kHz mu-law", () => {
    const buf = generateDtmfMulaw("5");
    expect(buf.length).toBe((TONE_MS + GAP_MS) * SAMPLES_PER_MS);
  });

  it("returns twice the length for two digits", () => {
    const buf = generateDtmfMulaw("55");
    expect(buf.length).toBe((TONE_MS + GAP_MS) * SAMPLES_PER_MS * 2);
  });

  it("fills the tone segment with non-silence bytes and the gap segment with silence", () => {
    const buf = generateDtmfMulaw("5");
    const toneBytes = buf.subarray(0, TONE_MS * SAMPLES_PER_MS);
    const gapBytes = buf.subarray(TONE_MS * SAMPLES_PER_MS, (TONE_MS + GAP_MS) * SAMPLES_PER_MS);
    expect(toneBytes.some((b) => b !== MULAW_SILENCE)).toBe(true);
    expect(gapBytes.every((b) => b === MULAW_SILENCE)).toBe(true);
  });

  it("throws on an unknown DTMF character", () => {
    expect(() => generateDtmfMulaw("X")).toThrow();
  });

  it("returns an empty Buffer for an empty digit string", () => {
    const buf = generateDtmfMulaw("");
    expect(buf.length).toBe(0);
  });

  it("respects custom toneMs/gapMs options", () => {
    const buf = generateDtmfMulaw("5", { toneMs: 10, gapMs: 5 });
    expect(buf.length).toBe((10 + 5) * SAMPLES_PER_MS);
  });

  it("exports MULAW_SILENCE as 0xff", () => {
    expect(MULAW_SILENCE).toBe(0xff);
  });
});
