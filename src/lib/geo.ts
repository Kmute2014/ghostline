/**
 * Geospatial helpers.
 *
 * The sandbox database is SQLite, which has no PostGIS. Nearby discovery uses a
 * lat/lng bounding-box prefilter in SQL plus a precise haversine filter here —
 * functionally equivalent for radii ≤ 5 km. The production path (PostgreSQL +
 * PostGIS `ST_DWithin`) is documented in the README.
 */

export const EARTH_RADIUS_M = 6_371_000

export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)))
}

export type BoundingBox = {
  minLat: number
  maxLat: number
  minLng: number
  maxLng: number
}

export function boundingBox(lat: number, lng: number, radiusM: number): BoundingBox {
  const latDelta = (radiusM / EARTH_RADIUS_M) * (180 / Math.PI)
  const cos = Math.max(0.01, Math.cos((lat * Math.PI) / 180))
  const lngDelta = latDelta / cos
  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLng: lng - lngDelta,
    maxLng: lng + lngDelta,
  }
}

export const RADIUS_PRESETS = [5, 10, 25, 50, 100, 500, 1000, 5000] as const
export const MAX_RADIUS_M = 5000

/**
 * Round distances into coarse buckets so exact positions cannot be inferred
 * from the label: <100 m → 10 m steps, <1 km → 25 m steps, ≥1 km → 100 m steps.
 */
export function approximateDistance(rawMeters: number): { meters: number; label: string } {
  let step: number
  if (rawMeters < 100) step = 10
  else if (rawMeters < 1000) step = 25
  else step = 100
  const meters = Math.max(step, Math.round(rawMeters / step) * step)
  const label = meters < 1000 ? `${meters} m` : `${(meters / 1000).toFixed(1)} km`
  return { meters, label }
}
