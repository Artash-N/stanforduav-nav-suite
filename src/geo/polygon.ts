import type { Feature, Polygon, MultiPolygon, Position } from 'geojson';
import { lonLatToMercator } from './mercator';

export type Ring = Array<[number, number]>; // [x,y] in meters
export type Rings = Ring[]; // [outer, holes...]

export function featureToMercatorPolygons(feature: Feature<Polygon | MultiPolygon>): Rings[] {
  const geom = feature.geometry;
  if (geom.type === 'Polygon') {
    return [polygonToMercatorRings(geom.coordinates)];
  }
  // MultiPolygon: list of polygons
  return geom.coordinates.map((poly) => polygonToMercatorRings(poly));
}

function polygonToMercatorRings(rings: Position[][]): Rings {
  return rings.map((ring) => ring.map(([lng, lat]) => {
    const { x, y } = lonLatToMercator(lng, lat);
    return [x, y] as [number, number];
  }));
}

export function mercatorBbox(polys: Rings[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const rings of polys) {
    for (const ring of rings) {
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, minY, maxX, maxY };
}

// Ray casting point-in-ring test.
function pointInRing(x: number, y: number, ring: Ring): boolean {
  // Assumes ring is closed (first==last) but works either way.
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];

    const intersect = ((yi > y) !== (yj > y))
      && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// Supports holes: inside outer AND not inside any hole.
export function pointInRings(x: number, y: number, rings: Rings): boolean {
  if (rings.length === 0) return false;
  if (!pointInRing(x, y, rings[0])) return false;
  for (let h = 1; h < rings.length; h++) {
    if (pointInRing(x, y, rings[h])) return false;
  }
  return true;
}

export function pointInAnyPolygon(x: number, y: number, polys: Rings[]): boolean {
  for (const rings of polys) {
    if (pointInRings(x, y, rings)) return true;
  }
  return false;
}
