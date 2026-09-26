import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env';
import { AppError } from '../lib/errors';

export type Visibility = 'PUBLIC' | 'PRIVATE';

interface StorageConfig {
  client: S3Client;
  publicBucket: string;
  privateBucket: string;
  publicBaseUrl: string;
}

let storage: StorageConfig | null = null;

export function isStorageConfigured(): boolean {
  return Boolean(
    env.STORAGE_ENDPOINT &&
      env.STORAGE_BUCKET_PUBLIC &&
      env.STORAGE_BUCKET_PRIVATE &&
      env.STORAGE_ACCESS_KEY &&
      env.STORAGE_SECRET_KEY &&
      env.STORAGE_PUBLIC_URL
  );
}

function getStorage(): StorageConfig {
  if (storage) return storage;
  const {
    STORAGE_ENDPOINT,
    STORAGE_REGION,
    STORAGE_BUCKET_PUBLIC,
    STORAGE_BUCKET_PRIVATE,
    STORAGE_ACCESS_KEY,
    STORAGE_SECRET_KEY,
    STORAGE_PUBLIC_URL,
  } = env;
  if (
    !STORAGE_ENDPOINT ||
    !STORAGE_BUCKET_PUBLIC ||
    !STORAGE_BUCKET_PRIVATE ||
    !STORAGE_ACCESS_KEY ||
    !STORAGE_SECRET_KEY ||
    !STORAGE_PUBLIC_URL
  ) {
    throw new AppError(503, 'STORAGE_NOT_CONFIGURED', 'رفع الصور غير مفعّل حاليًا');
  }
  storage = {
    client: new S3Client({
      region: STORAGE_REGION,
      endpoint: STORAGE_ENDPOINT,
      forcePathStyle: true,
      credentials: { accessKeyId: STORAGE_ACCESS_KEY, secretAccessKey: STORAGE_SECRET_KEY },
    }),
    publicBucket: STORAGE_BUCKET_PUBLIC,
    privateBucket: STORAGE_BUCKET_PRIVATE,
    publicBaseUrl: STORAGE_PUBLIC_URL.replace(/\/+$/, ''),
  };
  return storage;
}

export async function putObject(visibility: Visibility, key: string, body: Buffer, contentType: string): Promise<void> {
  const config = getStorage();
  await config.client.send(
    new PutObjectCommand({
      Bucket: visibility === 'PUBLIC' ? config.publicBucket : config.privateBucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: visibility === 'PUBLIC' ? 'public, max-age=31536000, immutable' : 'private, no-store',
    })
  );
}

export function publicUrl(key: string): string {
  return `${getStorage().publicBaseUrl}/${key}`;
}

/** Short-lived link for private files (documents, transfer proofs). */
export async function signedPrivateUrl(key: string, expiresInSeconds = 600): Promise<string> {
  const config = getStorage();
  return getSignedUrl(config.client, new GetObjectCommand({ Bucket: config.privateBucket, Key: key }), {
    expiresIn: expiresInSeconds,
  });
}
