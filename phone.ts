/** Converts Arabic-Indic and Persian digits to Latin digits. */
export function toLatinDigits(value: string): string {
  return value
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
}

/**
 * Normalizes a Jordanian mobile number to E.164 (+9627XXXXXXXX).
 * Accepts 079…, 79…, 962…, 00962…, +962… with spaces or dashes.
 * Returns null when the number is not a valid Jordanian mobile.
 */
export function normalizeJordanPhone(input: string): string | null {
  const cleaned = toLatinDigits(input).replace(/[\s\-()]/g, '');
  let local: string | null = null;

  if (/^\+9627\d{8}$/.test(cleaned)) local = cleaned.slice(4);
  else if (/^009627\d{8}$/.test(cleaned)) local = cleaned.slice(5);
  else if (/^9627\d{8}$/.test(cleaned)) local = cleaned.slice(3);
  else if (/^07\d{8}$/.test(cleaned)) local = cleaned.slice(1);
  else if (/^7\d{8}$/.test(cleaned)) local = cleaned;

  if (!local || !/^7[789]\d{7}$/.test(local)) {
    return null;
  }
  return `+962${local}`;
}

/** "+962791234567" → "962791234567" (format used by wa.me links). */
export function whatsappDigits(phone: string): string {
  return phone.replace(/[^\d]/g, '');
}
