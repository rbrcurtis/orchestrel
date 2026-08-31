/* Telegram alert for the daily maintainer summary. Plain fetch; no SDK. */
export async function sendTelegramAlert(botToken: string, chatId: string, text: string): Promise<boolean> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    throw new Error(`telegram sendMessage: ${res.status} ${await res.text()}`);
  }
  return true;
}
