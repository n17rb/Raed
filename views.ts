import { queryOne, type Queryable } from '../db/pool';
import type { AppKind } from '../auth/tokens';
import { formatJod } from '../pricing/pricing';
import { whatsappDigits } from '../lib/phone';
import { CONTACT_STATUSES, STATUS_LABELS_AR, customerPhase, type TripStatus } from './state-machine';

export interface Viewer {
  app: AppKind;
  userId: string;
}

interface TripViewRow {
  id: string;
  code: string;
  status: TripStatus;
  customer_id: string;
  captain_id: string | null;
  category_id: string;
  category_code: string;
  category_name: string;
  category_image: string | null;
  pickup_lat: number;
  pickup_lng: number;
  pickup_address: string;
  dropoff_lat: number;
  dropoff_lng: number;
  dropoff_address: string;
  route_polyline: string | null;
  estimated_distance_m: number | null;
  estimated_duration_s: number | null;
  estimated_fare_fils: number | null;
  final_fare_fils: number | null;
  actual_distance_m: number | null;
  actual_duration_s: number | null;
  currency: string;
  payment_method: string;
  requested_at: Date;
  accepted_at: Date | null;
  arrived_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  cancelled_by_role: string | null;
  cancel_reason: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  customer_avatar: string | null;
  customer_rating: string;
  captain_name: string | null;
  captain_phone: string | null;
  captain_avatar: string | null;
  captain_rating: string | null;
  captain_trips: number | null;
  captain_lat: number | null;
  captain_lng: number | null;
  captain_heading: number | null;
  vehicle_year: number | null;
  plate_number: string | null;
  color_name_ar: string | null;
  color_hex: string | null;
  model_en: string | null;
  model_ar: string | null;
  make_en: string | null;
  make_ar: string | null;
  make_logo: string | null;
  vehicle_image: string | null;
  vehicle_image_variants: Record<string, { url: string | null }> | null;
  vehicle_category_code: string | null;
  subtotal_fils: number | null;
  discount_fils: number | null;
  waiting_fee_fils: number | null;
  cancellation_fee_fils: number | null;
  customer_rating_given: number | null;
  captain_rating_given: number | null;
}

const TRIP_VIEW_SQL = `
  SELECT t.id, t.code, t.status, t.customer_id, t.captain_id, t.category_id,
         vc.code AS category_code, vc.name_ar AS category_name, vcm.public_url AS category_image,
         ST_Y(t.pickup_location::geometry) AS pickup_lat, ST_X(t.pickup_location::geometry) AS pickup_lng, t.pickup_address,
         ST_Y(t.dropoff_location::geometry) AS dropoff_lat, ST_X(t.dropoff_location::geometry) AS dropoff_lng, t.dropoff_address,
         t.route_polyline, t.estimated_distance_m, t.estimated_duration_s, t.estimated_fare_fils, t.final_fare_fils,
         t.actual_distance_m, t.actual_duration_s, t.currency, t.payment_method,
         t.requested_at, t.accepted_at, t.arrived_at, t.started_at, t.completed_at, t.cancelled_at,
         t.cancelled_by_role, t.cancel_reason,
         cu.full_name AS customer_name, cu.phone AS customer_phone, cum.public_url AS customer_avatar, cs.rating_avg AS customer_rating,
         cap.full_name AS captain_name, cap.phone AS captain_phone, capm.public_url AS captain_avatar,
         cp.rating_avg AS captain_rating, cp.completed_trips AS captain_trips,
         ST_Y(cp.current_location::geometry) AS captain_lat, ST_X(cp.current_location::geometry) AS captain_lng,
         cp.current_heading AS captain_heading,
         v.year AS vehicle_year, v.plate_number, v.color_name_ar, v.color_hex,
         vm.name_en AS model_en, vm.name_ar AS model_ar, mk.name_en AS make_en, mk.name_ar AS make_ar,
         mklogo.public_url AS make_logo, vimg.public_url AS vehicle_image, vimg.variants AS vehicle_image_variants,
         vvc.code AS vehicle_category_code,
         tf.subtotal_fils, tf.discount_fils, tf.waiting_fee_fils, tf.cancellation_fee_fils,
         (SELECT r.stars FROM ratings r WHERE r.trip_id = t.id AND r.direction = 'CUSTOMER_TO_CAPTAIN') AS customer_rating_given,
         (SELECT r.stars FROM ratings r WHERE r.trip_id = t.id AND r.direction = 'CAPTAIN_TO_CUSTOMER') AS captain_rating_given
  FROM trips t
  JOIN vehicle_categories vc ON vc.id = t.category_id
  LEFT JOIN media_files vcm ON vcm.id = vc.image_media_id
  JOIN users cu ON cu.id = t.customer_id
  LEFT JOIN media_files cum ON cum.id = cu.avatar_media_id
  JOIN customers cs ON cs.user_id = t.customer_id
  LEFT JOIN users cap ON cap.id = t.captain_id
  LEFT JOIN captains cp ON cp.user_id = t.captain_id
  LEFT JOIN media_files capm ON capm.id = cap.avatar_media_id
  LEFT JOIN vehicles v ON v.id = t.vehicle_id
  LEFT JOIN vehicle_categories vvc ON vvc.id = v.category_id
  LEFT JOIN vehicle_models vm ON vm.id = v.model_id
  LEFT JOIN vehicle_makes mk ON mk.id = v.make_id
  LEFT JOIN media_files mklogo ON mklogo.id = mk.logo_media_id
  LEFT JOIN media_files vimg ON vimg.id = v.image_media_id
  LEFT JOIN trip_fares tf ON tf.trip_id = t.id
  WHERE t.id = $1
`;

