import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import {
  ClassificationSchema,
  type ClassificationResult,
} from "@shared/types/classification.js";

export const CLASSIFICATION_MODEL = "gpt-4o-mini";

const FALLBACK_RESULT: ClassificationResult = {
  type: "none",
  activity: "",
  effort: "low",
  confidence: 0,
};

const SYSTEM_PROMPT = `You are a household activity classifier. Given a message in Swedish, classify it into one of three types: "chore", "recovery", or "none".

- "chore": household tasks or productive activities
- "recovery": rest, relaxation, or self-care activities
- "none": messages that do not describe any activity

Assign an effort level: "low", "medium", or "high" based on physical/mental effort required.
Provide a short activity label (in Swedish) and a confidence score between 0 and 1.

Confidence bands:
- 0.85-1.0: Very confident — message clearly describes an activity
- 0.6-0.84: Somewhat confident — message likely describes an activity
- 0.3-0.59: Low confidence — message is ambiguous
- 0.0-0.29: Very low confidence — message is unlikely an activity

Examples:
- "Jag har städat hela lägenheten" -> type: "chore", activity: "städa", effort: "high", confidence: 0.95
- "Diskade efter middagen" -> type: "chore", activity: "diska", effort: "medium", confidence: 0.92
- "Tvättade alla kläder idag" -> type: "chore", activity: "tvätta", effort: "medium", confidence: 0.90
- "Lagade mat till familjen" -> type: "chore", activity: "laga mat", effort: "medium", confidence: 0.91
- "Dammsugade vardagsrummet" -> type: "chore", activity: "dammsuga", effort: "medium", confidence: 0.93
- "Vilade på soffan en stund" -> type: "recovery", activity: "vila", effort: "low", confidence: 0.88
- "Sov en tupplur" -> type: "recovery", activity: "sova", effort: "low", confidence: 0.90
- "Drack en kopp kaffe i lugn och ro" -> type: "recovery", activity: "kaffe", effort: "low", confidence: 0.85
- "Vad ska vi äta ikväll?" -> type: "none", activity: "", effort: "low", confidence: 0.15`;

export async function classifyMessage(
  text: string,
  apiKey: string,
): Promise<ClassificationResult> {
  try {
    const client = new OpenAI({
      apiKey,
      timeout: 10_000,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await (client as any).beta.chat.completions.parse({
      model: CLASSIFICATION_MODEL,
      temperature: 0.2,
      max_completion_tokens: 200,
      response_format: zodResponseFormat(ClassificationSchema, "classification"),
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
    });

    const parsed = response.choices?.[0]?.message?.parsed;
    if (!parsed) {
      return FALLBACK_RESULT;
    }

    return parsed;
  } catch (err: unknown) {
    console.error("classifyMessage error:", err instanceof Error ? err.message : String(err));
    return FALLBACK_RESULT;
  }
}
