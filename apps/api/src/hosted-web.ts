import { readFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const defaultWebDist = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const assetTypes: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function assetContentType(name: string): string | undefined {
  const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
  return assetTypes[extension];
}

/**
 * Demo-only same-origin frontend hosting. Keeping the browser on the same
 * origin as /auth allows strict, HttpOnly refresh cookies to survive reloads
 * without permitting third-party cookies or weakening SameSite protection.
 */
export async function registerHostedWeb(
  app: FastifyInstance,
  directory = defaultWebDist,
): Promise<void> {
  const root = resolve(directory);
  const index = await readFile(join(root, "index.html"));

  app.get("/", async (_request, reply) =>
    reply.header("Cache-Control", "no-store").type("text/html; charset=utf-8").send(index),
  );

  app.get<{ Params: { "*": string } }>("/assets/*", async (request, reply) => {
    const fileName = request.params["*"];
    if (!/^[A-Za-z0-9_.-]+$/.test(fileName)) return reply.code(404).send();
    const type = assetContentType(fileName);
    if (!type) return reply.code(404).send();

    const file = join(root, "assets", fileName);
    try {
      const info = await stat(file);
      if (!info.isFile()) return reply.code(404).send();
      return reply
        .header("Cache-Control", "public, max-age=31536000, immutable")
        .type(type)
        .send(await readFile(file));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return reply.code(404).send();
      }
      throw error;
    }
  });

  app.setNotFoundHandler(async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    const reserved = ["/auth", "/projects", "/webhooks", "/health", "/assets"];
    if (
      request.method !== "GET" ||
      !request.headers.accept?.includes("text/html") ||
      reserved.some((prefix) => path === prefix || path.startsWith(prefix + "/"))
    ) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.header("Cache-Control", "no-store").type("text/html; charset=utf-8").send(index);
  });
}
