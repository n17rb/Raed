import { z } from 'zod';

export interface CategoryPricing {
  baseFareFils: number;
  perKmFils: number;
  perMinuteFils: number;
  minimumFareFils: number;
  priceMultiplier: number;
  waitingFeePerMinuteFils: number;
  freeWaitingMinutes: number;
}

export interface FareInput {
  distanceM: number;
  durationS: number;
  waitingS?: number;
  surgeMultiplier?: number;
  roundingStepFils: number;
  commissionRate: number;
  discountFils?: number;
}

export interface FareBreakdown {
  baseFareFils: number;
  distanceFareFils: number;
  timeFareFils: number;
  waitingFeeFils: number;
  surgeMultiplier: number;
  subtotalFils: number;
  discountFils: number;
  totalFils: number;
  commissionFils: number;
  captainEarningFils: number;
}

export function roundToStep(value: number, step: number): number {
  if (step <= 1) return Math.round(value);
  return Math.round(value / step) * step;
}

/** The single source of truth for trip prices. Runs on the server only. */
export function computeFare(pricing: CategoryPricing, input: FareInput): FareBreakdown {
  const surgeMultiplier = Math.max(1, input.surgeMultiplier ?? 1);
  const baseFareFils = pricing.baseFareFils;
  const distanceFareFils = Math.round((Math.max(0, input.distanceM) / 1000) * pricing.perKmFils);
  const timeFareFils = Math.round((Math.max(0, input.durationS) / 60) * pricing.perMinuteFils);
  const waitingMinutes = Math.max(0, Math.ceil(Math.max(0, input.waitingS ?? 0) / 60) - pricing.freeWaitingMinutes);
  const waitingFeeFils = waitingMinutes * pricing.waitingFeePerMinuteFils;

  const raw = (baseFareFils + distanceFareFils + timeFareFils) * pricing.priceMultiplier * surgeMultiplier + waitingFeeFils;
  const subtotalFils = Math.max(pricing.minimumFareFils, roundToStep(raw, input.roundingStepFils));
  const discountFils = Math.min(Math.max(0, Math.round(input.discountFils ?? 0)), subtotalFils);
  const totalFils = subtotalFils - discountFils;
  const commissionFils = Math.round(subtotalFils * input.commissionRate);

  return {
    baseFareFils,
    distanceFareFils,
    timeFareFils,
    waitingFeeFils,
    surgeMultiplier,
    subtotalFils,
    discountFils,
    totalFils,
    commissionFils,
    captainEarningFils: subtotalFils - commissionFils,
  };
}

export function computeDiscount(
  type: 'PERCENT' | 'FIXED',
  value: number,
  maxDiscountFils: number | null,
  subtotalFils: number
): number {
  const raw = type === 'PERCENT' ? Math.floor((subtotalFils * value) / 100) : value;
  const capped = maxDiscountFils === null ? raw : Math.min(raw, maxDiscountFils);
  return Math.max(0, Math.min(capped, subtotalFils));
}

/** 4200 → "4.20" (Jordanian dinar, 1 JOD = 1000 fils). */
export function formatJod(fils: number): string {
  return (fils / 1000).toFixed(2);
}

export const pricingSnapshotSchema = z.object({
  category: z.object({
    id: z.string().uuid(),
    code: z.string(),
    baseFareFils: z.number().int(),
    perKmFils: z.number().int(),
    perMinuteFils: z.number().int(),
    minimumFareFils: z.number().int(),
    priceMultiplier: z.number(),
    waitingFeePerMinuteFils: z.number().int(),
    freeWaitingMinutes: z.number().int(),
    cancellationFeeFils: z.number().int(),
  }),
  surgeMultiplier: z.number(),
  roundingStepFils: z.number().int(),
  commissionRate: z.number(),
  currency: z.string(),
  approximateRoute: z.boolean(),
});

export type PricingSnapshot = z.infer<typeof pricingSnapshotSchema>;
