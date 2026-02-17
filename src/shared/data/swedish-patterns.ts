export const AFFIRMATIVE_PATTERNS: RegExp =
  /^(?:ja|japp|jepp|jo|precis|absolut|aa|mm|okej|jadå)$/i;

export const NEGATION_PATTERNS: RegExp = /^(?:nej|nä|nää|nix|nope)$/i;

const NEGATION_PREFIX = /^(?:nej|nä|nää|nix|nope)[,]?\s+/i;

export function extractNegationRemainder(text: string): string | null {
  if (!text) return null;
  const match = text.match(NEGATION_PREFIX);
  if (!match) return null;
  const remainder = text.slice(match[0].length).trim();
  return remainder.length > 0 ? remainder : null;
}
