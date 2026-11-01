import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface DocumentStorage {
  put(contents: Buffer): Promise<string>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

/** Private local development storage. Not a production/shared-instance backend. */
export class LocalDocumentStorage implements DocumentStorage {
  private readonly root: string;
  constructor(directory: string) {
    if (!directory.trim()) throw new Error("A private document storage directory is required.");
    this.root = resolve(directory);
  }
  private location(key: string): string {
    if (!/^[0-9a-f-]{36}$/.test(key)) throw new Error("Invalid document storage key.");
    return join(this.root, key);
  }
  async put(contents: Buffer): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const key = randomUUID();
    await writeFile(this.location(key), contents, { flag: "wx", mode: 0o600 });
    return key;
  }
  get(key: string): Promise<Buffer> {
    return readFile(this.location(key));
  }
  async remove(key: string): Promise<void> {
    await unlink(this.location(key));
  }
}
