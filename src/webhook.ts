import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import type { CallManager } from "./manager.js";
import { validateTwilioSignature, publicUrlFor } from "./webhook-security.js";
import type { ReplayCache } from "./webhook-security.js";

const WEBHOOK_PATH = "/voice/webhook";

// global-constraints.md: "body size cap 100KB".
const MAX_BODY_BYTES = 100 * 1024;

// Twilio's terminal CallStatus values (everything that isn't one of these,
// or "initiated"/"ringing"/"in-progress", is an in-flight status we don't
// otherwise recognize — e.g. "queued" — and is silently ignored).
const TERMINAL_CALL_STATUSES: ReadonlySet<string> = new Set(["completed", "busy", "no-answer", "failed", "canceled"]);

/**
 * The single public HTTP handler: `POST /voice/webhook?kind=answer|status|amd`.
 * Every other method/path/kind 404s (global-constraints.md: the public
 * listener serves nothing else).
 */
export function createPublicHandler(deps: {
  manager: CallManager;
  authToken: string;
  publicUrl: () => string;
  replay: ReplayCache;
}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { manager, authToken, publicUrl, replay } = deps;

  return async function handlePublicRequest(req, res) {
    try {
      const requestUrl = new URL(req.url ?? "/", "http://internal");
      const kind = requestUrl.searchParams.get("kind");

      if (
        req.method !== "POST" ||
        requestUrl.pathname !== WEBHOOK_PATH ||
        (kind !== "answer" && kind !== "status" && kind !== "amd")
      ) {
        send(res, 404);
        return;
      }

      let rawBody: string;
      try {
        rawBody = await readBodyWithLimit(req, MAX_BODY_BYTES);
      } catch {
        send(res, 413);
        return;
      }

      const params = Object.fromEntries(new URLSearchParams(rawBody));
      const signature = firstHeader(req.headers["x-twilio-signature"]);
      // The exact URL Twilio computed its signature against: the full public
      // URL it POSTed to, including the `?kind=...` query string — the same
      // answer/status/amd URLs server.ts handed Twilio at call-creation time.
      const signedUrl = publicUrlFor(publicUrl(), req.url ?? WEBHOOK_PATH);

      if (!validateTwilioSignature({ authToken, signature, url: signedUrl, params })) {
        // SECURITY ORDERING: reject before any other processing — in
        // particular, before ReplayCache.seen() is ever called. seen()
        // unconditionally inserts its key, so calling it here would let an
        // unauthenticated caller grow/poison the replay cache at request
        // rate. See webhook-security.ts's ReplayCache.seen() doc comment.
        send(res, 403);
        return;
      }

      // Replay dedup guards operations with side effects: kind=status and
      // kind=amd both drive manager.handleProviderEvent, a state mutation.
      // kind=answer is a pure, idempotent TwiML lookup with no side effect
      // to protect — deduping it would risk swallowing a legitimate Twilio
      // retry of the answer webhook into an empty 200 with no TwiML, which
      // would break the call. So it's deliberately excluded here.
      //
      // The key is only PEEKED here (has()) — it's MARKED (below) only once
      // the handler has actually completed successfully. Marking upfront
      // would mean a transient handler failure (e.g. CallStore.save()
      // rejecting) 500s this delivery while the key is already recorded as
      // seen, so Twilio's automatic retry of the byte-identical request
      // gets deduped into a no-op 200 and the transition is lost forever —
      // see ReplayCache.mark()'s doc comment (webhook-security.ts).
      let replayKey: string | undefined;
      if (kind !== "answer") {
        replayKey = `${signature}:${params.CallSid ?? ""}:${params.CallStatus ?? ""}`;
        if (replay.has(replayKey)) {
          send(res, 200);
          return;
        }
      }

      if (kind === "answer") {
        respondAnswer(res, manager, publicUrl, params);
        return;
      }
      if (kind === "status") {
        await handleStatus(manager, params);
      } else {
        await handleAmd(manager, params);
      }
      // Only reached once the handler above resolved without throwing.
      if (replayKey !== undefined) {
        replay.mark(replayKey);
      }
      send(res, 200);
    } catch (err) {
      // Ordinary disk I/O (ENOSPC, EACCES, a corrupt JSON record) can reject
      // anywhere along manager.handleProviderEvent's await chain. Without
      // this, the rejection would escape as an unhandled promise rejection:
      // the response is never written (Twilio hangs until its own timeout,
      // then retries) and Node's default unhandled-rejection policy tears
      // down the process — killing the only public listener mid-call. No
      // error detail is put on the wire.
      console.error("[webhook] handler error:", err);
      if (!res.headersSent) {
        send(res, 500);
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  };
}

function respondAnswer(
  res: ServerResponse,
  manager: CallManager,
  publicUrl: () => string,
  params: Record<string, string>
): void {
  const callSid = params.CallSid;
  // The MVP tracks exactly one active call in memory (CallManager.active,
  // matching maxConcurrentCalls=1) — that's the only lookup CallManager's
  // public API exposes, so "record by CallSid" means "the active record, if
  // its providerCallId matches".
  const active = manager.getActive();
  const rec = active && callSid !== undefined && active.providerCallId === callSid ? active : undefined;

  const inner = rec
    ? `<Connect><Stream url="${wsStreamUrl(publicUrl(), rec.streamToken)}"><Parameter name="token" value="${rec.streamToken}"/></Stream></Connect>`
    : "<Hangup/>";

  res.writeHead(200, { "content-type": "text/xml" }).end(`<?xml version="1.0" encoding="UTF-8"?>\n<Response>${inner}</Response>`);
}

async function handleStatus(manager: CallManager, params: Record<string, string>): Promise<void> {
  const callSid = params.CallSid;
  const callStatus = params.CallStatus;
  if (!callSid || !callStatus) return;

  if (callStatus === "initiated" || callStatus === "ringing") {
    await manager.handleProviderEvent({ type: callStatus, providerCallId: callSid });
    return;
  }
  if (callStatus === "in-progress") {
    await manager.handleProviderEvent({ type: "answered", providerCallId: callSid });
    return;
  }
  if (TERMINAL_CALL_STATUSES.has(callStatus)) {
    await manager.handleProviderEvent({ type: "completed", providerCallId: callSid, providerStatus: callStatus });
  }
  // else: an unrecognized/non-terminal CallStatus (e.g. "queued") — ignored.
}

async function handleAmd(manager: CallManager, params: Record<string, string>): Promise<void> {
  const callSid = params.CallSid;
  const answeredBy = params.AnsweredBy;
  if (!callSid || !answeredBy) return;

  if (answeredBy.startsWith("machine")) {
    await manager.handleProviderEvent({ type: "amd", providerCallId: callSid, result: "machine" });
  } else if (answeredBy === "human") {
    await manager.handleProviderEvent({ type: "amd", providerCallId: callSid, result: "human" });
  }
  // else: e.g. "fax"/"unknown" — ignored.
}

// Twilio connects to <Stream url="..."> exactly as given, including any
// query string, so the token travels as a `?token=` query param here — that
// makes it available synchronously at WS-upgrade time (server.ts validates
// it via manager.getByStreamToken before completing the handshake, so an
// invalid token never gets as far as exchanging a single frame). The
// <Parameter name="token"> element above carries the same value into
// Twilio's `start` frame per Twilio's own custom-parameters convention;
// MediaStreamConnection doesn't read it (only the query-string token is
// actually consulted), but it's kept for wire-format completeness.
function wsStreamUrl(base: string, token: string): string {
  const host = new URL(base).host;
  return `wss://${host}/voice/stream?token=${encodeURIComponent(token)}`;
}

function readBodyWithLimit(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      total += chunk.length;
      if (total > maxBytes) {
        // Reject but do NOT destroy the request: req and res share the same
        // HTTP/1.1 socket, and destroying it here tears the connection down
        // before the 413 response can ever be written, surfacing as a raw
        // socket error on the client instead of a clean 413. Stop buffering
        // (drop what's accumulated so far, ignore further chunks) so an
        // oversized body can't grow memory unbounded, and let the stream
        // drain normally so the socket can still carry the response.
        rejected = true;
        chunks.length = 0;
        reject(new Error("request body exceeds the 100KB limit"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    req.on("error", (err) => {
      if (!rejected) reject(err);
    });
  });
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function send(res: ServerResponse, status: number): void {
  res.writeHead(status).end();
}
