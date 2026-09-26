import { formatDate, formatDateTime, formatDistance, formatJod } from '@rayed/api-client';

export const CURRENCY = 'د.أ';

export function jod(fils: number | string | null | undefined): string {
  if (fils === null || fils === undefined || fils === '') return '—';
  return `${formatJod(Number(fils))} ${CURRENCY}`;
}

/** Already formatted "4.20" values from the API. */
export function jodText(display: string | null | undefined): string {
  if (display === null || display === undefined || display === '') return '—';
  return `${display} ${CURRENCY}`;
}

export function dateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return formatDateTime(value);
}

export function dateOnly(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return formatDate(value);
}

export function fullDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat('ar-JO-u-nu-latn', {
      timeZone: 'Asia/Amman',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(value));
  } catch {
    return new Date(value).toLocaleString();
  }
}

export function distance(meters: number | null | undefined): string {
  if (meters === null || meters === undefined) return '—';
  return formatDistance(meters);
}

export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} د`;
  return `${Math.floor(minutes / 60)} س ${minutes % 60} د`;
}

export function num(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  return new Intl.NumberFormat('en-US').format(Number(value));
}

export function rating(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return Number(value).toFixed(1);
}

/** "4.200" JOD text → fils. Returns null when the text is not a valid amount. */
export function parseJod(text: string): number | null {
  const normalized = text.replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit))).replace(',', '.').trim();
  if (normalized === '') return null;
  if (!/^\d+(\.\d{0,3})?$/.test(normalized)) return null;
  return Math.round(Number(normalized) * 1000);
}

export function filsToJodInput(fils: number | null | undefined): string {
  if (fils === null || fils === undefined) return '';
  return (fils / 1000).toFixed(3).replace(/\.?0+$/, '') || '0';
}

/** ISO → value for <input type="datetime-local"> in the browser's timezone. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromLocalInput(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function todayIso(offsetDays = 0): string {
  const date = new Date(Date.now() + offsetDays * 86_400_000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function mapsLink(lat: number, lng: number): string {
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

export function randomPassword(length = 16): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*-_';
  const values = new Uint32Array(length);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join('');
}
