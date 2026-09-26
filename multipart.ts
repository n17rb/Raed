import type { FastifyRequest } from 'fastify';
import { AppError } from './errors';

export interface UploadedFile {
  buffer: Buffer;
  mimetype: string;
  filename: string;
  fields: Record<string, string>;
}

/**
 * Reads one uploaded file. Text fields must be sent BEFORE the file
 * in the multipart form so they are available here.
 */
export async function readUpload(request: FastifyRequest): Promise<UploadedFile> {
  if (!request.isMultipart()) {
    throw new AppError(400, 'FILE_REQUIRED', 'أرفق صورة');
  }
  const file = await request.file();
  if (!file) {
    throw new AppError(400, 'FILE_REQUIRED', 'أرفق صورة');
  }
  const buffer = await file.toBuffer();

  const fields: Record<string, string> = {};
  for (const [name, value] of Object.entries(file.fields)) {
    const entry = Array.isArray(value) ? value[0] : value;
    if (entry && typeof entry === 'object' && 'type' in entry && entry.type === 'field') {
      const fieldValue = (entry as { value: unknown }).value;
      if (typeof fieldValue === 'string') fields[name] = fieldValue;
    }
  }
  return { buffer, mimetype: file.mimetype, filename: file.filename, fields };
}
