import { z } from "zod";

export const ClassificationSchema = z.object({
  type: z.enum(["chore", "recovery", "none"]),
  activity: z.string(),
  effort: z.enum(["low", "medium", "high"]),
  confidence: z.number().min(0).max(1),
});

export type ClassificationResult = z.infer<typeof ClassificationSchema>;

export interface Activity {
  chatId: string;
  activityId: string;
  messageId: number;
  userId: number;
  userName: string;
  type: "chore" | "recovery" | "none";
  activity: string;
  effort: "low" | "medium" | "high";
  confidence: number;
  timestamp: number;
  createdAt: string;
  botMessageId?: number;
}

export interface MessageBody {
  chatId: string;
  messageId: number;
  userId: number;
  userName: string;
  text: string;
  timestamp: number;
  replyToMessageId?: number;
  replyToIsBot?: boolean;
}
