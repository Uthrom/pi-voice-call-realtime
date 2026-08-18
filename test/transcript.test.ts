import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { TranscriptWriter } from "../src/transcript.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-voice-transcript-"));
}

describe("TranscriptWriter", () => {
  it("entries accumulate in order with ISO timestamps", () => {
    const writer = new TranscriptWriter(tempDir(), randomUUID(), {
      to: "+15551234567",
      objective: "confirm appointment"
    });

    writer.add("assistant", "Hi, this is a call about your appointment.");
    writer.add("caller", "Sure, go ahead.");

    expect(writer.entries).toHaveLength(2);
    expect(writer.entries[0]).toMatchObject({
      role: "assistant",
      text: "Hi, this is a call about your appointment."
    });
    expect(writer.entries[1]).toMatchObject({ role: "caller", text: "Sure, go ahead." });
    for (const entry of writer.entries) {
      expect(new Date(entry.at).toISOString()).toBe(entry.at);
    }
  });

  it("add() only buffers — nothing is written to disk until flush() is called", () => {
    const dataDir = tempDir();
    const callId = randomUUID();
    const writer = new TranscriptWriter(dataDir, callId, {
      to: "+15551234567",
      objective: "confirm appointment"
    });

    writer.add("assistant", "Hello?");

    expect(existsSync(join(dataDir, "transcripts", `${callId}.md`))).toBe(false);
  });

  it("flush() writes to <dataDir>/transcripts/<callId>.md and returns that absolute path", async () => {
    const dataDir = tempDir();
    const callId = randomUUID();
    const writer = new TranscriptWriter(dataDir, callId, {
      to: "+15551234567",
      objective: "confirm appointment"
    });
    writer.add("assistant", "Hello?");

    const path = await writer.flush();

    expect(isAbsolute(path)).toBe(true);
    expect(path).toBe(join(dataDir, "transcripts", `${callId}.md`));
    expect(existsSync(path)).toBe(true);
  });

  it("flush() writes a markdown meta header plus **assistant:**/**caller:**/**system:** lines for each entry", async () => {
    const dataDir = tempDir();
    const callId = randomUUID();
    const writer = new TranscriptWriter(dataDir, callId, {
      to: "+15551234567",
      objective: "confirm the Tuesday appointment"
    });
    writer.add("assistant", "Hi, calling to confirm your Tuesday appointment.");
    writer.add("caller", "Yes, that works for me.");
    writer.add("system", "call ended: objective-complete");

    const path = await writer.flush();
    const content = readFileSync(path, "utf-8");

    expect(content).toContain("+15551234567");
    expect(content).toContain("confirm the Tuesday appointment");
    expect(content).toContain(callId);
    expect(content).toContain("**assistant:** Hi, calling to confirm your Tuesday appointment.");
    expect(content).toContain("**caller:** Yes, that works for me.");
    expect(content).toContain("**system:** call ended: objective-complete");
  });

  it("flush() on an empty transcript still writes a file, noting there was no conversation", async () => {
    const dataDir = tempDir();
    const callId = randomUUID();
    const writer = new TranscriptWriter(dataDir, callId, {
      to: "+15551234567",
      objective: "confirm appointment"
    });

    const path = await writer.flush();
    const content = readFileSync(path, "utf-8");

    expect(writer.entries).toHaveLength(0);
    expect(existsSync(path)).toBe(true);
    expect(content.toLowerCase()).toContain("no conversation");
    // the meta header is still written even with zero entries
    expect(content).toContain("+15551234567");
    expect(content).toContain("confirm appointment");
  });
});
