import type { Feature, Polygon, MultiPolygon } from 'geojson';
import type { Rings } from '../geo/polygon';
import { featureToMercatorPolygons, mercatorBbox, pointInAnyPolygon } from '../geo/polygon';
import { lonLatToMercator } from '../geo/mercator';
import type { CostZoneType, LatLngBounds, Zone } from '../types';
import { GridEnvironment, type GridBoundsMeters } from './GridEnvironment';

export interface RasterizeResult {
  env: GridEnvironment;
  cellCount: number;
}

export function latLngBoundsToMercatorBounds(b: LatLngBounds): GridBoundsMeters {
  const sw = lonLatToMercator(b.west, b.south);
  const ne = lonLatToMercator(b.east, b.north);
  return {
    minX: Math.min(sw.x, ne.x),
    minY: Math.min(sw.y, ne.y),
    maxX: Math.max(sw.x, ne.x),
    maxY: Math.max(sw.y, ne.y)
  };
}

function featureToPolys(f: Feature<Polygon | MultiPolygon>) {
  const polys = featureToMercatorPolygons(f);
  const bbox = mercatorBbox(polys);
  return { polys, bbox };
}

export function rasterizeZonesToGrid(params: {
  cellSizeM: number;
  bounds: GridBoundsMeters;
  zones: Zone[];
  costZoneTypes: CostZoneType[];
  avoidHighMultiplier: boolean;
  rolloffDistanceM: number;
}): RasterizeResult {
  const { cellSizeM, bounds, zones, costZoneTypes, avoidHighMultiplier, rolloffDistanceM } = params;
  const costTypeById = new Map(costZoneTypes.map((type) => [type.id, type]));

  const width = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / cellSizeM));
  const height = Math.max(1, Math.ceil((bounds.maxY - bounds.minY) / cellSizeM));
  const cellCount = width * height;

  const blocked = new Uint8Array(cellCount);
  const costMultiplier = new Float32Array(cellCount);
  costMultiplier.fill(1);
  const costZoneMask = new Uint8Array(cellCount);

  // Precompute mercator polygons + bboxes per zone to speed up rasterization.
  const compiled = zones.map((z) => {
    if (z.type === 'NO_FLY') {
      return { zone: z, ...featureToPolys(z.buffered) };
    }
    return { zone: z, ...featureToPolys(z.shape) };
  });

  for (const entry of compiled) {
    const z = entry.zone;
    const { bbox, polys } = entry;

    const minCol = clampInt(Math.floor((bbox.minX - bounds.minX) / cellSizeM), 0, width - 1);
    const maxCol = clampInt(Math.floor((bbox.maxX - bounds.minX) / cellSizeM), 0, width - 1);
    const minRow = clampInt(Math.floor((bbox.minY - bounds.minY) / cellSizeM), 0, height - 1);
    const maxRow = clampInt(Math.floor((bbox.maxY - bounds.minY) / cellSizeM), 0, height - 1);

    for (let row = minRow; row <= maxRow; row++) {
      const yM = bounds.minY + (row + 0.5) * cellSizeM;
      const base = row * width;
      for (let col = minCol; col <= maxCol; col++) {
        const id = base + col;
        if (blocked[id] === 1) continue; // no-fly already overrides everything
        const xM = bounds.minX + (col + 0.5) * cellSizeM;
        if (!pointInAnyPolygon(xM, yM, polys)) continue;

        if (z.type === 'NO_FLY') {
          blocked[id] = 1;
        } else {
          const type = costTypeById.get(z.costTypeId);
          const multiplier = type?.multiplier ?? 1;
          costMultiplier[id] *= multiplier;
          costZoneMask[id] = 1;
        }
      }
    }
  }

  if (avoidHighMultiplier && rolloffDistanceM > 0) {
    const highCostZones = compiled
      .filter((entry) => entry.zone.type === 'COST')
      .map((entry) => {
        const zone = entry.zone as Extract<Zone, { type: 'COST' }>;
        const multiplier = costTypeById.get(zone.costTypeId)?.multiplier ?? 1;
        return { ...entry, multiplier };
      })
      .filter((entry) => entry.multiplier > 1);

    const rolloffSum = new Float32Array(cellCount);
    const rolloffCount = new Uint16Array(cellCount);

    for (const entry of highCostZones) {
      const { bbox, polys, multiplier } = entry;
      const minCol = clampInt(
        Math.floor((bbox.minX - rolloffDistanceM - bounds.minX) / cellSizeM),
        0,
        width - 1
      );
      const maxCol = clampInt(
        Math.floor((bbox.maxX + rolloffDistanceM - bounds.minX) / cellSizeM),
        0,
        width - 1
      );
      const minRow = clampInt(
        Math.floor((bbox.minY - rolloffDistanceM - bounds.minY) / cellSizeM),
        0,
        height - 1
      );
      const maxRow = clampInt(
        Math.floor((bbox.maxY + rolloffDistanceM - bounds.minY) / cellSizeM),
        0,
        height - 1
      );

      for (let row = minRow; row <= maxRow; row++) {
        const yM = bounds.minY + (row + 0.5) * cellSizeM;
        const base = row * width;
        for (let col = minCol; col <= maxCol; col++) {
          const id = base + col;
          if (blocked[id] === 1 || costZoneMask[id] === 1) continue;
          const xM = bounds.minX + (col + 0.5) * cellSizeM;
          if (pointInAnyPolygon(xM, yM, polys)) continue;
          const distance = minDistanceToRings(xM, yM, polys);
          if (!Number.isFinite(distance) || distance > rolloffDistanceM) continue;
          const normalized = clamp01(distance / rolloffDistanceM);
          const falloff = 1 - normalized;
          const factor = 1 + (multiplier - 1) * falloff;
          if (factor > 1) {
            rolloffSum[id] += factor;
            rolloffCount[id] += 1;
          }
        }
      }
    }

    for (let id = 0; id < cellCount; id += 1) {
      const count = rolloffCount[id];
      if (count === 0 || blocked[id] === 1) continue;
      const avgFactor = rolloffSum[id] / count;
      if (avgFactor > 1) {
        costMultiplier[id] *= avgFactor;
      }
    }
  }

  const env = new GridEnvironment({
    cellSizeM,
    bounds,
    width,
    height,
    blocked,
    costMultiplier
  });

  return { env, cellCount };
}

function clampInt(v: number, min: number, max: number): number {
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function minDistanceToRings(x: number, y: number, polys: Rings[]): number {
  let min = Infinity;
  for (const rings of polys) {
    for (const ring of rings) {
      const ringDistance = minDistanceToRing(x, y, ring);
      if (ringDistance < min) min = ringDistance;
    }
  }
  return min;
}

function minDistanceToRing(x: number, y: number, ring: Array<[number, number]>): number {
  if (ring.length < 2) return Infinity;
  let min = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[(i + 1) % ring.length];
    const d = pointToSegmentDistance(x, y, ax, ay, bx, by);
    if (d < min) min = d;
  }
  return min;
}

function pointToSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const denom = abx * abx + aby * aby;
  if (denom <= 0) {
    return Math.hypot(apx, apy);
  }
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / denom));
  const cx = ax + t * abx;
  const cy = ay + t * aby;
  return Math.hypot(px - cx, py - cy);
}
