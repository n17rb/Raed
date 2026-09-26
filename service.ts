import { env } from '../config/env';
import { pool, query, queryOne } from '../db/pool';
import { randomToken, sha256Hex } from '../lib/crypto';
import { AppError, Errors } from '../lib/errors';
import { getSetting } from '../settings/service';
import { STATUS_LABELS_AR, type TripStatus } from '../trips/state-machine';

const MAX_ACTIVE_LINK_HOURS = 12;

export async function createShareLink(customerId: string, tripId: string) {
  const trip = await queryOne<{ customer_id: string; status: TripStatus }>(pool, 'SELECT customer_id, status FROM trips WHERE id = $1', [tripId]);
  if (!trip || trip.customer_id !== customerId) throw Errors.notFound('الرحلة غير موجودة');
  if (trip.status === 'TRIP_COMPLETED' || trip.status === 'CANCELLED') {
    throw new AppError(409, 'TRIP_ENDED', 'انتهت الرحلة، لا يمكن مشاركتها');
  }
  const token = randomToken(24);
  await query(
    pool,
    `INSERT INTO trip_share_links (trip_id, token_hash, created_by, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
    [tripId, sha256Hex(token), customerId, MAX_ACTIVE_LINK_HOURS]
  );
  const url = `${env.API_PUBLIC_URL.replace(/\/+$/, '')}/share/${token}`;
  return { url, message: `تابع رحلتي مع رايد لحظة بلحظة: ${url}` };
}

export async function revokeShareLinks(customerId: string, tripId: string) {
  await query(
    pool,
    `UPDATE trip_share_links SET revoked_at = now()
     WHERE trip_id = $1 AND created_by = $2 AND revoked_at IS NULL`,
    [tripId, customerId]
  );
  return { ok: true };
}

/** What a person with the link may see: no phone numbers, no names beyond the captain's first name. */
export async function getSharedTrip(token: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw Errors.notFound('الرابط غير صالح');
  const ttl = await getSetting('share_links');
  const row = await queryOne<{
    link_id: string;
    expires_at: Date;
    revoked_at: Date | null;
    status: TripStatus;
    completed_at: Date | null;
    cancelled_at: Date | null;
    dropoff_address: string;
    dropoff_lat: number;
    dropoff_lng: number;
    pickup_lat: number;
    pickup_lng: number;
    captain_name: string | null;
    captain_lat: number | null;
    captain_lng: number | null;
    location_updated_at: Date | null;
    make_ar: string | null;
    make_en: string | null;
    model_ar: string | null;
    model_en: string | null;
    color_name_ar: string | null;
    plate_number: string | null;
    vehicle_image: string | null;
  }>(
    pool,
    `SELECT l.id AS link_id, l.expires_at, l.revoked_at, t.status, t.completed_at, t.cancelled_at,
            t.dropoff_address, ST_Y(t.dropoff_location::geometry) AS dropoff_lat, ST_X(t.dropoff_location::geometry) AS dropoff_lng,
            ST_Y(t.pickup_location::geometry) AS pickup_lat, ST_X(t.pickup_location::geometry) AS pickup_lng,
            cap.full_name AS captain_name,
            ST_Y(cp.current_location::geometry) AS captain_lat, ST_X(cp.current_location::geometry) AS captain_lng,
            cp.location_updated_at,
            mk.name_ar AS make_ar, mk.name_en AS make_en, vm.name_ar AS model_ar, vm.name_en AS model_en,
            v.color_name_ar, v.plate_number, m.public_url AS vehicle_image
     FROM trip_share_links l
     JOIN trips t ON t.id = l.trip_id
     LEFT JOIN users cap ON cap.id = t.captain_id
     LEFT JOIN captains cp ON cp.user_id = t.captain_id
     LEFT JOIN vehicles v ON v.id = t.vehicle_id
     LEFT JOIN vehicle_makes mk ON mk.id = v.make_id
     LEFT JOIN vehicle_models vm ON vm.id = v.model_id
     LEFT JOIN media_files m ON m.id = v.image_media_id
     WHERE l.token_hash = $1`,
    [sha256Hex(token)]
  );
  if (!row || row.revoked_at || row.expires_at.getTime() < Date.now()) throw Errors.notFound('انتهت صلاحية الرابط');
  const endedAt = row.completed_at ?? row.cancelled_at;
  if (endedAt && endedAt.getTime() + ttl.ttlAfterTripEndMinutes * 60_000 < Date.now()) {
    throw Errors.notFound('انتهت صلاحية الرابط');
  }
  await query(pool, 'UPDATE trip_share_links SET view_count = view_count + 1 WHERE id = $1', [row.link_id]);

  const active = !endedAt;
  const showCaptain = ['DRIVER_ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'TRIP_STARTED'].includes(row.status);
  return {
    status: row.status,
    statusLabel: STATUS_LABELS_AR[row.status],
    active,
    dropoff: { address: row.dropoff_address, lat: row.dropoff_lat, lng: row.dropoff_lng },
    pickup: { lat: row.pickup_lat, lng: row.pickup_lng },
    captain: showCaptain ? { firstName: (row.captain_name ?? '').split(' ')[0] || null } : null,
    vehicle:
      showCaptain && row.plate_number
        ? {
            make: row.make_ar ?? row.make_en,
            model: row.model_ar ?? row.model_en,
            color: row.color_name_ar,
            plateNumber: row.plate_number,
            imageUrl: row.vehicle_image,
          }
        : null,
    location:
      showCaptain && active && row.captain_lat !== null && row.captain_lng !== null
        ? { lat: row.captain_lat, lng: row.captain_lng, updatedAt: row.location_updated_at }
        : null,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}

/** Small public page that refreshes every few seconds. */
export function sharePageHtml(token: string): string {
  const mapsKey = env.GOOGLE_MAPS_WEB_KEY ? escapeHtml(env.GOOGLE_MAPS_WEB_KEY) : '';
  const safeToken = escapeHtml(token);
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex" />
<title>رايد · متابعة رحلة</title>
<style>
  :root { --primary:#2F7CF6; --navy:#13205A; --muted:#8A94A6; --bg:#F6F8FC; --card:#FFFFFF; --border:#EEF1F6; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: -apple-system, BlinkMacSystemFont, 'SF Arabic', 'Noto Sans Arabic', 'Segoe UI', Tahoma, sans-serif; background:var(--bg); color:var(--navy); }
  #map { height: 55vh; width: 100%; background:#E9EDF3; }
  .sheet { background:var(--card); border-radius:28px 28px 0 0; margin-top:-24px; position:relative; padding:20px 20px 32px; min-height:45vh; box-shadow:0 -6px 24px rgba(20,40,90,.08); }
  .handle { width:36px; height:4px; border-radius:4px; background:#D9DEE7; margin:0 auto 16px; }
  .pill { display:inline-flex; align-items:center; gap:8px; background:#E8F0FE; color:var(--primary); padding:6px 14px; border-radius:999px; font-size:13px; font-weight:600; }
  .pill i { width:8px; height:8px; border-radius:50%; background:var(--primary); display:inline-block; }
  .card { background:#F4F7FC; border-radius:18px; padding:16px; margin-top:16px; display:flex; justify-content:space-between; align-items:center; gap:12px; }
  .model { font-size:22px; font-weight:700; margin:2px 0; }
  .muted { color:var(--muted); font-size:13px; }
  .plate { display:inline-block; border:1.5px solid var(--navy); border-radius:8px; padding:4px 10px; font-weight:600; margin-top:8px; background:#fff; direction:ltr; }
  .car { width:150px; max-width:45%; }
  .row { margin-top:16px; font-size:14px; }
  .brand { text-align:center; margin-top:24px; color:var(--muted); font-size:12px; }
  .error { padding:40px 20px; text-align:center; }
</style>
</head>
<body>
<div id="map"></div>
<div class="sheet">
  <div class="handle"></div>
  <div id="content"><p class="muted">جارٍ التحميل…</p></div>
  <div class="brand">رايد · رابط متابعة مؤقت</div>
</div>
<script>
  var token = "${safeToken}";
  var map = null, carMarker = null, dropMarker = null;
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function render(d){
    var html = '<span class="pill"><i></i>' + esc(d.statusLabel) + '</span>';
    if (d.vehicle) {
      html += '<div class="card"><div><div class="muted">' + esc(d.vehicle.make) + '</div><div class="model">' + esc(d.vehicle.model) + '</div>'
        + '<div class="muted">' + esc(d.vehicle.color) + '</div><div class="plate">' + esc(d.vehicle.plateNumber) + '</div></div>'
        + (d.vehicle.imageUrl ? '<img class="car" alt="" src="' + esc(d.vehicle.imageUrl) + '"/>' : '') + '</div>';
    }
    if (d.captain && d.captain.firstName) html += '<div class="row">الكابتن: <b>' + esc(d.captain.firstName) + '</b></div>';
    html += '<div class="row">الوجهة: <b>' + esc(d.dropoff.address) + '</b></div>';
    if (d.location) html += '<div class="row"><a href="https://www.google.com/maps?q=' + d.location.lat + ',' + d.location.lng + '" target="_blank" rel="noopener">افتح الموقع في خرائط Google</a></div>';
    document.getElementById('content').innerHTML = html;
    if (window.google && map) {
      var drop = { lat: d.dropoff.lat, lng: d.dropoff.lng };
      if (!dropMarker) dropMarker = new google.maps.Marker({ map: map, position: drop });
      if (d.location) {
        var pos = { lat: d.location.lat, lng: d.location.lng };
        if (!carMarker) carMarker = new google.maps.Marker({ map: map, position: pos, icon: { path: google.maps.SymbolPath.CIRCLE, scale: 9, fillColor: '#2F7CF6', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3 } });
        else carMarker.setPosition(pos);
        map.panTo(pos);
      } else { map.panTo(drop); }
    }
  }
  function load(){
    fetch('/share/' + token + '/data', { cache: 'no-store' }).then(function(r){ if(!r.ok) throw new Error(); return r.json(); })
      .then(function(d){ render(d); if (d.active) setTimeout(load, 5000); })
      .catch(function(){ document.getElementById('content').innerHTML = '<div class="error">انتهت صلاحية الرابط أو انتهت الرحلة</div>'; });
  }
  window.initMap = function(){ map = new google.maps.Map(document.getElementById('map'), { center: { lat: 31.95, lng: 35.91 }, zoom: 14, disableDefaultUI: true }); load(); };
  ${mapsKey ? '' : "document.getElementById('map').style.display='none'; load();"}
</script>
${mapsKey ? `<script async src="https://maps.googleapis.com/maps/api/js?key=${mapsKey}&language=ar&region=JO&callback=initMap"></script>` : ''}
</body>
</html>`;
}
