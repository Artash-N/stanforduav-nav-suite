import type { Feature, Polygon, MultiPolygon } from 'geojson';
import { featureToMercatorPolygons, mercatorBbox, pointInAnyPolygon } from '../geo/polygon';
import { lonLatToMercator } from '../geo/mercator';
import type { LatLngBounds, Zone } from '../types';
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
}): RasterizeResult {
  const { cellSizeM, bounds, zones } = params;

  const width = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / cellSizeM));
  const height = Math.max(1, Math.ceil((bounds.maxY - bounds.minY) / cellSizeM));
  const cellCount = width * height;

  const blocked = new Uint8Array(cellCount);
  const costMultiplier = new Float32Array(cellCount);
  costMultiplier.fill(1);

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
          costMultiplier[id] *= z.multiplier;
        }
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
