import { useEffect } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import type { GridEnvironment } from '../env/GridEnvironment';
import { mercatorToLonLat } from '../geo/mercator';

class CanvasCellsLeafletLayer extends L.Layer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private map: L.Map | null = null;

  private env: GridEnvironment | null = null;
  private visited: number[] = [];
  private pathCells: number[] = [];
  private showVisited = true;

  constructor() {
    super();
    this.canvas = L.DomUtil.create('canvas', 'leaflet-canvas-cells') as HTMLCanvasElement;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get canvas context');
    this.ctx = ctx;

    this.canvas.style.position = 'absolute';
    this.canvas.style.top = '0';
    this.canvas.style.left = '0';
    this.canvas.style.pointerEvents = 'none';
  }

  onAdd(map: L.Map) {
    this.map = map;
    map.getPanes().overlayPane.appendChild(this.canvas);
    // Redraw only after interactions finish to avoid jitter / lag while panning.
    map.on('moveend zoomend resize', this.redraw, this);
    this.redraw();
  }

  onRemove(map: L.Map) {
    map.off('moveend zoomend resize', this.redraw, this);
    if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    this.map = null;
  }

  setData(params: {
    env: GridEnvironment | null;
    visited: number[];
    pathCells: number[];
    showVisited: boolean;
  }) {
    this.env = params.env;
    this.visited = params.visited;
    this.pathCells = params.pathCells;
    this.showVisited = params.showVisited;
    this.redraw();
  }

  redraw = () => {
    if (!this.map) return;

    const size = this.map.getSize();
    const ratio = window.devicePixelRatio || 1;

    // NOTE ABOUT COORDINATE SPACES
    // ----------------------------
    // This canvas is appended to Leaflet's overlayPane, which lives in the
    // *layer point* coordinate system (the same space Leaflet uses for
    // vector layers). If we draw using container points without compensating
    // for the overlayPane's translation, the points will appear offset and
    // will "jump" when zooming/panning.
    //
    // The robust pattern (same idea Leaflet's own Canvas renderer uses) is:
    //   1) Anchor the canvas at the current top-left layer point.
    //   2) Convert lat/lng -> layer point and subtract that top-left.
    const topLeft = this.map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(this.canvas, topLeft);
    this.canvas.width = Math.round(size.x * ratio);
    this.canvas.height = Math.round(size.y * ratio);
    this.canvas.style.width = `${size.x}px`;
    this.canvas.style.height = `${size.y}px`;

    // Reset transform so 1 unit in canvas corresponds to 1 CSS pixel.
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.ctx.clearRect(0, 0, size.x, size.y);

    if (!this.env) return;

    // Visited cells (sampled)
    if (this.showVisited && this.visited.length > 0) {
      const maxPts = 20000;
      const step = Math.max(1, Math.ceil(this.visited.length / maxPts));
      this.ctx.fillStyle = 'rgba(0, 90, 200, 0.15)';
      for (let i = 0; i < this.visited.length; i += step) {
        const id = this.visited[i];
        const { xM, yM } = this.env.cellCenter(id);
        const { lat, lng } = mercatorToLonLat(xM, yM);
        const pt = this.map.latLngToLayerPoint([lat, lng]).subtract(topLeft);
        // 2x2 px dot
        this.ctx.fillRect(pt.x - 1, pt.y - 1, 2, 2);
      }
    }

    // Path cells (drawn as slightly larger dots)
    if (this.pathCells.length > 0) {
      this.ctx.fillStyle = 'rgba(20, 20, 20, 0.85)';
      for (const id of this.pathCells) {
        const { xM, yM } = this.env.cellCenter(id);
        const { lat, lng } = mercatorToLonLat(xM, yM);
        const pt = this.map.latLngToLayerPoint([lat, lng]).subtract(topLeft);
        this.ctx.fillRect(pt.x - 2, pt.y - 2, 4, 4);
      }
    }
  };
}

