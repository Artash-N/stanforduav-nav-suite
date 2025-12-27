import { useEffect, useMemo, useState } from 'react';
import type { Feature, Polygon, MultiPolygon } from 'geojson';
import * as turf from '@turf/turf';

import { fetchAlgorithms, runAlgorithm as runAlgorithmApi } from './api/client';
import type { AlgorithmInfo } from './api/types';
import { MapView } from './components/MapView';
import type { LatLng, LatLngBounds, Zone, ZoneType, PathRunMetrics } from './types';
import { lonLatToMercator, mercatorToLonLat } from './geo/mercator';
import { latLngBoundsToMercatorBounds, rasterizeZonesToGrid } from './env/rasterize';

const MAX_CELLS = 250000; // performance guardrail

export default function App() {
  const [resolutionM, setResolutionM] = useState<number>(10);
  const [zones, setZones] = useState<Zone[]>([]);

  const [basemap, setBasemap] = useState<'osm' | 'topo' | 'satellite' | 'humanitarian'>('osm');

  const [drawZoneType, setDrawZoneType] = useState<ZoneType>('NO_FLY');
  const [drawMultiplier, setDrawMultiplier] = useState<number>(3);
  const [noFlyBufferM, setNoFlyBufferM] = useState<number>(10);

  const [start, setStart] = useState<LatLng | null>(null);
  const [goal, setGoal] = useState<LatLng | null>(null);
  const [placementMode, setPlacementMode] = useState<'start' | 'goal' | null>(null);

  const [currentViewBounds, setCurrentViewBounds] = useState<LatLngBounds | null>(null);
  const [planningBounds, setPlanningBounds] = useState<LatLngBounds | null>(null);

  const [algorithms, setAlgorithms] = useState<AlgorithmInfo[]>([]);
  const [algorithmId, setAlgorithmId] = useState<string>('');
  const [algoError, setAlgoError] = useState<string | null>(null);

  const [showVisited, setShowVisited] = useState<boolean>(false);
  const [isRunning, setIsRunning] = useState<boolean>(false);

  const [runResult, setRunResult] = useState<{
    algo: { id: string; name: string };
    res: {
      path: number[];
      visited: number[];
      expanded: number;
      cost: number;
    };
    runtimeMs: number;
  } | null>(null);
 // Keep planning bounds initialized to first available view bounds so the user can immediately run.
  useEffect(() => {
    if (!planningBounds && currentViewBounds) {
      setPlanningBounds(currentViewBounds);
    }
  }, [planningBounds, currentViewBounds]);

  async function reloadAlgorithms() {
    try {
      setAlgoError(null);
      const list = await fetchAlgorithms();
      setAlgorithms(list);
      // Keep current selection if it still exists, otherwise pick the first.
      if (list.length === 0) {
        setAlgorithmId('');
      } else if (!list.some((a) => a.id === algorithmId)) {
        setAlgorithmId(list[0].id);
      }
    } catch (e: any) {
      setAlgoError(
        `Could not reach the Python backend at /api. Start it with: npm run dev:full (or see README).\n\n${e?.message ?? e}`
      );
      setAlgorithms([]);
      setAlgorithmId('');
    }
  }

  // Load available algorithms from the Python backend.
  useEffect(() => {
    reloadAlgorithms();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  const raster = useMemo(() => {
    if (!planningBounds) return { env: null as any, cellCount: 0, error: 'No planning bounds set.' };

    const boundsM = latLngBoundsToMercatorBounds(planningBounds);
    const width = Math.max(1, Math.ceil((boundsM.maxX - boundsM.minX) / resolutionM));
    const height = Math.max(1, Math.ceil((boundsM.maxY - boundsM.minY) / resolutionM));
    const cellCount = width * height;

    if (cellCount > MAX_CELLS) {
      return {
        env: null as any,
        cellCount,
        error: `Grid too large (${cellCount.toLocaleString()} cells). Zoom in or increase resolution.`
      };
    }

    const { env } = rasterizeZonesToGrid({
      cellSizeM: resolutionM,
      bounds: boundsM,
      zones
    });

    return { env, cellCount, error: null as string | null };
  }, [planningBounds, resolutionM, zones]);

  // If the grid definition changes, any previously returned path/visited cell IDs
  // are no longer meaningful. Clear the visualization to avoid confusing results.
  useEffect(() => {
    setRunResult(null);
  }, [planningBounds, resolutionM, zones]);

  useEffect(() => {
    setZones((prev) => {
      let changed = false;
      const next = prev.map((z) => {
        if (z.type !== 'NO_FLY') return z;
        const buffered = turf.buffer(z.shape as any, noFlyBufferM, { units: 'meters' }) as any;
        changed = true;
        return { ...z, buffered };
      });
      return changed ? next : prev;
    });
  }, [noFlyBufferM]);

  const pathLatLngs = useMemo<LatLng[]>(() => {
    if (!runResult?.res.path || runResult.res.path.length === 0) return [];
    if (!raster.env) return [];
    return runResult.res.path.map((id) => {
      const { xM, yM } = raster.env.cellCenter(id);
      const { lat, lng } = mercatorToLonLat(xM, yM);
      return { lat, lng };
    });
  }, [runResult, raster.env]);

  const metrics = useMemo<PathRunMetrics | null>(() => {
    if (!runResult || !raster.env) return null;
    const { res, runtimeMs, algo } = runResult;
    const pathLengthM = computePathLengthM(raster.env, res.path);
    return {
      algorithmId: algo.id,
      algorithmName: algo.name,
      runtimeMs,
      expanded: res.expanded,
      pathLengthM,
      cost: res.cost
    };
  }, [runResult, raster.env]);

  function onZoneCreated(zoneId: string, shape: Feature<Polygon | MultiPolygon>) {
    setZones((prev) => {
      if (drawZoneType === 'NO_FLY') {
        const buffered = turf.buffer(shape as any, noFlyBufferM, { units: 'meters' }) as any;
        const z: Zone = {
          id: zoneId,
          name: `No-fly ${prev.filter((p) => p.type === 'NO_FLY').length + 1}`,
          type: 'NO_FLY',
          shape,
          buffered
        };
        return [...prev, z];
      }

      const z: Zone = {
        id: zoneId,
        name: `Cost zone ${prev.filter((p) => p.type === 'COST').length + 1}`,
        type: 'COST',
        multiplier: clamp(drawMultiplier, 0.1, 50),
        shape
      };
      return [...prev, z];
    });
  }

  function onZoneEdited(zoneId: string, shape: Feature<Polygon | MultiPolygon>) {
    setZones((prev) =>
      prev.map((z) => {
        if (z.id !== zoneId) return z;
        if (z.type === 'NO_FLY') {
          const buffered = turf.buffer(shape as any, noFlyBufferM, { units: 'meters' }) as any;
          return { ...z, shape, buffered };
        }
        return { ...z, shape };
      })
    );
  }

  function onZoneDeleted(zoneId: string) {
    setZones((prev) => prev.filter((z) => z.id !== zoneId));
  }

  async function runAlgorithm() {
    setRunResult(null);
    const env = raster.env;
    if (!env) return;
    if (!start || !goal) return;
    if (!algorithmId) return;

    const algoInfo = algorithms.find((a) => a.id === algorithmId) ?? { id: algorithmId, name: algorithmId };

    const sM = lonLatToMercator(start.lng, start.lat);
    const gM = lonLatToMercator(goal.lng, goal.lat);

    const sCell = env.worldToCell(sM.x, sM.y);
    const gCell = env.worldToCell(gM.x, gM.y);

    if (sCell === null || gCell === null) {
      alert('Start or goal is outside the planning area rectangle. Set the planning area to include them.');
      return;
    }
    if (env.isBlocked(sCell)) {
      alert('Start is inside a no-fly region (with buffer). Move the start point.');
      return;
    }
    if (env.isBlocked(gCell)) {
      alert('Goal is inside a no-fly region (with buffer). Move the goal point.');
      return;
    }

    // Convert typed arrays to JSON-friendly arrays.
    // (For large grids, this can be a few MB, but it keeps the Python interface dead simple.)
    const blocked = Array.from(env.blocked, (b) => (b ? 1 : 0));
    const costMultiplier = Array.from(env.costMultiplier, (c) => (Number.isFinite(c) ? c : 1));

    setIsRunning(true);
    try {
      const t0 = performance.now();
      const res = await runAlgorithmApi({
        algorithm_id: algorithmId,
        problem: {
          width: env.width,
          height: env.height,
          cell_size_m: env.cellSizeM,
          bounds: {
            min_x: env.bounds.minX,
            min_y: env.bounds.minY,
            max_x: env.bounds.maxX,
            max_y: env.bounds.maxY
          },
          start: sCell,
          goal: gCell,
          blocked,
          cost_multiplier: costMultiplier
        },
        options: {
          return_visited: showVisited,
          max_visited: 50000
        }
      });
      const t1 = performance.now();

      setRunResult({
        algo: { id: algoInfo.id, name: algoInfo.name },
        res: {
          path: res.path,
          visited: res.visited,
          expanded: res.expanded,
          cost: res.cost
        },
        // Use backend runtime if available, but also include total request time.
        runtimeMs: Number.isFinite(res.runtime_ms) ? res.runtime_ms : (t1 - t0)
      });
    } catch (e: any) {
      alert(`Failed to run algorithm.\n\n${e?.message ?? e}`);
    } finally {
      setIsRunning(false);
    }
  }

  const costZones = zones.filter((z) => z.type === 'COST') as Array<Extract<Zone, { type: 'COST' }>>;
  const noFlyCount = zones.filter((z) => z.type === 'NO_FLY').length;

  return (
    <div className="app">
      <div className="sidebar">
        <h1>Stanford UAV Nav Suite</h1>
        <div className="small">
          Draw zones on the map, set start/goal, then run a Python algorithm.
          <br />
          Add algorithms by dropping a file into <code>backend/algorithms/plugins</code>.
        </div>

        {algoError ? (
          <div className="section" style={{ borderColor: '#b00' }}>
            <label style={{ color: '#b00' }}>Backend not running</label>
            <div className="small" style={{ whiteSpace: 'pre-wrap' }}>
              {algoError}
            </div>
          </div>
        ) : null}

        <div className="section">
          <label>Basemap</label>
          <select value={basemap} onChange={(e) => setBasemap(e.target.value as any)}>
            <option value="osm">OSM (Road)</option>
            <option value="topo">OpenTopoMap (Terrain)</option>
            <option value="satellite">Esri World Imagery (Satellite)</option>
            <option value="humanitarian">OSM HOT (Humanitarian)</option>
          </select>
          <div className="small">Switching basemaps does not affect planning; it's just visualization.</div>
        </div>

        <div className="section">
          <label>Planning grid resolution (meters per cell)</label>
          <input
            type="range"
            min={1}
            max={50}
            step={1}
            value={resolutionM}
            onChange={(e) => setResolutionM(parseInt(e.target.value, 10))}
          />
          <div className="small">
            {resolutionM} m/cell{' '}
            <span className="badge">{raster.cellCount.toLocaleString()} cells</span>
          </div>
          {raster.error ? <div className="small" style={{ color: '#b00' }}>{raster.error}</div> : null}

          <div className="row">
            <button
              onClick={() => {
                if (currentViewBounds) setPlanningBounds(currentViewBounds);
              }}
            >
              Set planning area to current view
            </button>
          </div>
          <div className="small">
            Tip: zoom in a lot before using 1–5m resolution.
          </div>
        </div>

        <div className="section">
          <label>Drawing mode</label>
          <select value={drawZoneType} onChange={(e) => setDrawZoneType(e.target.value as ZoneType)}>
            <option value="NO_FLY">No-fly zone (buffered)</option>
            <option value="COST">Cost zone (multiplier)</option>
          </select>

          {drawZoneType === 'COST' ? (
            <>
              <label>Cost multiplier (discouraged &gt; 1, encouraged &lt; 1)</label>
              <input
                type="number"
                min={0.1}
                max={50}
                step={0.1}
                value={drawMultiplier}
                onChange={(e) => setDrawMultiplier(parseFloat(e.target.value))}
              />
            </>
          ) : (
            <>
              <label>No-fly buffer (meters)</label>
              <input
                type="range"
                min={0}
                max={50}
                step={1}
                value={noFlyBufferM}
                onChange={(e) => setNoFlyBufferM(parseInt(e.target.value, 10))}
              />
              <div className="small">
                {noFlyBufferM} m buffer
              </div>
              <div className="small">
                No-fly zones are blocked for planning, with an automatic <b>{noFlyBufferM}m</b> buffer.
              </div>
            </>
          )}

          <hr />
          <div className="small">
            Zones: <b>{noFlyCount}</b> no-fly, <b>{costZones.length}</b> cost.
            <br />
            Use the polygon/rectangle tools on the map (top-left) to draw.
            <br />
            Tip: to finish a polygon, click the <b>first</b> vertex (double-click is disabled while drawing).
          </div>
        </div>

        {costZones.length > 0 ? (
          <div className="section">
            <label>Adjust cost zones</label>
            {costZones.map((z) => (
              <div key={z.id} style={{ marginBottom: 10 }}>
                <div className="small"><b>{z.name}</b></div>
                <input
                  type="number"
                  min={0.1}
                  max={50}
                  step={0.1}
                  value={z.multiplier}
                  onChange={(e) => {
                    const v = clamp(parseFloat(e.target.value), 0.1, 50);
                    setZones((prev) => prev.map((p) => (p.id === z.id && p.type === 'COST' ? { ...p, multiplier: v } : p)));
                  }}
                />
              </div>
            ))}
            <div className="small">(Deletion/editing geometry happens via the map draw controls for now.)</div>
          </div>
        ) : null}

        <div className="section">
          <label>Start / Goal</label>
          <div className="row">
            <button onClick={() => setPlacementMode('start')}>Click map to set START</button>
            <button onClick={() => setPlacementMode('goal')}>Click map to set GOAL</button>
          </div>
          <div className="row">
            <button
              onClick={() => {
                setStart(null);
                setGoal(null);
                setRunResult(null);
              }}
            >
              Clear points
            </button>
          </div>
          <div className="small">
            Start: {start ? `${start.lat.toFixed(6)}, ${start.lng.toFixed(6)}` : '(not set)'}
            <br />
            Goal: {goal ? `${goal.lat.toFixed(6)}, ${goal.lng.toFixed(6)}` : '(not set)'}
          </div>
        </div>

        <div className="section">
          <label>Algorithm</label>
          <select value={algorithmId} onChange={(e) => setAlgorithmId(e.target.value)}>
            {algorithms.length === 0 ? <option value="">(no backend algorithms found)</option> : null}
            {algorithms.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>

          <div className="row">
            <button onClick={reloadAlgorithms} disabled={isRunning}>
              Refresh algorithms
            </button>
          </div>

          <div className="row">
            <button
              disabled={!raster.env || !!raster.error || !start || !goal || !algorithmId || !!algoError || isRunning}
              onClick={runAlgorithm}
            >
              {isRunning ? 'Running…' : 'Run'}
            </button>
            <button onClick={() => setRunResult(null)}>Clear path</button>
          </div>

          <label>
            <input
              type="checkbox"
              checked={showVisited}
              onChange={(e) => setShowVisited(e.target.checked)}
              style={{ width: 'auto', marginRight: 8 }}
            />
            Show explored nodes
          </label>

          {metrics ? (
            <div className="section">
              <label>Run metrics</label>
              <div className="kv">
                <div className="small">Runtime</div>
                <div className="small">{metrics.runtimeMs.toFixed(2)} ms</div>

                <div className="small">Expanded</div>
                <div className="small">{metrics.expanded.toLocaleString()}</div>

                <div className="small">Path length</div>
                <div className="small">{metrics.pathLengthM.toFixed(1)} m</div>

                <div className="small">Cost</div>
                <div className="small">{Number.isFinite(metrics.cost) ? metrics.cost.toFixed(1) : '∞'}</div>
              </div>
              {runResult?.res.path.length === 0 ? (
                <div className="small" style={{ color: '#b00', marginTop: 8 }}>
                  No path found.
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <MapView
        zones={zones}
        drawMode={{ zoneType: drawZoneType, multiplier: drawMultiplier }}
        onZoneCreated={onZoneCreated}
        onZoneEdited={onZoneEdited}
        onZoneDeleted={onZoneDeleted}

        start={start}
        goal={goal}
        placementMode={placementMode}
        onSetStart={(p) => setStart(p)}
        onSetGoal={(p) => setGoal(p)}
        onClearPlacementMode={() => setPlacementMode(null)}

        planningBounds={planningBounds}
        onViewBounds={(b) => setCurrentViewBounds(b)}

        basemap={basemap}

        env={raster.env ? raster.env : null}
        visited={runResult?.res.visited ?? []}
        pathCells={runResult?.res.path ?? []}
        pathLatLngs={pathLatLngs}
        showVisited={showVisited}
      />
    </div>
  );
}

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function computePathLengthM(env: any, path: number[]): number {
  if (path.length <= 1) return 0;
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const a = env.cellCenter(path[i - 1]);
    const b = env.cellCenter(path[i]);
    total += Math.hypot(a.xM - b.xM, a.yM - b.yM);
  }
  return total;
}
