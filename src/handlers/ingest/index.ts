import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import type { TelegramUpdate } from "@shared/types/telegram";
import { isTextMessage } from "@shared/types/telegram";

let sqs: InstanceType<typeof SQSClient>;

export async function handler(event: {
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: boolean;
}) {
  try {
    if (!sqs) {
      sqs = new SQSClient({});
    }
    const { getSecret } = await import("@shared/utils/secrets");
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

    const messageBody = {
      chatId: message.chat.id,
      messageId: message.message_id,
      userId: from.id,
      userName: from.username ?? from.first_name,
      text: message.text,
      timestamp: message.date,
    };

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: process.env.SQS_QUEUE_URL,
        MessageBody: JSON.stringify(messageBody),
      }),
    );

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
