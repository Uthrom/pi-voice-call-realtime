import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CallRecord } from "./types.js";

export class CallStore {
  private readonly callsDir: string;

  constructor(dataDir: string) {
    this.callsDir = join(dataDir, "calls");
  }

  async save(rec: CallRecord): Promise<void> {
    await mkdir(this.callsDir, { recursive: true });
    const filePath = this.pathFor(rec.id);
    const tmpPath = `${filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(rec, null, 2), "utf-8");
    await rename(tmpPath, filePath);
  }

  async get(id: string): Promise<CallRecord | undefined> {
    try {
      const raw = await readFile(this.pathFor(id), "utf-8");
      return JSON.parse(raw) as CallRecord;
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  async findByProviderCallId(sid: string): Promise<CallRecord | undefined> {
    const records = await this.list();
    return records.find((rec) => rec.providerCallId === sid);
  }

  async list(): Promise<CallRecord[]> {
    let files: string[];
    try {
      files = await readdir(this.callsDir);
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }

    const records = await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map(async (file) => {
          const raw = await readFile(join(this.callsDir, file), "utf-8");
          return JSON.parse(raw) as CallRecord;
        })
    );

    return records.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }

  async countCreatedToday(now: Date = new Date()): Promise<number> {
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

    const records = await this.list();
    return records.filter((rec) => {
      const createdAt = new Date(rec.createdAt);
      return createdAt >= dayStart && createdAt < dayEnd;
    }).length;
  }

  private pathFor(id: string): string {
    return join(this.callsDir, `${id}.json`);
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "ENOENT";
}
