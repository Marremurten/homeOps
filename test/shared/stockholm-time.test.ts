import { describe, it, expect } from "vitest";

describe("getStockholmDate", () => {
  async function loadModule() {
    const mod = await import("@shared/utils/stockholm-time.js");
    return mod;
  }

  it("returns YYYY-MM-DD format", async () => {
    const { getStockholmDate } = await loadModule();
    const result = getStockholmDate(new Date("2026-02-17T12:00:00Z"));
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns correct date for a midday UTC time", async () => {
    const { getStockholmDate } = await loadModule();
    // 2026-02-17T12:00:00Z is 13:00 Stockholm (UTC+1 in winter)
    const result = getStockholmDate(new Date("2026-02-17T12:00:00Z"));
    expect(result).toBe("2026-02-17");
  });

  it("handles DST transition CET to CEST (2026-03-29)", async () => {
    const { getStockholmDate } = await loadModule();
    // On 2026-03-29, clocks spring forward at 02:00 CET to 03:00 CEST
    // 01:30 UTC = 02:30 CET (before transition) → still March 29
    const result = getStockholmDate(new Date("2026-03-29T01:30:00Z"));
    expect(result).toBe("2026-03-29");
  });

  it("handles midnight boundary — late UTC becomes next day in Stockholm", async () => {
    const { getStockholmDate } = await loadModule();
    // 2026-02-17T23:30:00Z = 2026-02-18T00:30:00 Stockholm (UTC+1)
    const result = getStockholmDate(new Date("2026-02-17T23:30:00Z"));
    expect(result).toBe("2026-02-18");
  });

  it("handles midnight boundary — just before midnight UTC stays same day in Stockholm during summer", async () => {
    const { getStockholmDate } = await loadModule();
    // 2026-07-15T21:59:00Z = 2026-07-15T23:59:00 Stockholm (UTC+2 in summer)
    const result = getStockholmDate(new Date("2026-07-15T21:59:00Z"));
    expect(result).toBe("2026-07-15");
  });

  it("handles midnight boundary — just after midnight UTC crosses day in Stockholm during summer", async () => {
    const { getStockholmDate } = await loadModule();
    // 2026-07-15T22:01:00Z = 2026-07-16T00:01:00 Stockholm (UTC+2 in summer)
    const result = getStockholmDate(new Date("2026-07-15T22:01:00Z"));
    expect(result).toBe("2026-07-16");
  });
});

describe("isQuietHours", () => {
  async function loadModule() {
    const mod = await import("@shared/utils/stockholm-time.js");
    return mod;
  }

  it("returns true during quiet hours — 22:00 Stockholm (exactly)", async () => {
    const { isQuietHours } = await loadModule();
    // 22:00 Stockholm in winter (UTC+1) = 21:00 UTC
    const result = isQuietHours(new Date("2026-02-17T21:00:00Z"));
    expect(result).toBe(true);
  });

  it("returns true during quiet hours — 23:00 Stockholm", async () => {
    const { isQuietHours } = await loadModule();
    // 23:00 Stockholm in winter (UTC+1) = 22:00 UTC
    const result = isQuietHours(new Date("2026-02-17T22:00:00Z"));
    expect(result).toBe(true);
  });

  it("returns true during quiet hours — midnight Stockholm", async () => {
    const { isQuietHours } = await loadModule();
    // 00:00 Stockholm on Feb 18 (UTC+1) = 23:00 UTC on Feb 17
    const result = isQuietHours(new Date("2026-02-17T23:00:00Z"));
    expect(result).toBe(true);
  });

  it("returns true during quiet hours — 03:00 Stockholm", async () => {
    const { isQuietHours } = await loadModule();
    // 03:00 Stockholm (UTC+1) = 02:00 UTC
    const result = isQuietHours(new Date("2026-02-18T02:00:00Z"));
    expect(result).toBe(true);
  });

  it("returns true during quiet hours — 06:59 Stockholm", async () => {
    const { isQuietHours } = await loadModule();
    // 06:59 Stockholm (UTC+1) = 05:59 UTC
    const result = isQuietHours(new Date("2026-02-18T05:59:00Z"));
    expect(result).toBe(true);
  });

  it("returns false at exactly 07:00 Stockholm", async () => {
    const { isQuietHours } = await loadModule();
    // 07:00 Stockholm (UTC+1) = 06:00 UTC
    const result = isQuietHours(new Date("2026-02-18T06:00:00Z"));
    expect(result).toBe(false);
  });

  it("returns false during daytime — 12:00 Stockholm", async () => {
    const { isQuietHours } = await loadModule();
    // 12:00 Stockholm (UTC+1) = 11:00 UTC
    const result = isQuietHours(new Date("2026-02-17T11:00:00Z"));
    expect(result).toBe(false);
  });

  it("returns false during daytime — 21:59 Stockholm", async () => {
    const { isQuietHours } = await loadModule();
    // 21:59 Stockholm (UTC+1) = 20:59 UTC
    const result = isQuietHours(new Date("2026-02-17T20:59:00Z"));
    expect(result).toBe(false);
  });

  it("handles summer time correctly — 22:00 CEST", async () => {
    const { isQuietHours } = await loadModule();
    // 22:00 Stockholm in summer (UTC+2) = 20:00 UTC
    const result = isQuietHours(new Date("2026-07-15T20:00:00Z"));
    expect(result).toBe(true);
  });

  it("handles summer time correctly — 07:00 CEST", async () => {
    const { isQuietHours } = await loadModule();
    // 07:00 Stockholm in summer (UTC+2) = 05:00 UTC
    const result = isQuietHours(new Date("2026-07-15T05:00:00Z"));
    expect(result).toBe(false);
  });
});
