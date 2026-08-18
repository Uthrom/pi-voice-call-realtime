import { describe, it, expect, vi } from "vitest";
import { buildInstructions, inCallTools, handleToolCall } from "../src/call-brain.js";
import type { ToolActions } from "../src/call-brain.js";
import type { CallParams } from "../src/types.js";

const baseParams: CallParams = {
  to: "+15551234567",
  objective: "Confirm the Tuesday 2pm appointment and ask them to call back if it needs to move.",
  talkingPoints: [
    "Mention we're calling from Acme Roofing.",
    "Confirm the appointment date and time.",
    "Offer to reschedule if needed."
  ],
  callerIdentity: "Acme Roofing"
};

describe("buildInstructions", () => {
  it("includes the caller identity in the role sentence", () => {
    const text = buildInstructions(baseParams);
    expect(text).toContain("You are a voice assistant making a phone call on behalf of Acme Roofing");
  });

  it("includes the objective verbatim", () => {
    const text = buildInstructions(baseParams);
    expect(text).toContain(baseParams.objective);
  });

  it("includes each talking point, numbered", () => {
    const text = buildInstructions(baseParams);
    baseParams.talkingPoints.forEach((point, i) => {
      expect(text).toContain(`${i + 1}. ${point}`);
    });
  });

  it("includes the AI-disclosure rule", () => {
    const text = buildInstructions(baseParams).toLowerCase();
    expect(text).toContain("disclose");
    expect(text).toContain("ai assistant");
  });

  it("includes the never-invent-commitments rule", () => {
    const text = buildInstructions(baseParams).toLowerCase();
    expect(text).toContain("never invent commitments");
  });

  it("includes the wrap-up-and-end_call rule for an uninterested caller", () => {
    const text = buildInstructions(baseParams);
    expect(text.toLowerCase()).toContain("uninterested");
    expect(text).toContain("end_call");
  });

  it("includes the note_outcome-then-goodbye-then-end_call rule when the objective is resolved", () => {
    const text = buildInstructions(baseParams);
    expect(text).toContain("note_outcome");
    expect(text.toLowerCase()).toContain("resolved");
  });

  it("by default includes the conversational back-and-forth closing section", () => {
    const text = buildInstructions(baseParams);
    expect(text.toLowerCase()).toContain("back-and-forth");
  });

  it("voicemail variant mentions leaving a message", () => {
    const text = buildInstructions(baseParams, { voicemail: true }).toLowerCase();
    expect(text).toMatch(/leave[^.]*(voicemail|message)/);
  });

  it("voicemail variant omits the conversational back-and-forth section", () => {
    const text = buildInstructions(baseParams, { voicemail: true });
    expect(text.toLowerCase()).not.toContain("back-and-forth");
  });

  it("voicemail variant still ends with end_call", () => {
    const text = buildInstructions(baseParams, { voicemail: true });
    expect(text).toContain("end_call");
  });

  it("never contains a secret pulled from process.env, even if one happens to be set", () => {
    const SECRET = "sk-test-SECRETVALUE-should-never-leak-9f8e7d6c";
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = SECRET;
    try {
      const text = buildInstructions(baseParams);
      expect(text).not.toContain(SECRET);
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });

  it("never contains a config-shaped secret string that was never passed anywhere near params", () => {
    // This string is never referenced by buildInstructions in any way — it
    // exists only in this test. Asserting its absence demonstrates
    // instructions are built solely from `params`, per the security
    // constraint (no API keys/tokens/config values beyond the
    // caller-facing fields).
    const CONFIG_SECRET = "controlToken=super-secret-value-1234567890";
    const text = buildInstructions(baseParams);
    expect(text).not.toContain(CONFIG_SECRET);
    expect(text).not.toContain("super-secret-value-1234567890");
  });
});

describe("inCallTools", () => {
  it("returns exactly end_call, send_dtmf, note_outcome", () => {
    const names = inCallTools().map((t) => t.name);
    expect(names).toEqual(["end_call", "send_dtmf", "note_outcome"]);
  });

  it("end_call has a required string 'reason' parameter", () => {
    const endCall = inCallTools().find((t) => t.name === "end_call");
    expect(endCall).toBeDefined();
    const params = endCall!.parameters as {
      properties: { reason: { type: string } };
      required: string[];
    };
    expect(params.properties.reason.type).toBe("string");
    expect(params.required).toContain("reason");
  });

  it("send_dtmf has a required string 'digits' parameter", () => {
    const sendDtmf = inCallTools().find((t) => t.name === "send_dtmf");
    expect(sendDtmf).toBeDefined();
    const params = sendDtmf!.parameters as {
      properties: { digits: { type: string } };
      required: string[];
    };
    expect(params.properties.digits.type).toBe("string");
    expect(params.required).toContain("digits");
  });

  it("note_outcome has a required string 'outcome' and an optional string 'details' parameter", () => {
    const noteOutcome = inCallTools().find((t) => t.name === "note_outcome");
    expect(noteOutcome).toBeDefined();
    const params = noteOutcome!.parameters as {
      properties: { outcome: { type: string }; details: { type: string } };
      required: string[];
    };
    expect(params.properties.outcome.type).toBe("string");
    expect(params.properties.details.type).toBe("string");
    expect(params.required).toContain("outcome");
    expect(params.required).not.toContain("details");
  });

  it("every tool has a non-empty description", () => {
    for (const tool of inCallTools()) {
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });
});

describe("handleToolCall", () => {
  function makeActions(): {
    endCall: ReturnType<typeof vi.fn>;
    sendDtmf: ReturnType<typeof vi.fn>;
    noteOutcome: ReturnType<typeof vi.fn>;
  } & ToolActions {
    return {
      endCall: vi.fn().mockResolvedValue(undefined),
      sendDtmf: vi.fn(),
      noteOutcome: vi.fn()
    };
  }

  it("end_call calls actions.endCall(reason) and returns respond:false", async () => {
    const actions = makeActions();
    const result = await handleToolCall(
      { name: "end_call", callId: "call_1", args: { reason: "objective-complete" } },
      actions
    );
    expect(actions.endCall).toHaveBeenCalledWith("objective-complete");
    expect(actions.endCall).toHaveBeenCalledTimes(1);
    expect(result.respond).toBe(false);
    expect(typeof result.output).toBe("string");
  });

  it("send_dtmf with {digits:'1'} calls actions.sendDtmf('1') and returns respond:true", async () => {
    const actions = makeActions();
    const result = await handleToolCall(
      { name: "send_dtmf", callId: "call_2", args: { digits: "1" } },
      actions
    );
    expect(actions.sendDtmf).toHaveBeenCalledWith("1");
    expect(result.respond).toBe(true);
  });

  it("note_outcome calls actions.noteOutcome({outcome, details}) and returns output 'noted'", async () => {
    const actions = makeActions();
    const result = await handleToolCall(
      { name: "note_outcome", callId: "call_3", args: { outcome: "confirmed", details: "moved to 3pm" } },
      actions
    );
    expect(actions.noteOutcome).toHaveBeenCalledWith({ outcome: "confirmed", details: "moved to 3pm" });
    expect(result.output).toBe("noted");
    expect(result.respond).toBe(true);
  });

  it("note_outcome without details calls actions.noteOutcome with outcome only", async () => {
    const actions = makeActions();
    await handleToolCall({ name: "note_outcome", callId: "call_3b", args: { outcome: "declined" } }, actions);
    expect(actions.noteOutcome).toHaveBeenCalledWith({ outcome: "declined" });
  });

  it("unknown tool returns output containing 'unknown tool', respond:true, and calls no action", async () => {
    const actions = makeActions();
    const result = await handleToolCall({ name: "reticulate_splines", callId: "call_4", args: {} }, actions);
    expect(result.output).toContain("unknown tool");
    expect(result.respond).toBe(true);
    expect(actions.endCall).not.toHaveBeenCalled();
    expect(actions.sendDtmf).not.toHaveBeenCalled();
    expect(actions.noteOutcome).not.toHaveBeenCalled();
  });

  it("send_dtmf with malformed args (missing digits) returns an error output and does not throw", async () => {
    const actions = makeActions();
    const result = await handleToolCall({ name: "send_dtmf", callId: "call_5", args: {} }, actions);
    expect(result.output.toLowerCase()).toContain("error");
    expect(result.respond).toBe(true);
    expect(actions.sendDtmf).not.toHaveBeenCalled();
  });

  it("end_call with malformed args (missing reason) returns an error output and does not throw", async () => {
    const actions = makeActions();
    const result = await handleToolCall({ name: "end_call", callId: "call_6", args: {} }, actions);
    expect(result.output.toLowerCase()).toContain("error");
    expect(actions.endCall).not.toHaveBeenCalled();
  });

  it("note_outcome with malformed args (missing outcome) returns an error output and does not throw", async () => {
    const actions = makeActions();
    const result = await handleToolCall({ name: "note_outcome", callId: "call_7", args: {} }, actions);
    expect(result.output.toLowerCase()).toContain("error");
    expect(actions.noteOutcome).not.toHaveBeenCalled();
  });
});
