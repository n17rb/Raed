import type { z } from 'zod';
import { AppError } from './errors';

export function parseInput<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'البيانات المدخلة غير صحيحة', result.error.flatten());
  }
  return result.data;
}
