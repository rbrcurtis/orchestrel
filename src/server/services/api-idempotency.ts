import { createHash } from 'node:crypto';
import { ApiIdempotency } from '../models/ApiIdempotency';

export class IdempotencyConflictError extends Error {
  readonly status = 409;
  readonly code = 'idempotency_conflict';
}

export async function runIdempotent<T>(
  key: string | undefined,
  operation: string,
  input: unknown,
  run: () => Promise<T>,
): Promise<T> {
  if (!key) {
    console.log(`[rest:idempotency] ${operation} has no idempotency key`);
    return run();
  }
  if (key.length > 200) throw new IdempotencyConflictError('Idempotency-Key must not exceed 200 characters');

  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const found = await ApiIdempotency.findOneBy({ requestKey: key });
  if (found) {
    if (found.operation !== operation || found.requestHash !== hash) {
      throw new IdempotencyConflictError('Idempotency-Key was already used for a different request');
    }
    if (!found.responseJson) throw new IdempotencyConflictError('A request with this Idempotency-Key is in progress');
    console.log(`[rest:idempotency] replaying key ${key}`);
    return JSON.parse(found.responseJson) as T;
  }

  try {
    await ApiIdempotency.save(ApiIdempotency.create({
      requestKey: key,
      operation,
      requestHash: hash,
      responseJson: '',
      createdAt: new Date().toISOString(),
    }));
  } catch (err) {
    console.error(`[rest:idempotency] failed to reserve key ${key}:`, err);
    const raced = await ApiIdempotency.findOneBy({ requestKey: key });
    if (!raced || raced.operation !== operation || raced.requestHash !== hash) {
      throw new IdempotencyConflictError('Idempotency-Key was already used for a different request');
    }
    if (!raced.responseJson) throw new IdempotencyConflictError('A request with this Idempotency-Key is in progress');
    console.log(`[rest:idempotency] replaying raced key ${key}`);
    return JSON.parse(raced.responseJson) as T;
  }

  try {
    const result = await run();
    await ApiIdempotency.update({ requestKey: key }, { responseJson: JSON.stringify(result) });
    console.log(`[rest:idempotency] stored result for key ${key}`);
    return result;
  } catch (err) {
    console.error(`[rest:idempotency] operation failed for key ${key}:`, err);
    await ApiIdempotency.delete({ requestKey: key });
    throw err;
  }
}