export interface ViewOptions {
  whatsappAllowed?: boolean;
}

export async function getTripView(db: Queryable, tripId: string, viewer: Viewer, options: ViewOptions = {}) {
  const row = await queryOne<TripViewRow>(db, TRIP_VIEW_SQL, [tripId]);
  if (!row) return null;

  const isAdmin = viewer.app === 'ADMIN';
  const isCustomer = viewer.app === 'CUSTOMER' && row.customer_id === viewer.userId;
  const isCaptain = viewer.app === 'CAPTAIN' && row.captain_id === viewer.userId;
  if (!isAdmin && !isCustomer && !isCaptain) return null;

  const contactOpen = CONTACT_STATUSES.includes(row.status);
  const captainVisible = row.captain_id !== null && (isAdmin || isCaptain || contactOpen || row.status === 'TRIP_COMPLETED');
  const fareFils = row.final_fare_fils ?? row.estimated_fare_fils;
  const whatsappAllowed = options.whatsappAllowed ?? true;

  return {
    id: row.id,
    code: row.code,
    status: row.status,
    statusLabel: STATUS_LABELS_AR[row.status],
    phase: customerPhase(row.status),
    category: { id: row.category_id, code: row.category_code, name: row.category_name, imageUrl: row.category_image },
    pickup: { lat: row.pickup_lat, lng: row.pickup_lng, address: row.pickup_address },
    dropoff: { lat: row.dropoff_lat, lng: row.dropoff_lng, address: row.dropoff_address },
    route: {
      polyline: row.route_polyline,
      distanceM: row.estimated_distance_m,
      durationS: row.estimated_duration_s,
      actualDistanceM: row.actual_distance_m,
      actualDurationS: row.actual_duration_s,
    },
    fare: {
      amountFils: fareFils,
      display: fareFils === null ? null : formatJod(fareFils),
      isFinal: row.final_fare_fils !== null,
      subtotalFils: row.subtotal_fils,
      discountFils: row.discount_fils ?? 0,
      waitingFeeFils: row.waiting_fee_fils ?? 0,
      cancellationFeeFils: row.cancellation_fee_fils ?? 0,
      currency: row.currency,
      paymentMethod: row.payment_method,
    },
    timeline: {
      requestedAt: row.requested_at,
      acceptedAt: row.accepted_at,
      arrivedAt: row.arrived_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      cancelledAt: row.cancelled_at,
    },
    cancellation: row.cancelled_at ? { by: row.cancelled_by_role, reason: row.cancel_reason } : null,
    captain:
      captainVisible && (isCustomer || isAdmin) && row.captain_id
        ? {
            id: row.captain_id,
            name: row.captain_name,
            avatarUrl: row.captain_avatar,
            rating: row.captain_rating === null ? null : Number(row.captain_rating),
            completedTrips: row.captain_trips,
            phone: contactOpen || isAdmin ? row.captain_phone : null,
            whatsapp: (contactOpen && whatsappAllowed) || isAdmin ? (row.captain_phone ? whatsappDigits(row.captain_phone) : null) : null,
            location:
              (contactOpen || isAdmin) && row.captain_lat !== null && row.captain_lng !== null
                ? { lat: row.captain_lat, lng: row.captain_lng, heading: row.captain_heading }
                : null,
          }
        : null,
    vehicle:
      captainVisible && row.plate_number
        ? {
            make: { en: row.make_en, ar: row.make_ar, logoUrl: row.make_logo },
            model: { en: row.model_en, ar: row.model_ar },
            year: row.vehicle_year,
            plateNumber: row.plate_number,
            color: { name: row.color_name_ar, hex: row.color_hex },
            imageUrl: row.vehicle_image,
            imageUrlMedium: row.vehicle_image_variants?.medium?.url ?? row.vehicle_image,
            categoryCode: row.vehicle_category_code,
          }
        : null,
    customer:
      isCaptain || isAdmin
        ? {
            id: row.customer_id,
            name: row.customer_name,
            avatarUrl: row.customer_avatar,
            rating: Number(row.customer_rating),
            phone: contactOpen || isAdmin ? row.customer_phone : null,
            whatsapp: (contactOpen && whatsappAllowed) || isAdmin ? (row.customer_phone ? whatsappDigits(row.customer_phone) : null) : null,
          }
        : null,
    myRating: isCustomer ? row.customer_rating_given : isCaptain ? row.captain_rating_given : null,
  };
}

export type TripView = NonNullable<Awaited<ReturnType<typeof getTripView>>>;
