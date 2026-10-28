import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("Orbit API", () => {
  it("reports healthy", async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      service: "orbit-api",
    });

    await app.close();
  });
});
