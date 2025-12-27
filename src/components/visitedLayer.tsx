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
