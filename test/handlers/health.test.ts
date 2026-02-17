import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { handler } from "../../src/handlers/health/index.js";

describe("Health check handler", () => {
  const originalEnv = process.env.DEPLOY_VERSION;

  afterEach(() => {
    // Restore original env state
    if (originalEnv !== undefined) {
      process.env.DEPLOY_VERSION = originalEnv;
    } else {
      delete process.env.DEPLOY_VERSION;
    }
  });

  describe("when DEPLOY_VERSION is set", () => {
    beforeEach(() => {
      process.env.DEPLOY_VERSION = "1.2.3";
    });

    it("returns statusCode 200", async () => {
      const response = await handler({} as any);

      expect(response.statusCode).toBe(200);
    });

    it("returns body with status ok and version from env", async () => {
      const response = await handler({} as any);
      const body = JSON.parse(response.body);

      expect(body).toEqual({ status: "ok", version: "1.2.3" });
    });

    it("includes content-type application/json header", async () => {
      const response = await handler({} as any);

      expect(response.headers).toBeDefined();
      expect(response.headers!["content-type"]).toBe("application/json");
    });
  });

  describe("when DEPLOY_VERSION is not set", () => {
    beforeEach(() => {
      delete process.env.DEPLOY_VERSION;
    });

    it("returns statusCode 200", async () => {
      const response = await handler({} as any);

      expect(response.statusCode).toBe(200);
    });

    it('returns "unknown" as the version', async () => {
      const response = await handler({} as any);
      const body = JSON.parse(response.body);

      expect(body).toEqual({ status: "ok", version: "unknown" });
    });

    it("includes content-type application/json header", async () => {
      const response = await handler({} as any);

      expect(response.headers).toBeDefined();
      expect(response.headers!["content-type"]).toBe("application/json");
    });
  });

  describe("response shape", () => {
    beforeEach(() => {
      process.env.DEPLOY_VERSION = "test-version";
    });

    it("returns an object with statusCode, headers, and body", async () => {
      const response = await handler({} as any);

      expect(response).toHaveProperty("statusCode");
      expect(response).toHaveProperty("headers");
      expect(response).toHaveProperty("body");
    });

    it("returns body as a JSON string, not an object", async () => {
      const response = await handler({} as any);

      expect(typeof response.body).toBe("string");
      // Should be valid JSON
      expect(() => JSON.parse(response.body)).not.toThrow();
    });
  });
});
