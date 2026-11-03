import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { LocalMuseProcessRunner } from "../src/modules/execution/muse-code-executor.js";
vi.mock("node:child_process", () => ({ spawn: vi.fn(), execFile: vi.fn() }));

describe("live Muse JSONL capture", () => {
  it("delivers parsed events before process close, in order, and drains persistence before resolving", async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: vi.fn() });
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
    const received: unknown[] = [];
    let releaseWrite: () => void = () => undefined;
    const writeBarrier = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const result = new LocalMuseProcessRunner().run([], {
      cwd: "/tmp",
      timeoutMs: 10000,
      maxOutputBytes: 10000,
      onEvent: async (event) => {
        received.push(event);
        await writeBarrier;
      },
    });
    child.stdout.write('{"payload_type":"tool.execution.');
    child.stdout.write('started"}\n');
    await vi.waitFor(() => expect(received).toHaveLength(1));
    child.stdout.write('{"payload_type":"run.terminal.completed"}');
    child.emit("close", 0);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseWrite();
    await expect(result).resolves.toMatchObject({ exitCode: 0 });
    expect(received).toEqual([
      { payload_type: "tool.execution.started" },
      { payload_type: "run.terminal.completed" },
    ]);
  });
});
