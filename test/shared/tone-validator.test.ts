import { describe, it, expect } from "vitest";

describe("validateTone", () => {
  async function loadModule() {
    const mod = await import("@shared/utils/tone-validator.js");
    return mod;
  }

  // --- Valid (neutral) text ---

  it("returns valid for neutral acknowledgment 'Noterat'", async () => {
    const { validateTone } = await loadModule();
    const result = validateTone("Noterat");
    expect(result).toEqual({ valid: true });
  });

  it("returns valid for neutral clarification question", async () => {
    const { validateTone } = await loadModule();
    const result = validateTone("Menade du tvätt?");
    expect(result).toEqual({ valid: true });
  });

  it("returns valid for simple emoji acknowledgment", async () => {
    const { validateTone } = await loadModule();
    const result = validateTone("Noterat \u2713");
    expect(result).toEqual({ valid: true });
  });

  // --- Blame patterns ---

  it("rejects text containing blame pattern 'du borde'", async () => {
    const { validateTone } = await loadModule();
    const result = validateTone("du borde städa oftare");
    expect(result.valid).toBe(false);
    expect(result).toHaveProperty("reason");
    expect(typeof result.reason).toBe("string");
  });

  it("rejects blame pattern case-insensitively ('Du Borde')", async () => {
    const { validateTone } = await loadModule();
    const result = validateTone("Du Borde hjälpa till mer");
    expect(result.valid).toBe(false);
    expect(result).toHaveProperty("reason");
  });

  // --- Comparison patterns ---

  it("rejects text containing comparison pattern 'mer än'", async () => {
    const { validateTone } = await loadModule();
    const result = validateTone("Lisa gjorde mer än Erik");
    expect(result.valid).toBe(false);
    expect(result).toHaveProperty("reason");
  });

  it("rejects comparison pattern case-insensitively", async () => {
    const { validateTone } = await loadModule();
    const result = validateTone("Mer Än vad som behövs");
    expect(result.valid).toBe(false);
    expect(result).toHaveProperty("reason");
  });

  // --- Command patterns ---

  it("rejects text containing command pattern 'gör detta'", async () => {
    const { validateTone } = await loadModule();
    const result = validateTone("gör detta nu");
    expect(result.valid).toBe(false);
    expect(result).toHaveProperty("reason");
  });

  it("rejects command pattern case-insensitively", async () => {
    const { validateTone } = await loadModule();
    const result = validateTone("Gör Detta direkt");
    expect(result.valid).toBe(false);
    expect(result).toHaveProperty("reason");
  });

  // --- Judgment patterns ---

  it("rejects text containing positive judgment 'bra jobbat'", async () => {
    const { validateTone } = await loadModule();
    const result = validateTone("bra jobbat idag");
    expect(result.valid).toBe(false);
    expect(result).toHaveProperty("reason");
  });

  it("rejects text containing negative judgment 'dåligt'", async () => {
    const { validateTone } = await loadModule();
    const result = validateTone("det var dåligt");
    expect(result.valid).toBe(false);
    expect(result).toHaveProperty("reason");
  });

  it("rejects judgment pattern case-insensitively ('Bra Jobbat')", async () => {
    const { validateTone } = await loadModule();
    const result = validateTone("Bra Jobbat!");
    expect(result.valid).toBe(false);
    expect(result).toHaveProperty("reason");
  });

  it("rejects 'dåligt' case-insensitively", async () => {
    const { validateTone } = await loadModule();
    const result = validateTone("DÅLIGT gjort");
    expect(result.valid).toBe(false);
    expect(result).toHaveProperty("reason");
  });

  // --- Edge cases ---

  it("returns valid for empty string", async () => {
    const { validateTone } = await loadModule();
    const result = validateTone("");
    expect(result).toEqual({ valid: true });
  });

  it("does not false-positive on partial word matches", async () => {
    const { validateTone } = await loadModule();
    // "borde" alone without "du" prefix should not trigger blame
    // This depends on implementation — testing that the pattern is
    // the full phrase "du borde", not just "borde"
    const result = validateTone("Noterat, borde vara klart");
    // Note: This test verifies that "borde" alone doesn't match "du borde"
    // The implementation should match the full phrase
    expect(result.valid).toBe(true);
  });
});
