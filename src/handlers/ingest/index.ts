import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import type { TelegramUpdate } from "@shared/types/telegram.js";
import { isTextMessage } from "@shared/types/telegram.js";

let sqs: SQSClient;

export async function handler(event: {
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: boolean;
}) {
  try {
    if (!sqs) {
      sqs = new SQSClient({});
    }
    const { getSecret } = await import("@shared/utils/secrets.js");
    const secret = await getSecret(process.env.WEBHOOK_SECRET_ARN!);

    const token = event.headers["x-telegram-bot-api-secret-token"];
    if (token !== secret) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: "Unauthorized" }),
      };
    }

    const update: TelegramUpdate = JSON.parse(event.body);

    if (!isTextMessage(update)) {
      return {
        statusCode: 200,
        body: JSON.stringify({}),
      };
    }

    const message = update.message!;
    const from = message.from!;

    const messageBody: Record<string, unknown> = {
      chatId: String(message.chat.id),
      messageId: message.message_id,
      userId: from.id,
      userName: from.username ?? from.first_name,
      text: message.text,
      timestamp: message.date,
    };

    if (message.reply_to_message) {
      messageBody.replyToMessageId = message.reply_to_message.message_id;
      messageBody.replyToIsBot = message.reply_to_message.from?.is_bot ?? false;
    }

    const command = new SendMessageCommand({
      QueueUrl: process.env.SQS_QUEUE_URL,
      MessageBody: JSON.stringify(messageBody),
    });

    await sqs.send(command);

    return {
      statusCode: 200,
      body: JSON.stringify({}),
    };
  } catch {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
}
