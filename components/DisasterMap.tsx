'use client';

import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { useEffect } from 'react';
import {
  MapContainer,
  Marker,
  Polyline,
  Popup,
  TileLayer,
  ZoomControl,
  useMap,
  useMapEvents,
} from 'react-leaflet';

/* -------------------------------------------------------------------------- */
/*  Types (shared with app/page.tsx via `import type`)                         */
/* -------------------------------------------------------------------------- */

export type LatLngTuple = [number, number];

export type HazardType = 'impassable' | 'flooded_road' | 'submerged_area' | 'safe_zone';
export type HazardSeverity = 'low' | 'medium' | 'high' | 'critical';
export type ShelterStatus = 'open' | 'full' | 'closed';

export type FloodReport = {
  id: string | number;
  latitude: number;
  longitude: number;
  hazard_type: HazardType;
  severity: HazardSeverity;
  water_depth_cm: number | null;
  description: string | null;
  created_at?: string;
};

export type ReliefShelter = {
  id: string | number;
  name: string;
  capacity: number;
  current_occupancy: number;
  latitude: number;
  longitude: number;
  status: ShelterStatus;
};

export type MapOrigin = {
  label: string;
  position: LatLngTuple;
};

export type DisasterMapProps = {
  hazards: FloodReport[];
  shelters: ReliefShelter[];
  routeCoordinates: LatLngTuple[];
  /** When provided, clicking the map calls this with the clicked coordinates. */
  onMapClick?: (lat: number, lng: number) => void;
  /** Pending (not yet submitted) hazard location. */
  draftLocation?: LatLngTuple | null;
  /** Route start point (e.g. DUIET Campus). */
  origin?: MapOrigin | null;
};

/* -------------------------------------------------------------------------- */
/*  Leaflet default-icon fix (bundlers rewrite the asset paths -> 404)         */
/* -------------------------------------------------------------------------- */

const LEAFLET_CDN_IMAGES = 'https://unpkg.com/leaflet@1.9.4/dist/images/';

delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: `${LEAFLET_CDN_IMAGES}marker-icon-2x.png`,
  iconUrl: `${LEAFLET_CDN_IMAGES}marker-icon.png`,
  shadowUrl: `${LEAFLET_CDN_IMAGES}marker-shadow.png`,
});

/* -------------------------------------------------------------------------- */
/*  Constants                                                                  */
/* -------------------------------------------------------------------------- */

const DIBRUGARH_CENTER: LatLngTuple = [27.4728, 94.912];
const DEFAULT_ZOOM = 13;

const COLORS = {
  impassable: '#dc2626',
  caution: '#f59e0b',
  safe: '#2563eb',
  shelterOpen: '#16a34a',
  shelterUnavailable: '#64748b',
  origin: '#7c3aed',
  draft: '#db2777',
  routeCasing: '#083344',
  route: '#06b6d4',
} as const;

const HOUSE_SVG =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="#ffffff" aria-hidden="true"><path d="M12 3 2 12h3v8h5v-5h4v5h5v-8h3z"/></svg>';

/* -------------------------------------------------------------------------- */
/*  Icons (divIcon => no image assets, no 404s)                                */
/* -------------------------------------------------------------------------- */

const iconCache = new Map<string, L.DivIcon>();

