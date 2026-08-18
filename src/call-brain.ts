// Adapted from openclaw-voice-call-realtime (MIT) — https://github.com/TristanBrotherton/openclaw-voice-call-realtime

/**
 * Call brain: prompt assembly + in-call tool dispatch for the voice actor.
 *
 * Pure functions only — no I/O, no sockets, no timers. `buildInstructions`
 * is built solely from `CallParams`; it must never see (and therefore can
 * never leak) API keys, tokens, or any other config value beyond the
 * caller-facing fields (callerIdentity, objective, talkingPoints).
 */

import type { CallParams, CallOutcome } from "./types.js";
import type { RealtimeToolDef } from "./realtime.js";

/**
 * Assemble the voice actor's system instructions for one call.
 *
 * Order: role sentence, objective (verbatim), numbered talking points,
 * behavior rules, then a closing section — either the default
 * conversational back-and-forth guidance, or (with `voicemail: true`) a
 * replacement voicemail-specific closing.
 */
export function buildInstructions(params: CallParams, opts?: { voicemail?: boolean }): string {
  const voicemail = opts?.voicemail ?? false;
  const lines: string[] = [];

  lines.push(`You are a voice assistant making a phone call on behalf of ${params.callerIdentity}.`);
  lines.push("");
  lines.push("Objective:");
  lines.push(params.objective);
  lines.push("");
  lines.push("Talking points:");
  params.talkingPoints.forEach((point, i) => {
    lines.push(`${i + 1}. ${point}`);
  });
  lines.push("");
  lines.push("Behavior rules:");
  lines.push("- Speak in concise, natural spoken sentences.");
  lines.push("- Never invent commitments beyond the stated objective.");
  // The next three rules all presuppose a live back-and-forth (being asked
  // a question, the other party losing interest, a conversational moment
  // where the objective resolves) — none of that applies to a one-way
  // voicemail monologue, so they're omitted entirely for that variant
  // rather than left in place to confuse the model. See task-10 review
  // round 1, issue 2.
  if (!voicemail) {
    lines.push("- If asked directly whether you are an AI, disclose that you are an AI assistant.");
    lines.push(
      "- If the person is uninterested or asks you to stop, wrap up politely and call end_call."
    );
    lines.push(
      "- When the objective is resolved, call note_outcome immediately, then say goodbye and call end_call."
    );
  }
  lines.push("");

  if (voicemail) {
    lines.push("Voicemail:");
    // Third-person framing (not "You have reached voicemail" — that reads
    // as the callee's own greeting and risks being spoken verbatim) plus an
    // explicit no-wait instruction, since server-side VAD otherwise leaves
    // the model waiting for a reply that will never come. See task-10
    // review round 1, issue 2.
    lines.push(
      `This call reached voicemail; nobody will respond. Do not pause or wait for a reply. Leave one concise voicemail message covering the objective, give ${params.callerIdentity} as the callback name, then call end_call.`
    );
  } else {
    lines.push("Conversation:");
    lines.push(
      "This is a live phone conversation — engage in natural back-and-forth dialogue with the person you reached, following the rules above."
    );
  }

  return lines.join("\n");
}

/** The three function tools exposed to the realtime model during a call. */
export function inCallTools(): RealtimeToolDef[] {
  return [
    {
      name: "end_call",
      description:
        "End the phone call. Call this immediately after saying goodbye, or right away if the other person asks to stop. `reason` is recorded as the call's endReason (e.g. 'objective-complete', 'caller-declined', 'voicemail-left').",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Short machine-readable reason the call ended."
          }
        },
        required: ["reason"]
      }
    },
    {
      name: "send_dtmf",
      description:
        "Send DTMF (touch-tone) digits into the call, e.g. to navigate an automated phone menu.",
      parameters: {
        type: "object",
        properties: {
          digits: {
            type: "string",
            description: "Digits to send, e.g. '1' or '1234#'.",
            pattern: "^[0-9A-Da-d*#]+$"
          }
        },
        required: ["digits"]
      }
    },
    {
      name: "note_outcome",
      description:
        "Record the result of this call's objective. Call this as soon as the objective is resolved (achieved, declined, or otherwise settled) — before saying goodbye and calling end_call.",
      parameters: {
        type: "object",
        properties: {
          outcome: {
            type: "string",
            description: "Short machine-readable outcome label, e.g. 'confirmed', 'declined', 'rescheduled'."
          },
          details: {
            type: "string",
            description: "Optional free-text detail about the outcome."
          }
        },
        required: ["outcome"]
      }
    }
  ];
}

/** Actions the wiring layer performs in response to a dispatched tool call. */
export interface ToolActions {
  endCall(reason: string): Promise<void>;
  sendDtmf(digits: string): void; // injects synthesized audio into media stream
  noteOutcome(outcome: CallOutcome): void;
}

/**
 * Dispatch one realtime tool-call event to the corresponding action.
 * Never throws — malformed args, an unrecognized tool name, or the
 * dispatched action itself throwing/rejecting (e.g. `sendDtmf`'s
 * `generateDtmfMulaw` throwing on a digit outside its DTMF key table, a
 * provider hangup failing) all produce an error-shaped `output` string
 * instead. This matters because the model is the only consumer of
 * `output` — an uncaught throw here leaves it with no way to recover
 * mid-call.
 */
export async function handleToolCall(
  e: { name: string; callId: string; args: Record<string, unknown> },
  actions: ToolActions
): Promise<{ output: string; respond: boolean }> {
  switch (e.name) {
    case "end_call": {
      const reason = e.args.reason;
      if (typeof reason !== "string") {
        return { output: "error: missing or invalid required field 'reason'", respond: true };
      }
      try {
        await actions.endCall(reason);
      } catch (err) {
        return { output: `error: ${errorMessage(err)}`, respond: true };
      }
      return { output: "call ending", respond: false };
    }

    case "send_dtmf": {
      const digits = e.args.digits;
      if (typeof digits !== "string") {
        return { output: "error: missing or invalid required field 'digits'", respond: true };
      }
      try {
        actions.sendDtmf(digits);
      } catch (err) {
        return { output: `error: ${errorMessage(err)}`, respond: true };
      }
      return { output: "dtmf sent", respond: true };
    }

    case "note_outcome": {
      const outcome = e.args.outcome;
      if (typeof outcome !== "string") {
        return { output: "error: missing or invalid required field 'outcome'", respond: true };
      }
      const details = e.args.details;
      try {
        actions.noteOutcome(typeof details === "string" ? { outcome, details } : { outcome });
      } catch (err) {
        return { output: `error: ${errorMessage(err)}`, respond: true };
      }
      return { output: "noted", respond: true };
    }

    default:
      return { output: `unknown tool: ${e.name}`, respond: true };
  }
}

// Only ever reads an Error's own `message` (or stringifies a non-Error
// throw) — never anything wider — so an action's failure can't smuggle
// anything beyond a plain diagnostic string into a model-facing tool
// output.
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
