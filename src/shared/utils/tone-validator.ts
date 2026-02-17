const BLOCKED_PATTERNS: { pattern: RegExp; category: string }[] = [
  { pattern: /du borde/i, category: "blame" },
  { pattern: /mer än/i, category: "comparison" },
  { pattern: /gör detta/i, category: "command" },
  { pattern: /bra jobbat/i, category: "judgment" },
  { pattern: /dåligt/i, category: "judgment" },
];

export function validateTone(text: string): { valid: boolean; reason?: string } {
  for (const { pattern, category } of BLOCKED_PATTERNS) {
    if (pattern.test(text)) {
      return { valid: false, reason: `Contains ${category} language` };
    }
  }
  return { valid: true };
}
