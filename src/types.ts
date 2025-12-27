import type { Feature, Polygon, MultiPolygon } from 'geojson';

export type ZoneType = 'NO_FLY' | 'COST';

export interface CostZoneType {
  id: string;
  name: string;
  // Multiplier applied when flying through this zone type.
  // >1 discouraged, <1 encouraged.
  multiplier: number;
  color: string;
}

export interface ZoneBase {
  id: string;
  name: string;
  type: ZoneType;
}

export interface NoFlyZone extends ZoneBase {
  type: 'NO_FLY';
  // Original user-drawn polygon (WGS84)
  shape: Feature<Polygon | MultiPolygon>;
  // Buffered version (10m) used for rasterization and display.
  buffered: Feature<Polygon | MultiPolygon>;
}

export interface CostZone extends ZoneBase {
  type: 'COST';
  costTypeId: string;
  shape: Feature<Polygon | MultiPolygon>;
}

export type Zone = NoFlyZone | CostZone;

export interface LatLng {
  lat: number;
  lng: number;
}

export interface LatLngBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface PathRunMetrics {
  algorithmId: string;
  algorithmName: string;
  runtimeMs: number;
  expanded: number;
  pathLengthM: number;
  cost: number;
}
