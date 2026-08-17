import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { CallStore } from "../src/store.js";
import type { CallRecord } from "../src/types.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-voice-store-"));
}

function makeRecord(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    id: randomUUID(),
    providerCallId: "CA123",
    params: {
      to: "+15551234567",
      objective: "confirm appointment",
      talkingPoints: ["confirm time", "ask for address"],
      callerIdentity: "pi",
      voice: "alloy",
      maxDurationSec: 600,
      amdPolicy: "leave-message"
    },
    status: "queued",
    streamToken: randomBytes(16).toString("base64url"),
    createdAt: new Date().toISOString(),
    answeredAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    amdResult: "human",
    outcome: { outcome: "success", details: "confirmed" },
    summary: "Call went well",
    transcriptPath: "/tmp/transcript.json",
    error: "none",
    ...overrides
  };
}

describe("CallStore", () => {
  it("save then get round-trips all fields", async () => {
    const store = new CallStore(tempDir());
    const rec = makeRecord();

    await store.save(rec);
    const got = await store.get(rec.id);

    expect(got).toEqual(rec);
  });

  it("get returns undefined for an unknown id", async () => {
    const store = new CallStore(tempDir());

    const got = await store.get("does-not-exist");

    expect(got).toBeUndefined();
  });

  it("findByProviderCallId finds a record after providerCallId is set and re-saved", async () => {
    const store = new CallStore(tempDir());
    const rec = makeRecord({ providerCallId: undefined });
    await store.save(rec);

    expect(await store.findByProviderCallId("CA999")).toBeUndefined();

    const updated = { ...rec, providerCallId: "CA999" };
    await store.save(updated);

    expect(await store.findByProviderCallId("CA999")).toEqual(updated);
  });

  it("list returns records newest first by createdAt", async () => {
    const store = new CallStore(tempDir());
    const older = makeRecord({ createdAt: new Date(Date.now() - 60_000).toISOString() });
    const newer = makeRecord({ createdAt: new Date().toISOString() });
    await store.save(older);
    await store.save(newer);

    const list = await store.list();

    expect(list.map((r) => r.id)).toEqual([newer.id, older.id]);
  });

  it("countCreatedToday counts a just-created record as 1", async () => {
    const store = new CallStore(tempDir());
    await store.save(makeRecord({ createdAt: new Date().toISOString() }));

    expect(await store.countCreatedToday()).toBe(1);
  });

  it("countCreatedToday does not count a record created yesterday", async () => {
    const store = new CallStore(tempDir());
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    await store.save(makeRecord({ createdAt: yesterday.toISOString() }));

    expect(await store.countCreatedToday()).toBe(0);
  });
});
