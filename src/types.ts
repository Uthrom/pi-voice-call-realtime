export type CallStatus =
  | "queued"
  | "dialing"
  | "ringing"
  | "answered"
  | "in-progress"
  | "completed"
  | "no-answer"
  | "busy"
  | "failed"
  | "canceled"
  | "interrupted";

export const TERMINAL_STATUSES: ReadonlySet<CallStatus> = new Set([
  "completed",
  "no-answer",
  "busy",
  "failed",
  "canceled",
  "interrupted"
]);

export type AmdPolicy = "leave-message" | "hangup";

export interface CallParams {
  to: string;
  objective: string;
  talkingPoints: string[];
  callerIdentity: string;
  voice?: string;
  maxDurationSec?: number;
  amdPolicy?: AmdPolicy;
}

export interface CallOutcome {
  outcome: string;
  details?: string;
}

export interface CallRecord {
  id: string; // crypto.randomUUID()
  providerCallId?: string; // Twilio CallSid
  params: CallParams;
  status: CallStatus;
  streamToken: string; // crypto.randomBytes(16).toString("base64url")
  createdAt: string; // ISO 8601
  answeredAt?: string;
  endedAt?: string;
  amdResult?: "human" | "machine";
  outcome?: CallOutcome;
  summary?: string;
  transcriptPath?: string;
  error?: string; // genuine failure only (e.g. createCall threw)
  endReason?: string; // why a non-error termination happened (e.g. "duration-cap", "operator")
}