function cachedIcon(background: string, glyphHtml: string, textColor = '#ffffff', size = 30): L.DivIcon {
  const key = `${background}|${glyphHtml}|${textColor}|${size}`;
  const existing = iconCache.get(key);
  if (existing) return existing;

  const icon = L.divIcon({
    className: '',
    html:
      `<div style="width:${size}px;height:${size}px;border-radius:9999px;background:${background};` +
      `border:3px solid #ffffff;box-shadow:0 2px 8px rgba(0,0,0,0.45);display:flex;align-items:center;` +
      `justify-content:center;color:${textColor};font:700 15px/1 system-ui,sans-serif;">${glyphHtml}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
  iconCache.set(key, icon);
  return icon;
}

function isBlockingHazard(h: Pick<FloodReport, 'hazard_type' | 'severity'>): boolean {
  return h.hazard_type === 'impassable' || h.severity === 'critical';
}

function hazardColor(h: Pick<FloodReport, 'hazard_type' | 'severity'>): string {
  if (h.hazard_type === 'safe_zone') return COLORS.safe;
  return isBlockingHazard(h) ? COLORS.impassable : COLORS.caution;
}

function hazardIcon(h: FloodReport): L.DivIcon {
  if (h.hazard_type === 'safe_zone') return cachedIcon(COLORS.safe, '&#10003;');
  if (isBlockingHazard(h)) return cachedIcon(COLORS.impassable, '&#10005;', '#ffffff', 34);
  return cachedIcon(COLORS.caution, '!', '#1f2937');
}

function shelterIcon(s: ReliefShelter): L.DivIcon {
  const available = s.status === 'open' && s.current_occupancy < s.capacity;
  return cachedIcon(available ? COLORS.shelterOpen : COLORS.shelterUnavailable, HOUSE_SVG, '#ffffff', 34);
}

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function humanize(value: string): string {
  return value.replace(/_/g, ' ');
}

function formatTimestamp(iso?: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString('en-IN');
}

function occupancyPercent(s: Pick<ReliefShelter, 'capacity' | 'current_occupancy'>): number {
  if (s.capacity <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((s.current_occupancy / s.capacity) * 100)));
}

/* -------------------------------------------------------------------------- */
/*  Map helper components (must be children of MapContainer)                   */
/* -------------------------------------------------------------------------- */

function ClickHandler({ onMapClick }: { onMapClick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(event) {
      onMapClick(event.latlng.lat, event.latlng.lng);
    },
  });
  return null;
}

function RouteFitter({ coordinates }: { coordinates: LatLngTuple[] }) {
  const map = useMap();

  useEffect(() => {
    if (coordinates.length < 2) return;
    map.fitBounds(L.latLngBounds(coordinates), { padding: [64, 64], maxZoom: 16 });
  }, [coordinates, map]);

  return null;
}

/* -------------------------------------------------------------------------- */
/*  Popups                                                                     */
/* -------------------------------------------------------------------------- */

function HazardPopup({ hazard }: { hazard: FloodReport }) {
  const color = hazardColor(hazard);
  const reported = formatTimestamp(hazard.created_at);

  return (
    <div className="min-w-[210px] space-y-1.5 text-sm text-slate-800">
      <div className="flex items-center gap-2 font-semibold capitalize">
        <span
          className="inline-block h-3 w-3 rounded-full"
          style={{ backgroundColor: color }}
          aria-hidden="true"
        />
        {humanize(hazard.hazard_type)}
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-slate-500">Severity</span>
        <span className="font-medium capitalize">{hazard.severity}</span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-slate-500">Water depth</span>
        <span className="font-medium">
          {hazard.water_depth_cm === null ? 'Unknown' : `${hazard.water_depth_cm} cm`}
        </span>
      </div>
      {hazard.description ? <p className="pt-1 text-slate-700">{hazard.description}</p> : null}
      {reported ? <p className="pt-1 text-xs text-slate-500">Reported {reported}</p> : null}
    </div>
  );
}

function ShelterPopup({ shelter }: { shelter: ReliefShelter }) {
  const pct = occupancyPercent(shelter);
  const barColor = pct >= 90 ? '#dc2626' : pct >= 70 ? '#f59e0b' : '#16a34a';
  const free = Math.max(0, shelter.capacity - shelter.current_occupancy);

  return (
    <div className="min-w-[220px] space-y-2 text-sm text-slate-800">
      <div className="font-semibold">{shelter.name}</div>
      <div className="flex justify-between gap-4">
        <span className="text-slate-500">Status</span>
        <span className="font-medium capitalize">{shelter.status}</span>
      </div>
      <div>
        <div className="mb-1 flex justify-between text-xs text-slate-600">
          <span>
            {shelter.current_occupancy} / {shelter.capacity} occupied
          </span>
          <span>{pct}%</span>
        </div>
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-slate-200"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label={`${shelter.name} occupancy`}
        >
          <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: barColor }} />
        </div>
        <div className="mt-1 text-xs text-slate-500">{free} places free</div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Legend                                                                     */
/* -------------------------------------------------------------------------- */

function Legend() {
  const items: { color: string; label: string }[] = [
    { color: COLORS.impassable, label: 'Impassable / critical' },
    { color: COLORS.caution, label: 'High / medium hazard' },
    { color: COLORS.safe, label: 'Safe zone' },
    { color: COLORS.shelterOpen, label: 'Open shelter' },
    { color: COLORS.shelterUnavailable, label: 'Full / closed shelter' },
    { color: COLORS.route, label: 'Relief route' },
  ];

  return (
    <div className="pointer-events-none absolute bottom-6 left-3 z-[1000] hidden rounded-lg bg-white/90 px-3 py-2 text-xs text-slate-700 shadow-lg backdrop-blur sm:block">
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item.label} className="flex items-center gap-2">
            <span
              className="inline-block h-3 w-3 rounded-full ring-2 ring-white"
              style={{ backgroundColor: item.color }}
              aria-hidden="true"
            />
            {item.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Main component                                                             */
/* -------------------------------------------------------------------------- */

export default function DisasterMap({
  hazards,
  shelters,
  routeCoordinates,
  onMapClick,
  draftLocation = null,
  origin = null,
}: DisasterMapProps) {
  return (
    <div className="relative h-full w-full">
      <MapContainer
        center={DIBRUGARH_CENTER}
        zoom={DEFAULT_ZOOM}
        zoomControl={false}
        scrollWheelZoom
        style={{ height: '100%', width: '100%' }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          maxZoom={19}
        />
        <ZoomControl position="bottomright" />

        {onMapClick ? <ClickHandler onMapClick={onMapClick} /> : null}
        <RouteFitter coordinates={routeCoordinates} />

        {routeCoordinates.length >= 2 ? (
          <>
            {/* Dark casing underneath keeps the cyan line readable on any tile colour */}
            <Polyline
              positions={routeCoordinates}
              pathOptions={{ color: COLORS.routeCasing, weight: 10, opacity: 0.85, lineCap: 'round', lineJoin: 'round' }}
            />
            <Polyline
              positions={routeCoordinates}
              pathOptions={{ color: COLORS.route, weight: 5, opacity: 1, lineCap: 'round', lineJoin: 'round' }}
            />
          </>
        ) : null}

        {hazards.map((hazard) => (
          <Marker
            key={`hazard-${hazard.id}`}
            position={[hazard.latitude, hazard.longitude]}
            icon={hazardIcon(hazard)}
            title={`${humanize(hazard.hazard_type)} (${hazard.severity})`}
            zIndexOffset={isBlockingHazard(hazard) ? 1000 : 0}
            riseOnHover
          >
            <Popup>
              <HazardPopup hazard={hazard} />
            </Popup>
          </Marker>
        ))}

        {shelters.map((shelter) => (
          <Marker
            key={`shelter-${shelter.id}`}
            position={[shelter.latitude, shelter.longitude]}
            icon={shelterIcon(shelter)}
            title={shelter.name}
            zIndexOffset={500}
            riseOnHover
          >
            <Popup>
              <ShelterPopup shelter={shelter} />
            </Popup>
          </Marker>
        ))}

        {origin ? (
          <Marker
            position={origin.position}
            icon={cachedIcon(COLORS.origin, 'A', '#ffffff', 34)}
            title={origin.label}
            zIndexOffset={800}
          >
            <Popup>
              <div className="text-sm font-semibold text-slate-800">{origin.label}</div>
              <div className="text-xs text-slate-500">Route origin</div>
            </Popup>
          </Marker>
        ) : null}

        {draftLocation ? (
          <Marker
            position={draftLocation}
            icon={cachedIcon(COLORS.draft, '+', '#ffffff', 34)}
            title="New hazard location"
            zIndexOffset={1200}
          />
        ) : null}
      </MapContainer>

      <Legend />
    </div>
  );
}