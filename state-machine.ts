export const TRIP_STATUSES = [
  'REQUESTED',
  'SEARCHING',
  'DRIVER_ASSIGNED',
  'DRIVER_ACCEPTED',
  'DRIVER_ARRIVING',
  'DRIVER_ARRIVED',
  'TRIP_STARTED',
  'TRIP_COMPLETED',
  'CANCELLED',
] as const;

export type TripStatus = (typeof TRIP_STATUSES)[number];

/** Mirror of trip_transition_allowed() in the database (0003_trips.sql). */
export const TRIP_TRANSITIONS: Record<TripStatus, readonly TripStatus[]> = {
  REQUESTED: ['SEARCHING', 'CANCELLED'],
  SEARCHING: ['DRIVER_ASSIGNED', 'CANCELLED'],
  DRIVER_ASSIGNED: ['DRIVER_ACCEPTED', 'SEARCHING', 'CANCELLED'],
  DRIVER_ACCEPTED: ['DRIVER_ARRIVING', 'CANCELLED'],
  DRIVER_ARRIVING: ['DRIVER_ARRIVED', 'CANCELLED'],
  DRIVER_ARRIVED: ['TRIP_STARTED', 'CANCELLED'],
  TRIP_STARTED: ['TRIP_COMPLETED', 'CANCELLED'],
  TRIP_COMPLETED: [],
  CANCELLED: [],
};

export function canTransition(from: TripStatus, to: TripStatus): boolean {
  return TRIP_TRANSITIONS[from].includes(to);
}

export function isTerminal(status: TripStatus): boolean {
  return TRIP_TRANSITIONS[status].length === 0;
}

/** Statuses in which customer and captain can call / message each other. */
export const CONTACT_STATUSES: readonly TripStatus[] = ['DRIVER_ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'TRIP_STARTED'];

export const CAPTAIN_ACTIVE_STATUSES: readonly TripStatus[] = CONTACT_STATUSES;

export const ACTIVE_STATUSES: readonly TripStatus[] = [
  'REQUESTED',
  'SEARCHING',
  'DRIVER_ASSIGNED',
  'DRIVER_ACCEPTED',
  'DRIVER_ARRIVING',
  'DRIVER_ARRIVED',
  'TRIP_STARTED',
];

export const CUSTOMER_CANCELLABLE: readonly TripStatus[] = [
  'REQUESTED',
  'SEARCHING',
  'DRIVER_ASSIGNED',
  'DRIVER_ACCEPTED',
  'DRIVER_ARRIVING',
  'DRIVER_ARRIVED',
];

export type CustomerPhase = 'SEARCHING' | 'ON_THE_WAY' | 'ARRIVED' | 'IN_TRIP' | 'COMPLETED' | 'CANCELLED';

/** What the customer screen shows (the captain offer stage still looks like searching). */
export function customerPhase(status: TripStatus): CustomerPhase {
  switch (status) {
    case 'REQUESTED':
    case 'SEARCHING':
    case 'DRIVER_ASSIGNED':
      return 'SEARCHING';
    case 'DRIVER_ACCEPTED':
    case 'DRIVER_ARRIVING':
      return 'ON_THE_WAY';
    case 'DRIVER_ARRIVED':
      return 'ARRIVED';
    case 'TRIP_STARTED':
      return 'IN_TRIP';
    case 'TRIP_COMPLETED':
      return 'COMPLETED';
    default:
      return 'CANCELLED';
  }
}

export const STATUS_LABELS_AR: Record<TripStatus, string> = {
  REQUESTED: 'تم الطلب',
  SEARCHING: 'جاري البحث عن كابتن',
  DRIVER_ASSIGNED: 'بانتظار رد الكابتن',
  DRIVER_ACCEPTED: 'قبل الكابتن الرحلة',
  DRIVER_ARRIVING: 'في الطريق إليك',
  DRIVER_ARRIVED: 'الكابتن وصل',
  TRIP_STARTED: 'الرحلة بدأت',
  TRIP_COMPLETED: 'وصلت إلى وجهتك',
  CANCELLED: 'تم إلغاء الرحلة',
};
