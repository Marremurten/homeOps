import { describe, it, expect } from "vitest";

describe("AFFIRMATIVE_PATTERNS", () => {
  async function loadModule() {
    const mod = await import("@shared/data/swedish-patterns.js");
    return mod;
  }

  const affirmativeWords = [
    "ja",
    "japp",
    "jepp",
    "jo",
    "precis",
    "absolut",
    "aa",
    "mm",
    "okej",
    "jadå",
  ];

  it("exports AFFIRMATIVE_PATTERNS as a RegExp", async () => {
    const { AFFIRMATIVE_PATTERNS } = await loadModule();
    expect(AFFIRMATIVE_PATTERNS).toBeInstanceOf(RegExp);
  });

  for (const word of affirmativeWords) {
    it(`matches affirmative word '${word}'`, async () => {
      const { AFFIRMATIVE_PATTERNS } = await loadModule();
      expect(AFFIRMATIVE_PATTERNS.test(word)).toBe(true);
    });
  }

  it("matches case-insensitively (uppercase)", async () => {
    const { AFFIRMATIVE_PATTERNS } = await loadModule();
    expect(AFFIRMATIVE_PATTERNS.test("JA")).toBe(true);
    expect(AFFIRMATIVE_PATTERNS.test("Okej")).toBe(true);
    expect(AFFIRMATIVE_PATTERNS.test("PRECIS")).toBe(true);
  });

  it("does not match partial words embedded in longer strings", async () => {
    const { AFFIRMATIVE_PATTERNS } = await loadModule();
    // "ja" should not match inside "jamen" as a full-word match
    expect(AFFIRMATIVE_PATTERNS.test("jamen")).toBe(false);
    expect(AFFIRMATIVE_PATTERNS.test("ojadå")).toBe(false);
  });

  it("does not match unrelated words", async () => {
    const { AFFIRMATIVE_PATTERNS } = await loadModule();
    expect(AFFIRMATIVE_PATTERNS.test("nej")).toBe(false);
    expect(AFFIRMATIVE_PATTERNS.test("kanske")).toBe(false);
    expect(AFFIRMATIVE_PATTERNS.test("hej")).toBe(false);
  });
});

describe("NEGATION_PATTERNS", () => {
  async function loadModule() {
    const mod = await import("@shared/data/swedish-patterns.js");
    return mod;
  }

  const negationWords = ["nej", "nä", "nää", "nix", "nope"];

  it("exports NEGATION_PATTERNS as a RegExp", async () => {
    const { NEGATION_PATTERNS } = await loadModule();
    expect(NEGATION_PATTERNS).toBeInstanceOf(RegExp);
  });

  for (const word of negationWords) {
    it(`matches negation word '${word}'`, async () => {
      const { NEGATION_PATTERNS } = await loadModule();
      expect(NEGATION_PATTERNS.test(word)).toBe(true);
    });
  }

  it("matches case-insensitively", async () => {
    const { NEGATION_PATTERNS } = await loadModule();
    expect(NEGATION_PATTERNS.test("NEJ")).toBe(true);
    expect(NEGATION_PATTERNS.test("Nä")).toBe(true);
    expect(NEGATION_PATTERNS.test("NOPE")).toBe(true);
  });

  it("does not match 'nahå'", async () => {
    const { NEGATION_PATTERNS } = await loadModule();
    expect(NEGATION_PATTERNS.test("nahå")).toBe(false);
  });

  it("does not match 'nåmen'", async () => {
    const { NEGATION_PATTERNS } = await loadModule();
    expect(NEGATION_PATTERNS.test("nåmen")).toBe(false);
  });

  it("does not match affirmative words", async () => {
    const { NEGATION_PATTERNS } = await loadModule();
    expect(NEGATION_PATTERNS.test("ja")).toBe(false);
    expect(NEGATION_PATTERNS.test("okej")).toBe(false);
  });
});

describe("extractNegationRemainder", () => {
  async function loadModule() {
    const mod = await import("@shared/data/swedish-patterns.js");
    return mod;
  }

  it("extracts remainder after 'nej,' prefix", async () => {
    const { extractNegationRemainder } = await loadModule();
    const result = extractNegationRemainder("nej, jag menade tvätt");
    expect(result).toBe("jag menade tvätt");
  });

  it("extracts remainder after 'nä,' prefix", async () => {
    const { extractNegationRemainder } = await loadModule();
    const result = extractNegationRemainder("nä, det var diskning");
    expect(result).toBe("det var diskning");
  });

  it("handles uppercase negation prefix", async () => {
    const { extractNegationRemainder } = await loadModule();
    const result = extractNegationRemainder("NEJ, jag menade städning");
    expect(result).toBe("jag menade städning");
  });

  it("handles negation without comma", async () => {
    const { extractNegationRemainder } = await loadModule();
    const result = extractNegationRemainder("nej jag menade tvätt");
    expect(result).toBe("jag menade tvätt");
  });

  it("returns null when no negation prefix is found", async () => {
    const { extractNegationRemainder } = await loadModule();
    expect(extractNegationRemainder("jag menade tvätt")).toBeNull();
  });

  it("returns null for empty string", async () => {
    const { extractNegationRemainder } = await loadModule();
    expect(extractNegationRemainder("")).toBeNull();
  });

  it("returns null for affirmative text", async () => {
    const { extractNegationRemainder } = await loadModule();
    expect(extractNegationRemainder("ja, precis")).toBeNull();
  });

  it("trims whitespace from the remainder", async () => {
    const { extractNegationRemainder } = await loadModule();
    const result = extractNegationRemainder("nej,   jag menade tvätt  ");
    expect(result).toBe("jag menade tvätt");
  });

  it("returns null when negation word is the entire text", async () => {
    const { extractNegationRemainder } = await loadModule();
    // "nej" alone has no remainder text
    expect(extractNegationRemainder("nej")).toBeNull();
  });
});
