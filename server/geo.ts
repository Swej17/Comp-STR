// Map helpers. Exact home locations never leave the server: travelers get a spot moved
// 150–450 m in a fixed direction per listing, so pins are stable and can't be averaged out.
import type { HostOffer } from "../src/types.ts";

export type LatLng = { lat: number; lng: number };
export type Bbox = { west: number; south: number; east: number; north: number };

/** Publicly shown radius around the approximate spot, in meters. */
export const APPROX_RADIUS_M = 500;

function hash(text: string): number {
  let h = 2166136261;
  for (const ch of text) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function approxLocation(o: HostOffer): LatLng | null {
  if (!o.location) return null;
  const h = hash(o.listingId);
  const angle = ((h % 3600) / 3600) * 2 * Math.PI;
  const meters = 150 + ((h >>> 12) % 300);
  const dLat = (meters * Math.cos(angle)) / 111_320;
  const dLng = (meters * Math.sin(angle)) / (111_320 * Math.cos((o.location.lat * Math.PI) / 180));
  const round = (n: number) => Math.round(n * 10_000) / 10_000; // ~11 m grid
  return { lat: round(o.location.lat + dLat), lng: round(o.location.lng + dLng) };
}

/** "west,south,east,north" in degrees → Bbox, or an error message. */
export function parseBbox(s: string): Bbox | string {
  const parts = s.split(",").map(Number);
  const [west, south, east, north] = parts;
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return "bbox must be west,south,east,north";
  if (!(south! >= -90 && north! <= 90 && south! < north! && west! >= -180 && east! <= 180 && west! < east!)) {
    return "bbox must be west,south,east,north with west < east and south < north";
  }
  return { west: west!, south: south!, east: east!, north: north! };
}

export const inBbox = (p: LatLng | null, b: Bbox): boolean =>
  p !== null && p.lat >= b.south && p.lat <= b.north && p.lng >= b.west && p.lng <= b.east;

/** Box around a set of points, padded slightly; null if there are none. */
export function boundsOf(points: LatLng[]): Bbox | null {
  if (!points.length) return null;
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const pad = 0.01;
  return {
    west: Math.min(...lngs) - pad, south: Math.min(...lats) - pad,
    east: Math.max(...lngs) + pad, north: Math.max(...lats) + pad,
  };
}
