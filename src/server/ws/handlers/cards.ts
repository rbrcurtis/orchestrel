import type { AckResponse, Card } from '../../../shared/ws-protocol';
import { cardService } from '../../services/card';

export async function handleCardCreate(
  data: { title: string; description?: string; column?: string; projectId?: number | null; model?: string; provider?: string; thinkingLevel?: string; useWorktree?: boolean; sourceBranch?: 'main' | 'dev' | null; archiveOthers?: boolean },
  callback: (res: AckResponse<Card>) => void,
): Promise<void> {
  try {
    if (!data.projectId) throw new Error('projectId is required');
    const card = await cardService.createCard(data);
    callback({ data: card as unknown as Card });
  } catch (err) {
    callback({ error: String(err instanceof Error ? err.message : err) });
  }
}

export async function handleCardUpdate(
  data: { id: number; [key: string]: unknown },
  callback: (res: AckResponse<Card>) => void,
): Promise<void> {
  const { id, ...rest } = data;
  try {
    const card = await cardService.updateCard(id, rest);
    callback({ data: card as unknown as Card });
  } catch (err) {
    callback({ error: String(err instanceof Error ? err.message : err) });
  }
}

export async function handleCardDelete(
  data: { id: number },
  callback: (res: AckResponse) => void,
): Promise<void> {
  try {
    await cardService.deleteCard(data.id);
    callback({});
  } catch (err) {
    callback({ error: String(err instanceof Error ? err.message : err) });
  }
}

export async function handleCardGenerateTitle(
  data: { id: number },
  callback: (res: AckResponse<Card>) => void,
): Promise<void> {
  try {
    const card = await cardService.generateTitle(data.id);
    callback({ data: card as unknown as Card });
  } catch (err) {
    callback({ error: String(err instanceof Error ? err.message : err) });
  }
}

export async function handleCardSuggestTitle(
  data: { description: string },
  callback: (res: AckResponse<string>) => void,
): Promise<void> {
  try {
    const title = await cardService.suggestTitle(data.description);
    callback({ data: title });
  } catch (err) {
    callback({ error: String(err instanceof Error ? err.message : err) });
  }
}
