import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { registerHostedWeb } from "./hosted-web.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

it("serves the frontend on the API origin while preserving API paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbit-hosted-web-"));
  directories.push(directory);
  await mkdir(join(directory, "assets"));
  await writeFile(join(directory, "index.html"), "<html>Orbit</html>");
  await writeFile(join(directory, "assets", "index-a1.js"), "console.log('ok')");

  const app = Fastify();
  app.get("/health", async () => ({ status: "ok" }));
  await registerHostedWeb(app, directory);

  try {
    const html = await app.inject({ method: "GET", url: "/" });
    expect(html.statusCode).toBe(200);
    expect(html.headers["content-type"]).toContain("text/html");
    expect(html.headers["cache-control"]).toBe("no-store");

    const asset = await app.inject({ method: "GET", url: "/assets/index-a1.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toContain("text/javascript");

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.json()).toEqual({ status: "ok" });

    const project = await app.inject({
      method: "GET",
      url: "/projects/unknown",
      headers: { accept: "text/html" },
    });
    expect(project.statusCode).toBe(404);

    const dashboard = await app.inject({
      method: "GET",
      url: "/dashboard",
      headers: { accept: "text/html" },
    });
    expect(dashboard.body).toBe("<html>Orbit</html>");

    const missing = await app.inject({ method: "GET", url: "/assets/nope.js" });
    expect(missing.statusCode).toBe(404);

    const post = await app.inject({
      method: "POST",
      url: "/dashboard",
      headers: { accept: "text/html" },
    });
    expect(post.statusCode).toBe(404);
  } finally {
    await app.close();
  }
});
