import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type TranscriptRole = "assistant" | "caller" | "system";

export interface TranscriptEntry {
  role: string;
  text: string;
  at: string;
}

/**
 * Buffers a call's turn-by-turn transcript in memory and writes it to a
 * single markdown file per call at `<dataDir>/transcripts/<callId>.md` when
 * `flush()` is called. Nothing touches disk before `flush()`.
 */
export class TranscriptWriter {
  private readonly filePath: string;
  private readonly callId: string;
  private readonly meta: { to: string; objective: string };
  private readonly buffer: TranscriptEntry[] = [];

  constructor(dataDir: string, callId: string, meta: { to: string; objective: string }) {
    this.callId = callId;
    this.meta = meta;
    this.filePath = resolve(join(dataDir, "transcripts", `${callId}.md`));
  }

  add(role: TranscriptRole, text: string): void {
    this.buffer.push({ role, text, at: new Date().toISOString() });
  }

  async flush(): Promise<string> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, this.render(), "utf-8");
    return this.filePath;
  }

  get entries(): ReadonlyArray<TranscriptEntry> {
    return this.buffer.slice();
  }

  private render(): string {
    const lines: string[] = [
      "# Call transcript",
      "",
      `- **Call ID:** ${this.callId}`,
      `- **To:** ${this.meta.to}`,
      `- **Objective:** ${this.meta.objective}`,
      "",
      "## Conversation",
      ""
    ];

    if (this.buffer.length === 0) {
      lines.push("_No conversation was recorded for this call._");
    } else {
      for (const entry of this.buffer) {
        lines.push(`**${entry.role}:** ${entry.text}`);
        lines.push("");
      }
    }

    return lines.join("\n");
  }
}
