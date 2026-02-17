import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

let client: SecretsManagerClient;

interface CacheEntry {
  value: string;
  expiry: number;
}

const cache = new Map<string, CacheEntry>();

const TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function getSecret(secretArn: string): Promise<string> {
  if (!client) {
    client = new SecretsManagerClient({});
  }

  const cached = cache.get(secretArn);
  if (cached && Date.now() < cached.expiry) {
    return cached.value;
  }

  const response = await client.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );

  const value = response.SecretString!;
  cache.set(secretArn, { value, expiry: Date.now() + TTL_MS });
  return value;
}
