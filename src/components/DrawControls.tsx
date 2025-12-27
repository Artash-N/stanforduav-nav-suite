import { useEffect } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import type { Feature, Polygon, MultiPolygon } from 'geojson';
import 'leaflet-draw';
import type { ZoneType } from '../types';

export interface DrawControlsMode {
  zoneType: ZoneType;
  multiplier: number; // used for COST zones
}

export function DrawControls(props: {
  featureGroup: L.FeatureGroup;
  mode: DrawControlsMode;
  onZoneCreated: (zoneId: string, shape: Feature<Polygon | MultiPolygon>) => void;
  onZoneEdited: (zoneId: string, shape: Feature<Polygon | MultiPolygon>) => void;
  onZoneDeleted: (zoneId: string) => void;
}) {
  const map = useMap();

  useEffect(() => {
    const { featureGroup } = props;

    // Make Leaflet-draw tooltips more explicit.
    // Some users interpret "Click to finish shape" as "you MUST finish now".
    // We want to communicate: you can keep adding vertices.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dl = (L as any).drawLocal;
      if (dl?.draw?.handlers?.polygon?.tooltip) {
        dl.draw.handlers.polygon.tooltip.start = 'Click to start drawing a zone.';
        dl.draw.handlers.polygon.tooltip.cont = 'Click to add another point.';
        dl.draw.handlers.polygon.tooltip.end = 'Click the first point to finish (or press ESC to cancel).';
      }
      if (dl?.draw?.handlers?.rectangle?.tooltip) {
        dl.draw.handlers.rectangle.tooltip.start = 'Click and drag to draw a rectangle zone.';
      }
    } catch {
      // non-fatal; tooltips will just be Leaflet-draw defaults
    }

    // Leaflet-draw finishes polygons on double-click by default.
    // Many trackpad users double-click unintentionally, which results in lots of accidental triangles.
    //
    // IMPORTANT: Leaflet-draw may register its dblclick handler in the *capture* phase.
    // If we add a blocker only after drawing starts, it might run *after* Leaflet-draw.
    // To ensure we reliably suppress double-click finishing, we register capture listeners
    // up-front and gate them with a flag.
    const container = map.getContainer();
    let blockDoubleClicks = false;
    let dblZoomWasEnabled = map.doubleClickZoom.enabled();

    const dblClickCapture = (ev: MouseEvent) => {
      if (!blockDoubleClicks) return;
      ev.preventDefault();
      ev.stopPropagation();
      // stopImmediatePropagation is critical if Leaflet-draw also installed a capture listener.
      ev.stopImmediatePropagation();
    };

    // Some browsers (and some trackpads) can still fire the second click event very quickly
    // with detail=2; this guards against that as well.
    const clickCapture = (ev: MouseEvent) => {
      if (!blockDoubleClicks) return;
      if (ev.detail && ev.detail > 1) {
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();
      }
    };

    container.addEventListener('dblclick', dblClickCapture, true);
    container.addEventListener('click', clickCapture, true);

    // Create draw control.
    const drawControl = new L.Control.Draw({
      position: 'topleft',
      draw: {
        polygon: {
          allowIntersection: false,
          showArea: true,
          shapeOptions: {
            // style is overwritten on create based on zone type
            weight: 2
          }
        },
        polyline: false,
        rectangle: {
          shapeOptions: {
            weight: 2
          }
        },
        circle: false,
        circlemarker: false,
        marker: false
      },
      edit: {
        featureGroup,
        remove: true
      }
    });

    map.addControl(drawControl);

    function setLayerStyle(layer: L.Layer) {
      // Only style vector layers.
      const path = layer as unknown as L.Path;
      if (!('setStyle' in path)) return;

      const type = props.mode.zoneType;
      if (type === 'NO_FLY') {
        path.setStyle({ color: '#cc0000', fillColor: '#cc0000', fillOpacity: 0.25 });
        return;
      }
      // COST: discouraged (>1) vs encouraged (<1)
      const m = props.mode.multiplier;
      if (m >= 1) {
        path.setStyle({ color: '#cc7a00', fillColor: '#cc7a00', fillOpacity: 0.20 });
      } else {
        path.setStyle({ color: '#2b8a3e', fillColor: '#2b8a3e', fillOpacity: 0.20 });
      }
    }

    function onCreated(e: any) {
      const layer: L.Layer = e.layer;
      const id = crypto.randomUUID();
      // attach id to layer for later edits/deletes
      (layer as any).__zoneId = id;

      setLayerStyle(layer);
      featureGroup.addLayer(layer);

      const gj = layer.toGeoJSON() as Feature<Polygon | MultiPolygon>;
      props.onZoneCreated(id, gj);
    }

    function onEdited(e: any) {
      const layers: L.LayerGroup = e.layers;
      layers.eachLayer((layer: any) => {
        const id = layer.__zoneId as string | undefined;
        if (!id) return;
        const gj = layer.toGeoJSON() as Feature<Polygon | MultiPolygon>;
        props.onZoneEdited(id, gj);
      });
    }

    function onDeleted(e: any) {
      const layers: L.LayerGroup = e.layers;
      layers.eachLayer((layer: any) => {
        const id = layer.__zoneId as string | undefined;
        if (!id) return;
        props.onZoneDeleted(id);
      });
    }

    map.on(L.Draw.Event.CREATED, onCreated);
    map.on(L.Draw.Event.EDITED, onEdited);
    map.on(L.Draw.Event.DELETED, onDeleted);

    const onDrawStart = () => {
      dblZoomWasEnabled = map.doubleClickZoom.enabled();
      map.doubleClickZoom.disable();
      blockDoubleClicks = true;
    };
    const onDrawStop = () => {
      blockDoubleClicks = false;
      if (dblZoomWasEnabled) map.doubleClickZoom.enable();
    };

    map.on('draw:drawstart', onDrawStart);
    map.on('draw:drawstop', onDrawStop);

    return () => {
      map.off(L.Draw.Event.CREATED, onCreated);
      map.off(L.Draw.Event.EDITED, onEdited);
      map.off(L.Draw.Event.DELETED, onDeleted);
      map.off('draw:drawstart', onDrawStart);
      map.off('draw:drawstop', onDrawStop);
      container.removeEventListener('dblclick', dblClickCapture, true);
      container.removeEventListener('click', clickCapture, true);
      map.removeControl(drawControl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, props.featureGroup, props.mode.zoneType, props.mode.multiplier]);

  return null;
}

export function MapClickHandler(props: {
  onClickLatLng: (lat: number, lng: number) => void;
}) {
  const map = useMap();

  useEffect(() => {
    const onClick = (e: any) => {
      props.onClickLatLng(e.latlng.lat, e.latlng.lng);
    };
    map.on('click', onClick);
    return () => {
      map.off('click', onClick);
    };
  }, [map, props]);

  return null;
}
