import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { sendMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
}));

vi.mock("@aws-sdk/client-secrets-manager", () => {
  return {
    SecretsManagerClient: vi.fn().mockImplementation(function () {
      return { send: sendMock };
    }),
    GetSecretValueCommand: vi.fn().mockImplementation(function (input: unknown) {
      return { input };
    }),
  };
});

import { getSecret } from "@shared/utils/secrets.js";

describe("getSecret", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sendMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls SecretsManager with the given secretArn and returns SecretString", async () => {
    sendMock.mockResolvedValueOnce({ SecretString: "my-secret-value" });

    const result = await getSecret("arn:aws:secretsmanager:us-east-1:123456789:secret:my-secret");

    expect(sendMock).toHaveBeenCalledOnce();
    expect(result).toBe("my-secret-value");
  });

  it("caches the result -- second call with same ARN does not call SecretsManager again", async () => {
    sendMock.mockResolvedValueOnce({ SecretString: "cached-secret" });

    const arn = "arn:aws:secretsmanager:us-east-1:123456789:secret:cached";
    const first = await getSecret(arn);
    const second = await getSecret(arn);

    expect(sendMock).toHaveBeenCalledOnce();
    expect(first).toBe("cached-secret");
    expect(second).toBe("cached-secret");
  });

  it("re-fetches after TTL expires (5 minutes)", async () => {
    sendMock
      .mockResolvedValueOnce({ SecretString: "original" })
      .mockResolvedValueOnce({ SecretString: "refreshed" });

    const arn = "arn:aws:secretsmanager:us-east-1:123456789:secret:ttl-test";
    const first = await getSecret(arn);
    expect(first).toBe("original");
    expect(sendMock).toHaveBeenCalledTimes(1);

    // Advance past 5-minute TTL
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    const second = await getSecret(arn);
    expect(second).toBe("refreshed");
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("throws if SecretsManager returns an error", async () => {
    sendMock.mockRejectedValueOnce(new Error("AccessDeniedException"));

    await expect(
      getSecret("arn:aws:secretsmanager:us-east-1:123456789:secret:forbidden"),
    ).rejects.toThrow("AccessDeniedException");
  });
});
