import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { CapacityError, DailyCapError } from "./manager.js";
import type { CallManager } from "./manager.js";
import type { CallStore } from "./store.js";
import type { Config } from "./config.js";
import type { CallParams } from "./types.js";

const E164 = /^\+[1-9]\d{6,14}$/;

// Defensive cap on the POST /calls body. This API is loopback + bearer-authed
// (not the plan-mandated 100KB public-listener cap in webhook.ts, which
// guards an unauthenticated internet-facing endpoint), but an unbounded read
// is still one misbehaving client away from unbounded memory growth.
const MAX_BODY_BYTES = 64 * 1024;

export interface ControlApiDeps {
  manager: CallManager;
  store: CallStore;
  config: Config;
  publicUrl: () => string;
}

/**
 * The full localhost control API: `POST /calls`, `GET /calls/active`,
 * `GET /calls/:id`, `GET /calls/:id/transcript`, `POST /calls/:id/end`, and
 * the one unauthenticated route, `GET /health`. Every other method/path
 * 404s. Bearer auth (constant-time compare) gates everything except
 * `GET /health`.
 */
export function createControlHandler(
  deps: ControlApiDeps
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { manager, store, config, publicUrl } = deps;
  const callParamsSchema = buildCallParamsSchema(config);

  return async function handleControlRequest(req, res) {
    try {
      const requestUrl = new URL(req.url ?? "/", "http://internal");
      const pathname = requestUrl.pathname;

      if (req.method === "GET" && pathname === "/health") {
        sendJson(res, 200, {
          ok: true,
          activeCall: manager.getActive()?.id ?? null,
          publicUrl: publicUrl() ?? null
        });
        return;
      }

      if (!isAuthorized(req, config.serve.controlToken)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      const segments = pathname.split("/").filter(Boolean);

      if (req.method === "POST" && segments.length === 1 && segments[0] === "calls") {
        await handleInitiate(req, res, manager, callParamsSchema);
        return;
      }

      if (req.method === "GET" && segments.length === 2 && segments[0] === "calls" && segments[1] === "active") {
        await handleActive(res, manager, store);
        return;
      }

      if (req.method === "GET" && segments.length === 2 && segments[0] === "calls") {
        await handleGetById(segments[1]!, res, store);
        return;
      }

      if (
        req.method === "GET" &&
        segments.length === 3 &&
        segments[0] === "calls" &&
        segments[2] === "transcript"
      ) {
        await handleGetTranscript(segments[1]!, res, store);
        return;
      }

      if (req.method === "POST" && segments.length === 3 && segments[0] === "calls" && segments[2] === "end") {
        await manager.endCall(segments[1]!, "operator");
        sendJson(res, 200, { ok: true });
        return;
      }

      send(res, 404);
    } catch (err) {
      // Ordinary disk I/O (e.g. CallStore.get() throws on a corrupt record
      // file — unlike list(), which skips bad files) or any other rejection
      // anywhere along a route's await chain lands here. Without this
      // boundary it would escape as an unhandled rejection instead of a
      // clean 500. No error detail is put on the wire.
      console.error("[control-api] handler error:", err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal error" });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  };
}

function buildCallParamsSchema(config: Config) {
  return z.object({
    to: z.string({ required_error: "to is required" }).regex(E164, "to must be in E.164 format (e.g. +15550001111)"),
    objective: z.string({ required_error: "objective is required" }).min(1, "objective is required"),
    talkingPoints: z.array(z.string()).default([]),
    callerIdentity: z.string().min(1, "callerIdentity must not be empty").default(config.defaults.callerIdentity),
    voice: z.string().optional(),
    maxDurationSec: z.number().optional(),
    amdPolicy: z.enum(["leave-message", "hangup"]).optional()
  });
}

async function handleInitiate(
  req: IncomingMessage,
  res: ServerResponse,
  manager: CallManager,
  schema: ReturnType<typeof buildCallParamsSchema>
): Promise<void> {
  let rawBody: string;
  try {
    rawBody = await readBodyWithLimit(req, MAX_BODY_BYTES);
  } catch {
    send(res, 413);
    return;
  }

  let parsed: unknown;
  try {
    parsed = rawBody.length > 0 ? JSON.parse(rawBody) : {};
  } catch {
    sendJson(res, 400, { error: "invalid JSON body" });
    return;
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const message = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    sendJson(res, 400, { error: message });
    return;
  }

  try {
    const rec = await manager.initiateCall(result.data as CallParams);
    sendJson(res, 201, rec);
  } catch (err) {
    if (err instanceof CapacityError) {
      sendJson(res, 409, { error: "call-in-progress" });
      return;
    }
    if (err instanceof DailyCapError) {
      sendJson(res, 429, { error: "daily-cap-reached" });
      return;
    }
    throw err;
  }
}

// Finding 3 (spec §2.2: "Current state of active/most recent call."): when
// nothing is active in this process, fall back to the most recent record on
// disk — the manager's in-memory `active` slot is empty between calls
// (and, notably, after every restart) even though the daemon has plainly
// handled a call before. Only a genuinely empty store still 204s.
async function handleActive(res: ServerResponse, manager: CallManager, store: CallStore): Promise<void> {
  const active = manager.getActive();
  if (active) {
    sendJson(res, 200, active);
    return;
  }

  const list = await store.list(); // already newest-first (CallStore.list's own sort)
  const mostRecent = list[0];
  if (!mostRecent) {
    send(res, 204);
    return;
  }
  sendJson(res, 200, mostRecent);
}

async function handleGetById(id: string, res: ServerResponse, store: CallStore): Promise<void> {
  const rec = await store.get(id);
  if (!rec) {
    send(res, 404);
    return;
  }
  sendJson(res, 200, rec);
}

async function handleGetTranscript(id: string, res: ServerResponse, store: CallStore): Promise<void> {
  const rec = await store.get(id);
  if (!rec || !rec.transcriptPath) {
    send(res, 404);
    return;
  }

  let contents: string;
  try {
    contents = await readFile(rec.transcriptPath, "utf-8");
  } catch (err) {
    if (isNotFound(err)) {
      send(res, 404);
      return;
    }
    throw err;
  }

  res.writeHead(200, { "content-type": "text/markdown" }).end(contents);
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  return timingSafeEqualStrings(header.slice("Bearer ".length), token);
}

// Same constant-time-comparison pattern as webhook-security.ts's
// timingSafeEqualStrings: the bearer token is the only gate on this API, so
// a naive `===` (which short-circuits at the first mismatched byte) would
// leak timing information an attacker could use to guess it byte-by-byte.
// Falls back to a dummy constant-time comparison on length mismatch so the
// branch taken doesn't leak how close a forged token was.
function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
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
        // HTTP/1.1 socket, and destroying it here would tear the connection
        // down before the 413 response could ever be written. Stop
        // buffering (drop what's accumulated) so an oversized body can't
        // grow memory unbounded, and let the stream drain normally so the
        // socket can still carry the response.
        rejected = true;
        chunks.length = 0;
        reject(new Error("request body exceeds the control API's body limit"));
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

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "ENOENT";
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function send(res: ServerResponse, status: number): void {
  res.writeHead(status).end();
}
