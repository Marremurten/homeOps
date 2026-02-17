interface SendMessageParams {
  token: string;
  chatId: number;
  text: string;
  replyToMessageId?: number;
}

type SendMessageResult =
  | { ok: true; messageId: number }
  | { ok: false; error: string };

export async function sendMessage(
  params: SendMessageParams,
): Promise<SendMessageResult> {
  const { token, chatId, text, replyToMessageId } = params;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...(replyToMessageId !== undefined && {
          reply_parameters: {
            message_id: replyToMessageId,
            allow_sending_without_reply: true,
          },
        }),
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      const error = data.description ?? `${response.status} ${response.statusText}`;
      console.error("sendMessage failed:", error);
      return { ok: false, error };
    }

    return { ok: true, messageId: data.result.message_id };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("sendMessage error:", error);
    return { ok: false, error };
  }
}

let cachedBotInfo: { id: number; username: string } | null = null;

export async function getBotInfo(
  token: string,
): Promise<{ id: number; username: string }> {
  if (cachedBotInfo) {
    return cachedBotInfo;
  }

  const url = `https://api.telegram.org/bot${token}/getMe`;
  const response = await fetch(url);
  const data = await response.json();

  cachedBotInfo = { id: data.result.id, username: data.result.username };
  return cachedBotInfo;
}
