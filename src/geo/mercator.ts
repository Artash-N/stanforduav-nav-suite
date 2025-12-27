// Simple Web Mercator (EPSG:3857) conversion.
// Distances are approximately meters and are accurate enough at Stanford campus scale.

export interface XYMeters {
  x: number;
  y: number;
}

const R = 6378137;

export function lonLatToMercator(lng: number, lat: number): XYMeters {
  const x = (lng * Math.PI / 180) * R;
  const y = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * R;
  return { x, y };
}

export function mercatorToLonLat(x: number, y: number): { lng: number; lat: number } {
  const lng = (x / R) * 180 / Math.PI;
  const lat = (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI;
  return { lng, lat };
}
