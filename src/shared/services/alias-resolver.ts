import { getAliasesForChat } from "@shared/services/alias-store.js";
import { SEED_ALIASES } from "@shared/data/seed-aliases.js";

interface AppliedAlias {
  alias: string;
  canonicalActivity: string;
}

export interface ResolveResult {
  resolvedText: string;
  appliedAliases: AppliedAlias[];
}

const TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  aliases: Array<{ alias: string; canonicalActivity: string; confirmations: number; source: string }>;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

export async function resolveAliases(
  tableName: string,
  chatId: string,
  text: string,
): Promise<ResolveResult> {
  const learnedAliases = await getCachedAliases(tableName, chatId);

  if (!text) {
    return { resolvedText: "", appliedAliases: [] };
  }

  // Merge: learned aliases take precedence over seed aliases
  const aliasMap = new Map<string, string>();
  for (const [alias, canonical] of Object.entries(SEED_ALIASES)) {
    aliasMap.set(alias.toLowerCase(), canonical);
  }
  for (const learned of learnedAliases) {
    aliasMap.set(learned.alias.toLowerCase(), learned.canonicalActivity);
  }

  const appliedAliases: AppliedAlias[] = [];
  let resolvedText = text;

  for (const [alias, canonical] of aliasMap) {
    const pattern = new RegExp(`(?<=\\s|^)${escapeRegex(alias)}(?=\\s|$)`, "gi");
    if (pattern.test(resolvedText)) {
      resolvedText = resolvedText.replace(pattern, canonical);
      appliedAliases.push({ alias, canonicalActivity: canonical });
    }
  }

  return { resolvedText, appliedAliases };
}

async function getCachedAliases(
  tableName: string,
  chatId: string,
): Promise<Array<{ alias: string; canonicalActivity: string; confirmations: number; source: string }>> {
  const entry = cache.get(chatId);
  const now = Date.now();

  if (entry && isCacheValid(entry, now)) {
    return entry.aliases;
  }

  const aliases = await getAliasesForChat(tableName, chatId);
  cache.set(chatId, { aliases, fetchedAt: now });
  return aliases;
}

function isCacheValid(entry: CacheEntry, now: number): boolean {
  const elapsed = now - entry.fetchedAt;
  return elapsed > 0 && elapsed <= TTL_MS;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