class CanvasCostHeatmapLeafletLayer extends L.Layer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private map: L.Map | null = null;

  private env: GridEnvironment | null = null;
  private show = false;

  constructor() {
    super();
    this.canvas = L.DomUtil.create('canvas', 'leaflet-canvas-heatmap') as HTMLCanvasElement;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get canvas context');
    this.ctx = ctx;

    this.canvas.style.position = 'absolute';
    this.canvas.style.top = '0';
    this.canvas.style.left = '0';
    this.canvas.style.pointerEvents = 'none';
  }

  onAdd(map: L.Map) {
    this.map = map;
    map.getPanes().overlayPane.appendChild(this.canvas);
    map.on('moveend zoomend resize', this.redraw, this);
    this.redraw();
  }

  onRemove(map: L.Map) {
    map.off('moveend zoomend resize', this.redraw, this);
    if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    this.map = null;
  }

  setData(params: { env: GridEnvironment | null; show: boolean }) {
    this.env = params.env;
    this.show = params.show;
    this.redraw();
  }

  redraw = () => {
    if (!this.map) return;

    const size = this.map.getSize();
    const ratio = window.devicePixelRatio || 1;
    const topLeft = this.map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(this.canvas, topLeft);
    this.canvas.width = Math.round(size.x * ratio);
    this.canvas.height = Math.round(size.y * ratio);
    this.canvas.style.width = `${size.x}px`;
    this.canvas.style.height = `${size.y}px`;

    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.ctx.clearRect(0, 0, size.x, size.y);

    if (!this.env || !this.show) return;

    const totalCells = this.env.size();
    if (totalCells === 0) return;

    const maxSample = 50000;
    const percentile = 0.95;
    const sampleStride = Math.max(1, Math.ceil(totalCells / maxSample));
    const samples: number[] = [];
    for (let id = 0; id < totalCells; id += sampleStride) {
      if (this.env.isBlocked(id)) continue;
      const value = this.env.costMultiplier[id] ?? 1;
      if (value > 1) samples.push(value);
    }
    if (samples.length === 0) return;
    samples.sort((a, b) => a - b);
    const idx = Math.min(samples.length - 1, Math.floor(samples.length * percentile));
    const maxMultiplier = Math.max(1.1, samples[idx]);

    const maxDrawCells = 60000;
    const drawStride = Math.max(1, Math.ceil(totalCells / maxDrawCells));

    const cellRadiusPx = this.estimateCellRadiusPx(topLeft);
    this.ctx.save();
    this.ctx.globalCompositeOperation = 'lighter';

    for (let id = 0; id < totalCells; id += drawStride) {
      if (this.env.isBlocked(id)) continue;
      const value = this.env.costMultiplier[id] ?? 1;
      if (value <= 1) continue;
      const normalized = clamp01((value - 1) / (maxMultiplier - 1));
      if (normalized <= 0) continue;
      const { xM, yM } = this.env.cellCenter(id);
      const { lat, lng } = mercatorToLonLat(xM, yM);
      const pt = this.map.latLngToLayerPoint([lat, lng]).subtract(topLeft);

      const { r, g, b, a } = heatmapColor(normalized);
      const radius = cellRadiusPx * (0.8 + normalized * 1.4);
      const gradient = this.ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, radius);
      gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`);
      gradient.addColorStop(0.6, `rgba(${r}, ${g}, ${b}, ${(a * 0.45).toFixed(3)})`);
      gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
      this.ctx.fillStyle = gradient;
      this.ctx.fillRect(pt.x - radius, pt.y - radius, radius * 2, radius * 2);
    }

    this.ctx.restore();
  };

  private estimateCellRadiusPx(topLeft: L.Point): number {
    if (!this.map || !this.env) return 6;
    const { minX, minY } = this.env.bounds;
    const { cellSizeM } = this.env;
    const base = mercatorToLonLat(minX + cellSizeM * 0.5, minY + cellSizeM * 0.5);
    const offset = mercatorToLonLat(minX + cellSizeM * 1.5, minY + cellSizeM * 0.5);
    const basePt = this.map.latLngToLayerPoint([base.lat, base.lng]).subtract(topLeft);
    const offsetPt = this.map.latLngToLayerPoint([offset.lat, offset.lng]).subtract(topLeft);
    const cellSizePx = Math.max(4, basePt.distanceTo(offsetPt));
    return Math.max(6, cellSizePx * 1.1);
  }
}

export function CanvasCellsLayer(props: {
  env: GridEnvironment | null;
  visited: number[];
  pathCells: number[];
  showVisited: boolean;
}) {
  const map = useMap();

  useEffect(() => {
    const layer = new CanvasCellsLeafletLayer();
    layer.addTo(map);

    return () => {
      layer.remove();
    };
  }, [map]);

  useEffect(() => {
    // Find existing layer instance (the most recent one we added)
    let found: CanvasCellsLeafletLayer | null = null;
    map.eachLayer((l: any) => {
      if (l instanceof CanvasCellsLeafletLayer) found = l;
    });
    if (!found) return;
    found.setData({
      env: props.env,
      visited: props.visited,
      pathCells: props.pathCells,
      showVisited: props.showVisited
    });
  }, [map, props.env, props.visited, props.pathCells, props.showVisited]);

  return null;
}

export function CanvasCostHeatmapLayer(props: { env: GridEnvironment | null; show: boolean }) {
  const map = useMap();

  useEffect(() => {
    const layer = new CanvasCostHeatmapLeafletLayer();
    layer.addTo(map);

    return () => {
      layer.remove();
    };
  }, [map]);

  useEffect(() => {
    let found: CanvasCostHeatmapLeafletLayer | null = null;
    map.eachLayer((l: any) => {
      if (l instanceof CanvasCostHeatmapLeafletLayer) found = l;
    });
    if (!found) return;
    found.setData({
      env: props.env,
      show: props.show
    });
  }, [map, props.env, props.show]);

  return null;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function heatmapColor(normalized: number): { r: number; g: number; b: number; a: number } {
  const start = { r: 0, g: 120, b: 255 };
  const end = { r: 255, g: 0, b: 0 };
  const t = clamp01(normalized);
  const r = Math.round(start.r + (end.r - start.r) * t);
  const g = Math.round(start.g + (end.g - start.g) * t);
  const b = Math.round(start.b + (end.b - start.b) * t);
  const alpha = 0.08 + 0.55 * t;
  return { r, g, b, a: alpha };
}
