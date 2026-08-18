// Manual smoke-test CLI for the voice-bridge daemon (spec §9 "Live smoke").
// Unlike the pi extension, this script is free to import from `src/` — only
// `extension/*.ts` is required to stay isolated from this repo's own module
// graph (see extension/client.ts's header comment).
//
// `--dry-run` never touches the network: it builds the exact body that would
// be POSTed to `/calls` and prints it, so the request shape can be sanity
// checked with no daemon running and no billable call placed. Without
// `--dry-run` this places a REAL outbound call once the daemon accepts it —
// see README.md's "Smoke test" section for the cost warning.
import { loadConfig } from "../src/config.js";
import { VoiceBridgeClient, type CallParamsInput, type VoiceCallResult } from "../extension/client.js";

const USAGE =
  "Usage: npm run call -- --to <E.164> --objective <text> " +
  "[--talking-point <text> ...] [--identity <text>] [--dry-run]";

const POLL_INTERVAL_MS = 2000;

class UsageError extends Error {}

interface ParsedArgs {
  to?: string;
  objective?: string;
  talkingPoints: string[];
  identity?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { talkingPoints: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--to":
        result.to = requireValue(argv, ++i, "--to");
        break;
      case "--objective":
        result.objective = requireValue(argv, ++i, "--objective");
        break;
      case "--talking-point":
        result.talkingPoints.push(requireValue(argv, ++i, "--talking-point"));
        break;
      case "--identity":
        result.identity = requireValue(argv, ++i, "--identity");
        break;
      case "--dry-run":
        result.dryRun = true;
        break;
      default:
        throw new UsageError(`unrecognized argument: ${arg}`);
    }
  }
  return result;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError(`${flag} requires a value`);
  }
  return value;
}

function buildParams(args: Required<Pick<ParsedArgs, "to" | "objective">> & ParsedArgs): CallParamsInput {
  return {
    to: args.to,
    objective: args.objective,
    talkingPoints: args.talkingPoints,
    ...(args.identity ? { callerIdentity: args.identity } : {})
  };
}

/**
 * Runs the live call and prints status transitions as they happen.
 *
 * `client.initiateAndWait()` only resolves once the call reaches a terminal
 * status (or the client-side timeout fires) and doesn't expose the call id
 * or intermediate statuses itself, so this polls `client.getStatus()`
 * (called with no id — GET /calls/active, "most recent call") on the side
 * for display purposes only. `initiateAndWait`'s own result is always the
 * authority on the outcome; this side loop is purely cosmetic and its
 * errors are swallowed.
 */
async function runLive(client: VoiceBridgeClient, params: CallParamsInput): Promise<number> {
  console.log(`Initiating call to ${params.to}...`);

  let lastStatus: string | undefined;
  let polling = true;
  const pollLoop = (async () => {
    while (polling) {
      try {
        const rec = await client.getStatus();
        if (rec && rec.status !== lastStatus) {
          lastStatus = rec.status;
          console.log(`  status: ${rec.status}`);
        }
      } catch {
        // Transient poll errors are ignored here — initiateAndWait below is
        // the authority on the call's outcome.
      }
      if (!polling) break;
      await sleep(POLL_INTERVAL_MS);
    }
  })();

  let result: VoiceCallResult;
  try {
    result = await client.initiateAndWait(params);
  } catch (err) {
    polling = false;
    await pollLoop;
    // client.ts builds the actionable "daemon not reachable" message itself
    // (VoiceBridgeClient.request()) — just surface it verbatim.
    console.error(errorMessage(err));
    return 1;
  }
  polling = false;
  await pollLoop;

  console.log(JSON.stringify(result, null, 2));
  return result.error ? 1 : 0;
}

async function main(): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(err.message);
    console.error(USAGE);
    return 1;
  }

  if (!args.to || !args.objective) {
    console.error("--to and --objective are required");
    console.error(USAGE);
    return 1;
  }

  const params = buildParams({ ...args, to: args.to, objective: args.objective });

  if (args.dryRun) {
    console.log("Dry run — would POST /calls with body:");
    console.log(JSON.stringify(params, null, 2));
    return 0;
  }

  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(errorMessage(err));
    return 1;
  }

  const client = new VoiceBridgeClient({
    baseUrl: `http://127.0.0.1:${config.serve.controlPort}`,
    token: config.serve.controlToken
  });

  return runLive(client, params);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(errorMessage(err));
    process.exit(1);
  });
