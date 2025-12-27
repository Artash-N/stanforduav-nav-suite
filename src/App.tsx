import { useEffect, useMemo, useRef, useState } from 'react';
import type { Feature, Polygon, MultiPolygon } from 'geojson';
import * as turf from '@turf/turf';

import { fetchAlgorithms, runAlgorithm as runAlgorithmApi } from './api/client';
import type { AlgorithmInfo } from './api/types';
import { MapView } from './components/MapView';
import type { CostZoneType, LatLng, LatLngBounds, Zone, PathRunMetrics } from './types';
import { lonLatToMercator, mercatorToLonLat } from './geo/mercator';
import { latLngBoundsToMercatorBounds, rasterizeZonesToGrid } from './env/rasterize';

const MAX_CELLS = 250000; // performance guardrail
const DEFAULT_NO_FLY_BUFFER_M = 10;

type BasemapId = 'osm' | 'topo' | 'satellite' | 'humanitarian';

type DrawMode = { kind: 'NO_FLY' } | { kind: 'COST'; costTypeId: string };

type SerializedZone =
  | {
      id: string;
      name: string;
      type: 'NO_FLY';
      shape: Feature<Polygon | MultiPolygon>;
    }
  | {
      id: string;
      name: string;
      type: 'COST';
      costTypeId: string;
      shape: Feature<Polygon | MultiPolygon>;
    };

interface MapState {
  version: 2;
  zones: SerializedZone[];
  start: LatLng | null;
  goal: LatLng | null;
  planningBounds: LatLngBounds | null;
  resolutionM: number;
  basemap: BasemapId;
  noFlyBufferM: number;
  avoidHighMultiplier: boolean;
  rolloffStrength: number;
  rolloffDistanceM: number;
  costZoneTypes: CostZoneType[];
  drawMode: DrawMode;
}

interface ParsedMapState {
  zones: SerializedZone[];
  start: LatLng | null;
  goal: LatLng | null;
  planningBounds: LatLngBounds | null;
  resolutionM: number;
  basemap: BasemapId;
  noFlyBufferM: number;
  avoidHighMultiplier: boolean;
  rolloffStrength: number;
  rolloffDistanceM: number;
  costZoneTypes: CostZoneType[];
  drawMode: DrawMode;
}

const COST_TYPE_COLOR_OPTIONS = [
  { name: 'Green', color: '#2f9e44' },
  { name: 'Orange', color: '#fd7e14' },
  { name: 'Light purple', color: '#845ef7' },
  { name: 'Teal', color: '#12b886' },
  { name: 'Pink', color: '#e64980' },
  { name: 'Blue', color: '#339af0' }
];
const COST_TYPE_COLORS = COST_TYPE_COLOR_OPTIONS.map((option) => option.color);
const DEFAULT_COST_ZONE_TYPES: CostZoneType[] = [
  { id: 'residential', name: 'Residential', multiplier: 1.5, color: '#fd7e14' },
  { id: 'heavy-traffic', name: 'Heavy traffic', multiplier: 2.5, color: '#e64980' },
  { id: 'open-space', name: 'Open space', multiplier: 0.7, color: '#2f9e44' }
];
const DEFAULT_AVOID_HIGH_MULTIPLIER = false;
const DEFAULT_ROLLOFF_STRENGTH = 1;
const DEFAULT_ROLLOFF_DISTANCE_M = 50;

