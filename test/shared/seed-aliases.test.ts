import { describe, it, expect } from "vitest";

describe("SEED_ALIASES", () => {
  async function loadModule() {
    const mod = await import("@shared/data/seed-aliases.js");
    return mod;
  }

  it("exports SEED_ALIASES as a Record<string, string>", async () => {
    const { SEED_ALIASES } = await loadModule();
    expect(typeof SEED_ALIASES).toBe("object");
    expect(SEED_ALIASES).not.toBeNull();
  });

  it("maps 'pant' to 'pantning'", async () => {
    const { SEED_ALIASES } = await loadModule();
    expect(SEED_ALIASES["pant"]).toBe("pantning");
  });

  it("maps 'dammsuga' to 'dammsugning'", async () => {
    const { SEED_ALIASES } = await loadModule();
    expect(SEED_ALIASES["dammsuga"]).toBe("dammsugning");
  });

  it("maps 'disk' to 'diskning'", async () => {
    const { SEED_ALIASES } = await loadModule();
    expect(SEED_ALIASES["disk"]).toBe("diskning");
  });

  it("maps 'tvätt' to 'tvättning'", async () => {
    const { SEED_ALIASES } = await loadModule();
    expect(SEED_ALIASES["tvätt"]).toBe("tvättning");
  });

  it("maps 'städ' to 'städning'", async () => {
    const { SEED_ALIASES } = await loadModule();
    expect(SEED_ALIASES["städ"]).toBe("städning");
  });

  it("has all keys in lowercase", async () => {
    const { SEED_ALIASES } = await loadModule();
    for (const key of Object.keys(SEED_ALIASES)) {
      expect(key).toBe(key.toLowerCase());
    }
  });

  it("has no empty string values", async () => {
    const { SEED_ALIASES } = await loadModule();
    for (const [key, value] of Object.entries(SEED_ALIASES)) {
      expect(value, `value for key '${key}' should be non-empty`).not.toBe("");
      expect(typeof value).toBe("string");
    }
  });

  it("contains at least the 5 required mappings", async () => {
    const { SEED_ALIASES } = await loadModule();
    const requiredKeys = ["pant", "dammsuga", "disk", "tvätt", "städ"];
    for (const key of requiredKeys) {
      expect(SEED_ALIASES, `missing required key '${key}'`).toHaveProperty(key);
    }
  });
});
