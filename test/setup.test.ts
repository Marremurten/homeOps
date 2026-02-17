import { describe, it, expect } from "vitest";

describe("Project scaffolding", () => {
  describe("vitest", () => {
    it("runs successfully", () => {
      expect(true).toBe(true);
    });
  });

  describe("tsconfig.json", () => {
    it("compiles without errors", { timeout: 30_000 }, async () => {
      const { execFileSync } = await import("node:child_process");
      const result = execFileSync("npx", ["tsc", "--noEmit"], {
        cwd: process.cwd(),
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      // tsc --noEmit exits 0 on success; execFileSync throws on non-zero exit
      expect(result).toBeDefined();
    });
  });

  describe("path alias @shared/types/telegram", () => {
    it("resolves the module", async () => {
      const telegramModule = await import("@shared/types/telegram.js");
      expect(telegramModule).toBeDefined();
    });

    it("exports isTextMessage type guard", async () => {
      const { isTextMessage } = await import("@shared/types/telegram.js");
      expect(typeof isTextMessage).toBe("function");
    });

    it("exports expected Telegram types", async () => {
      const mod = await import("@shared/types/telegram.js");
      // Verify the module has the expected shape -- type-level exports
      // won't be present at runtime, but isTextMessage should be
      expect(mod).toHaveProperty("isTextMessage");
    });
  });
});