export default function App() {
  const [resolutionM, setResolutionM] = useState<number>(10);
  const [zones, setZones] = useState<Zone[]>([]);
  const [activeColorPickerId, setActiveColorPickerId] = useState<string | null>(null);

  const [basemap, setBasemap] = useState<BasemapId>('osm');

  const [costZoneTypes, setCostZoneTypes] = useState<CostZoneType[]>(() => DEFAULT_COST_ZONE_TYPES);
  const [drawMode, setDrawMode] = useState<DrawMode>({ kind: 'NO_FLY' });
  const [noFlyBufferM, setNoFlyBufferM] = useState<number>(DEFAULT_NO_FLY_BUFFER_M);
  const [avoidHighMultiplier, setAvoidHighMultiplier] = useState<boolean>(DEFAULT_AVOID_HIGH_MULTIPLIER);
  const [rolloffStrength, setRolloffStrength] = useState<number>(DEFAULT_ROLLOFF_STRENGTH);
  const [rolloffDistanceM, setRolloffDistanceM] = useState<number>(DEFAULT_ROLLOFF_DISTANCE_M);

  const [start, setStart] = useState<LatLng | null>(null);
  const [goal, setGoal] = useState<LatLng | null>(null);
  const [placementMode, setPlacementMode] = useState<'start' | 'goal' | null>(null);

  const [currentViewBounds, setCurrentViewBounds] = useState<LatLngBounds | null>(null);
  const [planningBounds, setPlanningBounds] = useState<LatLngBounds | null>(null);

  const [algorithms, setAlgorithms] = useState<AlgorithmInfo[]>([]);
  const [algorithmId, setAlgorithmId] = useState<string>('');
  const [algoError, setAlgoError] = useState<string | null>(null);

  const [showVisited, setShowVisited] = useState<boolean>(false);
  const [showCostHeatmap, setShowCostHeatmap] = useState<boolean>(false);
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [newCostTypeName, setNewCostTypeName] = useState<string>('');
  const [newCostTypeMultiplier, setNewCostTypeMultiplier] = useState<number>(1.2);

  const costTypeById = useMemo(() => {
    return new Map(costZoneTypes.map((type) => [type.id, type]));
  }, [costZoneTypes]);

  const selectedCostType =
    drawMode.kind === 'COST' ? costTypeById.get(drawMode.costTypeId) ?? costZoneTypes[0] ?? null : null;
  const drawSelection = drawMode.kind === 'NO_FLY' ? 'NO_FLY' : drawMode.costTypeId;

  useEffect(() => {
    if (drawMode.kind !== 'COST') return;
    if (costTypeById.has(drawMode.costTypeId)) return;
    const fallback = costZoneTypes[0];
    if (fallback) {
      setDrawMode({ kind: 'COST', costTypeId: fallback.id });
    } else {
      setDrawMode({ kind: 'NO_FLY' });
    }
  }, [costTypeById, costZoneTypes, drawMode]);

  // Keep planning bounds initialized to first available view bounds so the user can immediately run.
  useEffect(() => {
    if (!planningBounds && currentViewBounds) {
      setPlanningBounds(currentViewBounds);
    }
  }, [planningBounds, currentViewBounds]);

  useEffect(() => {
    setZones((prev) =>
      prev.map((zone) => {
        if (zone.type !== 'NO_FLY') return zone;
        const buffered = turf.buffer(zone.shape as any, noFlyBufferM, { units: 'meters' }) as any;
        return { ...zone, buffered };
      })
    );
  }, [noFlyBufferM]);

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
      zones,
      costZoneTypes,
      avoidHighMultiplier,
      rolloffStrength,
      rolloffDistanceM
    });

    return { env, cellCount, error: null as string | null };
  }, [
    avoidHighMultiplier,
    costZoneTypes,
    planningBounds,
    resolutionM,
    rolloffDistanceM,
    rolloffStrength,
    zones
  ]);

  // If the grid definition changes, any previously returned path/visited cell IDs
  // are no longer meaningful. Clear the visualization to avoid confusing results.
  useEffect(() => {
    setRunResult(null);
  }, [planningBounds, resolutionM, zones]);

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
      if (drawMode.kind === 'NO_FLY') {
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

      const costType = selectedCostType ?? costZoneTypes[0];
      if (!costType) {
        return prev;
      }
      const typeIndex = prev.filter((p) => p.type === 'COST' && p.costTypeId === costType.id).length + 1;
      const z: Zone = {
        id: zoneId,
        name: `${costType.name} ${typeIndex}`,
        type: 'COST',
        costTypeId: costType.id,
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
  const costZoneCounts = useMemo(() => {
    const counts = new Map<string, number>();
    costZones.forEach((zone) => {
      counts.set(zone.costTypeId, (counts.get(zone.costTypeId) ?? 0) + 1);
    });
    return counts;
  }, [costZones]);
  const currentMapState = useMemo<MapState>(() => {
    const serializedZones: SerializedZone[] = zones.map((zone) => {
      if (zone.type === 'NO_FLY') {
        return {
          id: zone.id,
          name: zone.name,
          type: 'NO_FLY',
          shape: zone.shape
        };
      }
      return {
        id: zone.id,
        name: zone.name,
        type: 'COST',
        costTypeId: zone.costTypeId,
        shape: zone.shape
      };
    });

    return {
      version: 2,
      zones: serializedZones,
      start,
      goal,
      planningBounds,
      resolutionM,
      basemap,
      noFlyBufferM,
      avoidHighMultiplier,
      rolloffStrength,
      rolloffDistanceM,
      costZoneTypes,
      drawMode
    };
  }, [
    avoidHighMultiplier,
    basemap,
    costZoneTypes,
    drawMode,
    goal,
    noFlyBufferM,
    planningBounds,
    resolutionM,
    rolloffDistanceM,
    rolloffStrength,
    start,
    zones
  ]);

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
          <label>Map state</label>
          <div className="row">
            <button
              onClick={() => {
                const data = JSON.stringify(currentMapState, null, 2);
                const blob = new Blob([data], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = 'map-state.json';
                document.body.appendChild(link);
                link.click();
                link.remove();
                URL.revokeObjectURL(url);
              }}
            >
              Save
            </button>
            <button onClick={() => fileInputRef.current?.click()}>Load</button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json"
            style={{ display: 'none' }}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              event.target.value = '';
              try {
                const text = await file.text();
                const parsed = JSON.parse(text);
                const next = parseMapState(parsed);
                if (!next) {
                  alert('Invalid map state file.');
                  return;
                }
                setZones(
                  next.zones.map((zone) => {
                    if (zone.type === 'NO_FLY') {
                      const buffered = turf.buffer(zone.shape as any, next.noFlyBufferM, { units: 'meters' }) as any;
                      return { ...zone, buffered } as Zone;
                    }
                    return { ...zone } as Zone;
                  })
                );
                setStart(next.start);
                setGoal(next.goal);
                setPlanningBounds(next.planningBounds);
                setResolutionM(next.resolutionM);
                setBasemap(next.basemap);
                setNoFlyBufferM(next.noFlyBufferM);
                setAvoidHighMultiplier(next.avoidHighMultiplier);
                setRolloffStrength(next.rolloffStrength);
                setRolloffDistanceM(next.rolloffDistanceM);
                setCostZoneTypes(next.costZoneTypes);
                setDrawMode(next.drawMode);
                setPlacementMode(null);
                setRunResult(null);
              } catch (e: any) {
                alert(`Failed to load map state.\n\n${e?.message ?? e}`);
              }
            }}
          />
          <div className="small">Save or load zones, bounds, and settings as JSON.</div>
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
          <select
            value={drawSelection}
            onChange={(e) => {
              const value = e.target.value;
              if (value === 'NO_FLY') {
                setDrawMode({ kind: 'NO_FLY' });
              } else {
                setDrawMode({ kind: 'COST', costTypeId: value });
              }
            }}
          >
            <option value="NO_FLY">No-fly zone ({noFlyBufferM}m buffer)</option>
            {costZoneTypes.length > 0 ? (
              <optgroup label="Cost zone types">
                {costZoneTypes.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name} (x{type.multiplier})
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
          <label>No-fly buffer (meters)</label>
          <input
            type="range"
            min={0}
            max={50}
            step={1}
            value={noFlyBufferM}
            onChange={(e) => setNoFlyBufferM(parseInt(e.target.value, 10))}
          />
          <div className="small">{noFlyBufferM} m</div>
          <div className="small">
            No-fly zones are blocked for planning, with an automatic <b>{noFlyBufferM}m</b> buffer.
          </div>

          <label>Cost zone types</label>
          <div className="small">Create named cost zone types and set their multipliers.</div>
          <div className="zone-type-list">
            {costZoneTypes.map((type) => {
              const usageCount = costZoneCounts.get(type.id) ?? 0;
              const disableDelete = usageCount > 0 || costZoneTypes.length <= 1;
              return (
                <div className="zone-type-row" key={type.id}>
                  <div className="zone-type-color-picker">
                    <button
                      className="zone-type-color"
                      type="button"
                      style={{ background: type.color }}
                      aria-label={`Change ${type.name} color`}
                      onClick={() =>
                        setActiveColorPickerId((prev) => (prev === type.id ? null : type.id))
                      }
                    />
                    {activeColorPickerId === type.id ? (
                      <div className="zone-type-color-options" role="listbox" aria-label="Color options">
                        {COST_TYPE_COLOR_OPTIONS.map((option) => (
                          <button
                            key={option.color}
                            className="zone-type-color-option"
                            type="button"
                            style={{ background: option.color }}
                            aria-label={option.name}
                            onClick={() => {
                              setCostZoneTypes((prev) =>
                                prev.map((entry) =>
                                  entry.id === type.id ? { ...entry, color: option.color } : entry
                                )
                              );
                              setActiveColorPickerId(null);
                            }}
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <input
                    type="text"
                    value={type.name}
                    onChange={(e) => {
                      const name = e.target.value;
                      setCostZoneTypes((prev) =>
                        prev.map((entry) => (entry.id === type.id ? { ...entry, name } : entry))
                      );
                    }}
                  />
                  <input
                    type="number"
                    min={0.1}
                    max={50}
                    step={0.1}
                    value={type.multiplier}
                    onChange={(e) => {
                      const multiplier = clamp(parseFloat(e.target.value), 0.1, 50);
                      setCostZoneTypes((prev) =>
                        prev.map((entry) => (entry.id === type.id ? { ...entry, multiplier } : entry))
                      );
                    }}
                  />
                  <button
                    className="icon-button"
                    title={
                      disableDelete
                        ? usageCount > 0
                          ? 'Delete is disabled while zones use this type.'
                          : 'At least one cost type must remain.'
                        : 'Delete this type'
                    }
                    onClick={() => {
                      if (disableDelete) return;
                      setCostZoneTypes((prev) => prev.filter((entry) => entry.id !== type.id));
                      if (drawMode.kind === 'COST' && drawMode.costTypeId === type.id) {
                        setDrawMode({ kind: 'NO_FLY' });
                      }
                    }}
                    disabled={disableDelete}
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
          <div className="zone-type-row zone-type-row-add">
            <span className="zone-type-color preview" style={{ background: pickNextCostTypeColor(costZoneTypes) }} />
            <input
              type="text"
              placeholder="New type name"
              value={newCostTypeName}
              onChange={(e) => setNewCostTypeName(e.target.value)}
            />
            <input
              type="number"
              min={0.1}
              max={50}
              step={0.1}
              value={newCostTypeMultiplier}
              onChange={(e) => {
                const value = parseFloat(e.target.value);
                setNewCostTypeMultiplier(Number.isFinite(value) ? value : 0.1);
              }}
            />
            <button
              className="icon-button"
              title="Add cost type"
              onClick={() => {
                const name = newCostTypeName.trim();
                if (!name) return;
                const multiplier = clamp(newCostTypeMultiplier, 0.1, 50);
                const color = pickNextCostTypeColor(costZoneTypes);
                const id = makeCostTypeId(name, costZoneTypes);
                setCostZoneTypes((prev) => [...prev, { id, name, multiplier, color }]);
                setNewCostTypeName('');
              }}
            >
              +
            </button>
          </div>

          <label>High-cost rolloff</label>
          <label>
            <input
              type="checkbox"
              checked={avoidHighMultiplier}
              onChange={(e) => setAvoidHighMultiplier(e.target.checked)}
              style={{ width: 'auto', marginRight: 8 }}
            />
            Avoid high-cost zones with a soft gradient
          </label>
          <label>Rolloff strength</label>
          <input
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={rolloffStrength}
            onChange={(e) => setRolloffStrength(parseFloat(e.target.value))}
            disabled={!avoidHighMultiplier}
          />
          <div className="small">{rolloffStrength.toFixed(2)} strength</div>
          <label>Rolloff distance (meters)</label>
          <input
            type="range"
            min={0}
            max={200}
            step={5}
            value={rolloffDistanceM}
            onChange={(e) => setRolloffDistanceM(parseInt(e.target.value, 10))}
            disabled={!avoidHighMultiplier}
          />
          <div className="small">{rolloffDistanceM} m</div>

          <hr />
          <div className="small">
            Zones: <b>{noFlyCount}</b> no-fly, <b>{costZones.length}</b> cost.
            <br />
            Cost types:{' '}
            {costZoneTypes
              .map((type) => `${type.name} (${costZoneCounts.get(type.id) ?? 0})`)
              .join(', ')}
            <br />
            Use the polygon/rectangle tools on the map (top-left) to draw.
            <br />
            Tip: to finish a polygon, click the <b>first</b> vertex (double-click is disabled while drawing).
          </div>
        </div>

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
          <label>
            <input
              type="checkbox"
              checked={showCostHeatmap}
              onChange={(e) => setShowCostHeatmap(e.target.checked)}
              style={{ width: 'auto', marginRight: 8 }}
            />
            Show cost heatmap
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
        costZoneTypes={costZoneTypes}
        drawMode={{ kind: drawMode.kind, costType: selectedCostType }}
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
        showCostHeatmap={showCostHeatmap}
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

const basemapOptions = new Set<BasemapId>(['osm', 'topo', 'satellite', 'humanitarian']);

function isLatLng(value: any): value is LatLng {
  return (
    value &&
    typeof value === 'object' &&
    typeof value.lat === 'number' &&
    Number.isFinite(value.lat) &&
    typeof value.lng === 'number' &&
    Number.isFinite(value.lng)
  );
}

function isLatLngBounds(value: any): value is LatLngBounds {
  return (
    value &&
    typeof value === 'object' &&
    typeof value.south === 'number' &&
    Number.isFinite(value.south) &&
    typeof value.west === 'number' &&
    Number.isFinite(value.west) &&
    typeof value.north === 'number' &&
    Number.isFinite(value.north) &&
    typeof value.east === 'number' &&
    Number.isFinite(value.east)
  );
}

function isPolygonFeature(value: any): value is Feature<Polygon | MultiPolygon> {
  const geometryType = value?.geometry?.type;
  return value?.type === 'Feature' && (geometryType === 'Polygon' || geometryType === 'MultiPolygon');
}

function pickNextCostTypeColor(types: CostZoneType[]): string {
  const used = new Set(types.map((type) => type.color));
  for (const color of COST_TYPE_COLORS) {
    if (!used.has(color)) return color;
  }
  return COST_TYPE_COLORS[types.length % COST_TYPE_COLORS.length] ?? '#6c757d';
}

function makeCostTypeId(name: string, existing: CostZoneType[]): string {
  const base =
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || 'cost-type';
  const existingIds = new Set(existing.map((type) => type.id));
  let candidate = base;
  let suffix = 2;
  while (existingIds.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function coerceCostZoneTypes(raw: any, fallback: CostZoneType[]): CostZoneType[] {
  if (!Array.isArray(raw)) return fallback;
  const seen = new Set<string>();
  const types: CostZoneType[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.id !== 'string' || typeof entry.name !== 'string') continue;
    if (!Number.isFinite(entry.multiplier) || typeof entry.color !== 'string') continue;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    types.push({
      id: entry.id,
      name: entry.name,
      multiplier: clamp(entry.multiplier, 0.1, 50),
      color: entry.color
    });
  }
  return types.length > 0 ? types : fallback;
}

function coerceDrawMode(raw: any, costZoneTypes: CostZoneType[]): DrawMode | null {
  if (!raw || typeof raw !== 'object') return { kind: 'NO_FLY' };
  if (raw.kind === 'NO_FLY') return { kind: 'NO_FLY' };
  if (raw.kind === 'COST') {
    if (typeof raw.costTypeId !== 'string') return null;
    const exists = costZoneTypes.some((type) => type.id === raw.costTypeId);
    if (exists) return { kind: 'COST', costTypeId: raw.costTypeId };
    if (costZoneTypes[0]) return { kind: 'COST', costTypeId: costZoneTypes[0].id };
  }
  return null;
}

function parseMapState(raw: any): ParsedMapState | null {
  if (!raw || typeof raw !== 'object') return null;
  if (!basemapOptions.has(raw.basemap)) return null;
  if (!Number.isFinite(raw.resolutionM)) return null;
  if (!Number.isFinite(raw.noFlyBufferM)) return null;

  const start = raw.start;
  if (start !== null && !isLatLng(start)) return null;
  const goal = raw.goal;
  if (goal !== null && !isLatLng(goal)) return null;
  const planningBounds = raw.planningBounds;
  if (planningBounds !== null && !isLatLngBounds(planningBounds)) return null;

  if (!Array.isArray(raw.zones)) return null;

  if (raw.version === 2) {
    const costZoneTypes = coerceCostZoneTypes(raw.costZoneTypes, DEFAULT_COST_ZONE_TYPES);
    const costTypeIds = new Set(costZoneTypes.map((type) => type.id));
    const zones: SerializedZone[] = [];
    for (const zone of raw.zones) {
      if (!zone || typeof zone !== 'object') return null;
      if (typeof zone.id !== 'string' || typeof zone.name !== 'string') return null;
      if (zone.type === 'NO_FLY') {
        if (!isPolygonFeature(zone.shape)) return null;
        zones.push({
          id: zone.id,
          name: zone.name,
          type: 'NO_FLY',
          shape: zone.shape
        });
        continue;
      }
      if (zone.type === 'COST') {
        if (!isPolygonFeature(zone.shape)) return null;
        if (typeof zone.costTypeId !== 'string') return null;
        const costTypeId = costTypeIds.has(zone.costTypeId) ? zone.costTypeId : costZoneTypes[0]?.id;
        if (!costTypeId) return null;
        zones.push({
          id: zone.id,
          name: zone.name,
          type: 'COST',
          costTypeId,
          shape: zone.shape
        });
        continue;
      }
      return null;
    }

    const drawMode = coerceDrawMode(raw.drawMode, costZoneTypes);
    if (!drawMode) return null;

    return {
      zones,
      start: start ?? null,
      goal: goal ?? null,
      planningBounds: planningBounds ?? null,
      resolutionM: raw.resolutionM,
      basemap: raw.basemap,
      noFlyBufferM: raw.noFlyBufferM,
      avoidHighMultiplier:
        typeof raw.avoidHighMultiplier === 'boolean' ? raw.avoidHighMultiplier : DEFAULT_AVOID_HIGH_MULTIPLIER,
      rolloffStrength: Number.isFinite(raw.rolloffStrength)
        ? clamp(raw.rolloffStrength, 0, 2)
        : DEFAULT_ROLLOFF_STRENGTH,
      rolloffDistanceM: Number.isFinite(raw.rolloffDistanceM)
        ? clamp(raw.rolloffDistanceM, 0, 1000)
        : DEFAULT_ROLLOFF_DISTANCE_M,
      costZoneTypes,
      drawMode
    };
  }

  if (raw.version === 1) {
    const zones: SerializedZone[] = [];
    const costTypeByMultiplier = new Map<string, CostZoneType>();
    const costZoneTypes: CostZoneType[] = [];

    const ensureCostType = (multiplierRaw: number) => {
      const multiplier = clamp(multiplierRaw, 0.1, 50);
      const key = String(multiplier);
      const existing = costTypeByMultiplier.get(key);
      if (existing) return existing;
      const name = `Cost x${multiplier}`;
      const color = pickNextCostTypeColor(costZoneTypes);
      const id = makeCostTypeId(name, costZoneTypes);
      const type = { id, name, multiplier, color };
      costZoneTypes.push(type);
      costTypeByMultiplier.set(key, type);
      return type;
    };

    for (const zone of raw.zones) {
      if (!zone || typeof zone !== 'object') return null;
      if (typeof zone.id !== 'string' || typeof zone.name !== 'string') return null;
      if (zone.type === 'NO_FLY') {
        if (!isPolygonFeature(zone.shape)) return null;
        zones.push({
          id: zone.id,
          name: zone.name,
          type: 'NO_FLY',
          shape: zone.shape
        });
        continue;
      }
      if (zone.type === 'COST') {
        if (!isPolygonFeature(zone.shape)) return null;
        if (!Number.isFinite(zone.multiplier)) return null;
        const type = ensureCostType(zone.multiplier);
        zones.push({
          id: zone.id,
          name: zone.name,
          type: 'COST',
          costTypeId: type.id,
          shape: zone.shape
        });
        continue;
      }
      return null;
    }

    if (costZoneTypes.length === 0 && Number.isFinite(raw.drawMultiplier)) {
      ensureCostType(raw.drawMultiplier);
    }

    const normalizedTypes = costZoneTypes.length > 0 ? costZoneTypes : DEFAULT_COST_ZONE_TYPES;

    return {
      zones,
      start: start ?? null,
      goal: goal ?? null,
      planningBounds: planningBounds ?? null,
      resolutionM: raw.resolutionM,
      basemap: raw.basemap,
      noFlyBufferM: raw.noFlyBufferM,
      avoidHighMultiplier: DEFAULT_AVOID_HIGH_MULTIPLIER,
      rolloffStrength: DEFAULT_ROLLOFF_STRENGTH,
      rolloffDistanceM: DEFAULT_ROLLOFF_DISTANCE_M,
      costZoneTypes: normalizedTypes,
      drawMode: { kind: 'NO_FLY' }
    };
  }

  return null;
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
