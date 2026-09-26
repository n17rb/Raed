import { z } from 'zod';

export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(100).optional(),
});

export type PageQuery = z.infer<typeof pageQuerySchema>;

export function pageOffset(query: PageQuery): { limit: number; offset: number } {
  return { limit: query.pageSize, offset: (query.page - 1) * query.pageSize };
}

export function paged<T>(items: T[], total: number, query: PageQuery) {
  return {
    items,
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}

/** Escapes % and _ for ILIKE patterns. */
export function likeEscape(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}
