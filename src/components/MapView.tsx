import { useEffect, useMemo, useState } from 'react';
import { FeatureGroup, MapContainer, Marker, Polyline, Rectangle, TileLayer } from 'react-leaflet';
import type { LatLngExpression } from 'leaflet';
import L from 'leaflet';
import type { Feature, Polygon, MultiPolygon } from 'geojson';

import type { CostZoneType, LatLng, LatLngBounds, Zone } from '../types';
import { DrawControls, MapClickHandler, type DrawControlsMode } from './DrawControls';
import { CanvasCellsLayer, CanvasCostHeatmapLayer } from './visitedLayer';
import type { GridEnvironment } from '../env/GridEnvironment';

export function MapView(props: {
  zones: Zone[];
  costZoneTypes: CostZoneType[];
  drawMode: DrawControlsMode;
  onZoneCreated: (zoneId: string, shape: Feature<Polygon | MultiPolygon>) => void;
  onZoneEdited: (zoneId: string, shape: Feature<Polygon | MultiPolygon>) => void;
  onZoneDeleted: (zoneId: string) => void;

  start: LatLng | null;
  goal: LatLng | null;
  placementMode: 'start' | 'goal' | null;
  onSetStart: (p: LatLng) => void;
  onSetGoal: (p: LatLng) => void;
  onClearPlacementMode: () => void;

  planningBounds: LatLngBounds | null;
  onViewBounds: (b: LatLngBounds) => void;

  basemap: 'osm' | 'topo' | 'satellite' | 'humanitarian';

  env: GridEnvironment | null;
  visited: number[];
  pathCells: number[];
  pathLatLngs: LatLng[];
  waypointLatLngs: LatLng[];
  waypointColors: string[];
  showVisited: boolean;
  showCostHeatmap: boolean;
  showWaypoints: boolean;
}) {
  const [featureGroup, setFeatureGroup] = useState<L.FeatureGroup | null>(null);
  const costTypeById = useMemo(() => {
    return new Map(props.costZoneTypes.map((type) => [type.id, type]));
  }, [props.costZoneTypes]);

  const center = useMemo<LatLngExpression>(() => {
    // Stanford main quad-ish.
    return [37.4275, -122.1697];
  }, []);

  // Apply styles when zones or cost types change.
  useEffect(() => {
    if (!featureGroup) return;

    featureGroup.eachLayer((layer: any) => {
      const id = layer.__zoneId as string | undefined;
      if (!id) return;
      const zone = props.zones.find((z) => z.id === id);
      if (!zone) return;
      const path = layer as unknown as L.Path;
      if (!('setStyle' in path)) return;

      if (zone.type === 'NO_FLY') {
        path.setStyle({ color: '#cc0000', fillColor: '#cc0000', fillOpacity: 0.25 });
      } else {
        const type = costTypeById.get(zone.costTypeId);
        const color = type?.color ?? '#cc7a00';
        path.setStyle({ color, fillColor: color, fillOpacity: 0.20 });
      }
    });
  }, [costTypeById, featureGroup, props.zones]);

  useEffect(() => {
    if (!featureGroup) return;

    featureGroup.clearLayers();

    props.zones.forEach((zone) => {
      const geoJsonLayer = L.geoJSON(zone.shape);
      geoJsonLayer.eachLayer((layer: any) => {
        layer.__zoneId = zone.id;
        const path = layer as unknown as L.Path;
        if ('setStyle' in path) {
          if (zone.type === 'NO_FLY') {
            path.setStyle({ color: '#cc0000', fillColor: '#cc0000', fillOpacity: 0.25 });
          } else {
            const type = costTypeById.get(zone.costTypeId);
            const color = type?.color ?? '#cc7a00';
            path.setStyle({ color, fillColor: color, fillOpacity: 0.20 });
          }
        }
        featureGroup.addLayer(layer);
      });
    });
  }, [costTypeById, featureGroup, props.zones]);

  const planningRectBounds = useMemo(() => {
    if (!props.planningBounds) return null;
    return [
      [props.planningBounds.south, props.planningBounds.west],
      [props.planningBounds.north, props.planningBounds.east]
    ] as any;
  }, [props.planningBounds]);

  const startPos = props.start ? ([props.start.lat, props.start.lng] as LatLngExpression) : null;
  const goalPos = props.goal ? ([props.goal.lat, props.goal.lng] as LatLngExpression) : null;

  const startIcon = useMemo(() => {
    return L.divIcon({
      className: 'marker marker-start',
      html: '<div class="marker-inner">S</div>',
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });
  }, []);

  const goalIcon = useMemo(() => {
    return L.divIcon({
      className: 'marker marker-goal',
      html: '<div class="marker-inner">G</div>',
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });
  }, []);

  const waypointIcon = useMemo(() => {
    return (label: string, color: string) =>
      L.divIcon({
        className: 'marker marker-waypoint',
        html: `<div class="marker-inner" style="background: ${color};">${label}</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14]
      });
  }, []);

  const tile = useMemo(() => {
    const tiles: Record<string, { url: string; attribution: string }> = {
      osm: {
        url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      },
      humanitarian: {
        url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, Tiles courtesy of HOT'
      },
      topo: {
        url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
        attribution: 'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a>'
      },
      satellite: {
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        attribution: 'Tiles &copy; Esri'
      }
    };
    return tiles[props.basemap] ?? tiles.osm;
  }, [props.basemap]);

  return (
    <MapContainer
      className="map"
      center={center}
      zoom={16}
      scrollWheelZoom={true}
      whenReady={(m) => {
        const map = m.target as L.Map;
        const b = map.getBounds();
        props.onViewBounds({
          south: b.getSouth(),
          west: b.getWest(),
          north: b.getNorth(),
          east: b.getEast()
        });
      }}
      whenCreated={(map) => {
        map.on('moveend', () => {
          const b = map.getBounds();
          props.onViewBounds({
            south: b.getSouth(),
            west: b.getWest(),
            north: b.getNorth(),
            east: b.getEast()
          });
        });
      }}
    >
      {/* key forces remount when switching basemaps */}
      <TileLayer key={props.basemap} attribution={tile.attribution} url={tile.url} />

      <FeatureGroup
        // react-leaflet passes the underlying Leaflet FeatureGroup into this ref callback.
        ref={(fg) => {
          // @ts-expect-error react-leaflet ref typing is awkward; runtime is L.FeatureGroup
          setFeatureGroup((prev) => ((prev as any) === fg ? prev : (fg ?? null)));
        }}
      >
        {featureGroup ? (
          <DrawControls
            featureGroup={featureGroup}
            mode={props.drawMode}
            onZoneCreated={props.onZoneCreated}
            onZoneEdited={props.onZoneEdited}
            onZoneDeleted={props.onZoneDeleted}
          />
        ) : null}
      </FeatureGroup>

      <MapClickHandler
        onClickLatLng={(lat, lng) => {
          if (props.placementMode === 'start') {
            props.onSetStart({ lat, lng });
            props.onClearPlacementMode();
          } else if (props.placementMode === 'goal') {
            props.onSetGoal({ lat, lng });
            props.onClearPlacementMode();
          }
        }}
      />

      {planningRectBounds ? (
        <Rectangle bounds={planningRectBounds} pathOptions={{ color: '#444', weight: 1, fillOpacity: 0 }} />
      ) : null}

      {startPos ? <Marker position={startPos} icon={startIcon} /> : null}
      {goalPos ? <Marker position={goalPos} icon={goalIcon} /> : null}

      {props.pathLatLngs.length > 0 ? (
        <Polyline positions={props.pathLatLngs.map((p) => [p.lat, p.lng]) as any} />
      ) : null}

      {props.showWaypoints
        ? props.waypointLatLngs.map((point, index) => {
            const waypointColor = props.waypointColors[index] ?? '#f08c00';
            return (
              <Marker
                key={`wp-${index}-${point.lat.toFixed(5)}-${point.lng.toFixed(5)}`}
                position={[point.lat, point.lng]}
                icon={waypointIcon(`WP${index + 1}`, waypointColor)}
              />
            );
          })
        : null}

      {/* Canvas overlay for visited + path cells (fast-ish, sampled) */}
      <CanvasCostHeatmapLayer env={props.env} show={props.showCostHeatmap} />
      <CanvasCellsLayer
        env={props.env}
        visited={props.visited}
        pathCells={props.pathCells}
        showVisited={props.showVisited}
      />
    </MapContainer>
  );
}
