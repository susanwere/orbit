import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { registerHostedWeb } from "./hosted-web.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
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
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({
      status: "ok",
    });
    expect((await app.inject({ method: "GET", url: "/projects/unknown", headers: { accept: "text/html" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/dashboard", headers: { accept: "text/html" } })).body).toBe("<html>Orbit</html>");
    expect((await app.inject({ method: "GET", url: "/assets/nope.js" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/dashboard", headers: { accept: "text/html" } })).statusCode).toBe(404);
  } finally {
    await app.close();
  }
});
