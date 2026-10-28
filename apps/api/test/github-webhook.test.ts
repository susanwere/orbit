import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type {
  WebhookInboxEntry,
  WebhookInboxStore,
  WebhookPersistResult,
} from "../src/modules/integrations/github/webhook-inbox.js";
import { verifyGitHubWebhookSignature } from "../src/modules/integrations/github/webhook-signature.js";

const secret = "test-secret";

function signature(body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

class MemoryWebhookInbox implements WebhookInboxStore {
  readonly entries = new Map<string, WebhookInboxEntry>();

  async persist(entry: WebhookInboxEntry): Promise<WebhookPersistResult> {
    const key = `${entry.provider}:${entry.deliveryId}`;
    if (this.entries.has(key)) return { inserted: false };

    this.entries.set(key, entry);
    return { inserted: true, id: `inbox_${this.entries.size}` };
  }
}

describe("GitHub webhook signature verification", () => {
  it("accepts a valid SHA-256 signature", () => {
    const body = Buffer.from('{"action":"opened"}');
    expect(
      verifyGitHubWebhookSignature(body, signature(body.toString("utf8")), secret),
    ).toBe(true);
  });

  it("rejects forged and malformed signatures", () => {
    const body = Buffer.from('{"action":"opened"}');
    expect(
      verifyGitHubWebhookSignature(body, `sha256=${"0".repeat(64)}`, secret),
    ).toBe(false);
    expect(verifyGitHubWebhookSignature(body, "sha256=nope", secret)).toBe(false);
    expect(verifyGitHubWebhookSignature(body, undefined, secret)).toBe(false);
  });
});

describe("GitHub webhook ingress", () => {
  it("rejects forged signatures before persistence", async () => {
    const inbox = new MemoryWebhookInbox();
    const app = await buildApp({
      githubWebhook: {
        secret,
        organizationId: "org_1",
        projectId: "project_1",
        inbox,
      },
    });

    const body = JSON.stringify({ action: "opened" });
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-1",
        "x-github-event": "pull_request",
        "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
      },
      payload: body,
    });

    expect(response.statusCode).toBe(401);
    expect(inbox.entries.size).toBe(0);
    await app.close();
  });

  it("persists a valid delivery exactly once and acknowledges duplicates", async () => {
    const inbox = new MemoryWebhookInbox();
    const onAccepted = vi.fn();
    const app = await buildApp({
      githubWebhook: {
        secret,
        organizationId: "org_1",
        projectId: "project_1",
        inbox,
        onAccepted,
      },
    });

    const body = JSON.stringify({
      action: "opened",
      pull_request: { number: 14 },
    });
    const headers = {
      "content-type": "application/json",
      "x-github-delivery": "delivery-2",
      "x-github-event": "pull_request",
      "x-hub-signature-256": signature(body),
    };

    const first = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers,
      payload: body,
    });
    const second = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers,
      payload: body,
    });

    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({ accepted: true, duplicate: false });
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual({ accepted: true, duplicate: true });
    expect(inbox.entries.size).toBe(1);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(onAccepted).toHaveBeenCalledTimes(1);

    await app.close();
  });
});
