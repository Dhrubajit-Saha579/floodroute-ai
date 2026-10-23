'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import MapWrapper from '@/components/MapWrapper';
import type {
  FloodReport,
  HazardSeverity,
  HazardType,
  LatLngTuple,
  ReliefShelter,
} from '@/components/DisasterMap';
import { supabase } from '@/lib/supabase';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                  */
/* -------------------------------------------------------------------------- */

// Approximate position of the DUIET campus (Rajabheta). Replace with a surveyed point.
const DUIET_CAMPUS: { label: string; position: LatLngTuple } = {
  label: 'DUIET Campus',
  position: [27.4228, 94.8826],
};

const OSRM_BASE_URL = 'https://router.project-osrm.org/route/v1/driving';
const FALLBACK_ROUTE_URL = '/cache/fallback-route.json';
const HAZARD_BUFFER_M = 40;
const MAX_SHELTER_CANDIDATES = 3;
const ROUTE_TIMEOUT_MS = 15000;
const MAX_DEPTH_CM = 1000;
const EMPTY_ROUTE: LatLngTuple[] = [];

const HAZARD_TYPE_OPTIONS: { value: HazardType; label: string }[] = [
  { value: 'impassable', label: 'Impassable road / bridge' },
  { value: 'flooded_road', label: 'Flooded road' },
  { value: 'submerged_area', label: 'Submerged area' },
  { value: 'safe_zone', label: 'Safe zone' },
];

const SEVERITY_OPTIONS: { value: HazardSeverity; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
];

/* -------------------------------------------------------------------------- */
/*  Types                                                                      */
/* -------------------------------------------------------------------------- */

type Tone = 'neutral' | 'ok' | 'warn' | 'bad';
type RealtimeState = 'connecting' | 'live' | 'down';
type RouteSource = 'osrm' | 'cache';

type RouteResult = {
  coordinates: LatLngTuple[];
  distanceM: number | null;
  durationS: number | null;
  shelterName: string | null;
  source: RouteSource;
};

type RouteAssessment = {
  blockers: number;
  cautions: number;
};

type OsrmRoute = {
  geometry: { coordinates: [number, number][] };
  distance: number;
  duration: number;
};

type OsrmResponse = {
  code: string;
  routes?: OsrmRoute[];
};

/* -------------------------------------------------------------------------- */
/*  Styling maps (full class strings so Tailwind can see them)                 */
/* -------------------------------------------------------------------------- */

const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'bg-slate-800 text-slate-100 ring-slate-600',
  ok: 'bg-emerald-950/60 text-emerald-200 ring-emerald-600/50',
  warn: 'bg-amber-950/60 text-amber-200 ring-amber-600/50',
  bad: 'bg-red-950/60 text-red-200 ring-red-600/50',
};

const FIELD_CLASS =
  'w-full rounded-md border border-slate-600 bg-slate-800 px-2.5 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-400';

/* -------------------------------------------------------------------------- */
/*  Data helpers                                                               */
/* -------------------------------------------------------------------------- */

function upsertById<T extends { id: string | number }>(list: T[], item: T): T[] {
  const index = list.findIndex((existing) => existing.id === item.id);
  if (index === -1) return [item, ...list];
  const next = list.slice();
  next[index] = item;
  return next;
}

function removeById<T extends { id: string | number }>(list: T[], id: string | number): T[] {
  return list.filter((existing) => existing.id !== id);
}

/** Items already in state (e.g. from realtime) win over freshly fetched rows with the same id. */
function mergeById<T extends { id: string | number }>(loaded: T[], current: T[]): T[] {
  const byId = new Map<string | number, T>();
  loaded.forEach((item) => byId.set(item.id, item));
  current.forEach((item) => byId.set(item.id, item));
  return Array.from(byId.values());
}

function normalizeReport(report: FloodReport): FloodReport {
  return {
    ...report,
    latitude: Number(report.latitude),
    longitude: Number(report.longitude),
    water_depth_cm:
      report.water_depth_cm === null || report.water_depth_cm === undefined
        ? null
        : Number(report.water_depth_cm),
  };
}

function normalizeShelter(shelter: ReliefShelter): ReliefShelter {
  return {
    ...shelter,
    latitude: Number(shelter.latitude),
    longitude: Number(shelter.longitude),
    capacity: Number(shelter.capacity),
    current_occupancy: Number(shelter.current_occupancy),
  };
}

function hasValidCoordinates(item: { latitude: number; longitude: number }): boolean {
  return (
    Number.isFinite(item.latitude) &&
    Number.isFinite(item.longitude) &&
    Math.abs(item.latitude) <= 90 &&
    Math.abs(item.longitude) <= 180
  );
}

function isBlockingHazard(h: Pick<FloodReport, 'hazard_type' | 'severity'>): boolean {
  return h.hazard_type === 'impassable' || h.severity === 'critical';
}

function isShelterAvailable(s: ReliefShelter): boolean {
  return s.status === 'open' && s.current_occupancy < s.capacity;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/* -------------------------------------------------------------------------- */
/*  Geometry                                                                   */
/* -------------------------------------------------------------------------- */

function haversineM(a: LatLngTuple, b: LatLngTuple): number {
  const R = 6371000;
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Distance (m) from point p to segment a-b using a local equirectangular projection around p. */
function pointToSegmentMeters(p: LatLngTuple, a: LatLngTuple, b: LatLngTuple): number {
  const kx = 111320 * Math.cos((p[0] * Math.PI) / 180);
  const ky = 110540;
  const ax = (a[1] - p[1]) * kx;
  const ay = (a[0] - p[0]) * ky;
  const bx = (b[1] - p[1]) * kx;
  const by = (b[0] - p[0]) * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSq));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** Counts impassable ("blockers") and other non-safe ("cautions") hazards within the buffer of the route. */
function assessRoute(coordinates: LatLngTuple[], hazards: FloodReport[]): RouteAssessment {
  let blockers = 0;
  let cautions = 0;
  if (coordinates.length < 2) return { blockers, cautions };

  for (const hazard of hazards) {
    if (hazard.hazard_type === 'safe_zone') continue;
    const point: LatLngTuple = [hazard.latitude, hazard.longitude];
    let near = false;
    for (let i = 0; i < coordinates.length - 1; i += 1) {
      if (pointToSegmentMeters(point, coordinates[i], coordinates[i + 1]) <= HAZARD_BUFFER_M) {
        near = true;
        break;
      }
    }
    if (!near) continue;
    if (isBlockingHazard(hazard)) blockers += 1;
    else cautions += 1;
  }
  return { blockers, cautions };
}

/* -------------------------------------------------------------------------- */
/*  Routing                                                                    */
/* -------------------------------------------------------------------------- */

async function fetchOsrmRoutes(from: LatLngTuple, to: LatLngTuple, signal: AbortSignal): Promise<RouteResult[]> {
  const url =
    `${OSRM_BASE_URL}/${from[1]},${from[0]};${to[1]},${to[0]}` +
    '?overview=full&geometries=geojson&alternatives=true';
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Routing service returned ${response.status}`);

  const json = (await response.json()) as OsrmResponse;
  if (json.code !== 'Ok' || !json.routes || json.routes.length === 0) {
    throw new Error('No drivable route found');
  }

  return json.routes.map((route) => ({
    coordinates: route.geometry.coordinates.map(([lng, lat]): LatLngTuple => [lat, lng]),
    distanceM: route.distance,
    durationS: route.duration,
    shelterName: null,
    source: 'osrm',
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumberPair(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number';
}

function coordinatePairs(value: unknown, order: 'latlng' | 'lnglat'): LatLngTuple[] | null {
  if (!Array.isArray(value)) return null;
  const out: LatLngTuple[] = [];
  for (const item of value) {
    if (!isNumberPair(item)) return null;
    out.push(order === 'latlng' ? [item[0], item[1]] : [item[1], item[0]]);
  }
  return out.length >= 2 ? out : null;
}

/**
 * Accepts either:
 *  - { "coordinates": [[lat, lng], ...], "distance_m"?, "duration_s"?, "shelter_name"? }
 *  - a GeoJSON LineString, or Feature<LineString> (coordinates are [lng, lat]; extra fields read from `properties`)
 */
function parseFallbackRoute(data: unknown): RouteResult | null {
  if (!isRecord(data)) return null;

  let coordinates: LatLngTuple[] | null;
  let props: Record<string, unknown> = data;

  if (data.type === 'Feature' && isRecord(data.geometry)) {
    coordinates = coordinatePairs(data.geometry.coordinates, 'lnglat');
    props = isRecord(data.properties) ? data.properties : {};
  } else if (data.type === 'LineString') {
    coordinates = coordinatePairs(data.coordinates, 'lnglat');
  } else {
    coordinates = coordinatePairs(data.coordinates, 'latlng');
  }
  if (!coordinates) return null;

  return {
    coordinates,
    distanceM: typeof props.distance_m === 'number' ? props.distance_m : null,
    durationS: typeof props.duration_s === 'number' ? props.duration_s : null,
    shelterName: typeof props.shelter_name === 'string' ? props.shelter_name : null,
    source: 'cache',
  };
}

/* -------------------------------------------------------------------------- */
/*  Status description                                                         */
/* -------------------------------------------------------------------------- */

function describeConnectivity(input: {
  loading: boolean;
  error: string | null;
  route: RouteResult | null;
  assessment: RouteAssessment;
  offlineMode: boolean;
}): { label: string; detail: string; tone: Tone } {
  const { loading, error, route, assessment, offlineMode } = input;

  if (loading) {
    return { label: 'Routing…', detail: 'Calculating the safest route to the nearest open shelter.', tone: 'neutral' };
  }
  if (error) return { label: 'Failed', detail: error, tone: 'bad' };
  if (!route) {
    return {
      label: offlineMode ? 'Cache ready' : 'Idle',
      detail: offlineMode
        ? 'Offline simulation on: routes load from the cached fallback file.'
        : 'No route calculated yet.',
      tone: 'neutral',
    };
  }
  if (assessment.blockers > 0) {
    return {
      label: 'Blocked',
      detail: `${plural(assessment.blockers, 'impassable hazard')} on the active route. Recalculate to find another way.`,
      tone: 'bad',
    };
  }
  if (assessment.cautions > 0) {
    return {
      label: 'Caution',
      detail: `Passable, but ${plural(assessment.cautions, 'flood hazard')} reported along the route.`,
      tone: 'warn',
    };
  }
  return {
    label: route.source === 'cache' ? 'Cached' : 'Clear',
    detail:
      route.source === 'cache'
        ? 'Cached route shows no reported hazards on its path.'
        : 'No reported hazards on the active route.',
    tone: 'ok',
  };
}

/* -------------------------------------------------------------------------- */
/*  Small UI components                                                        */
/* -------------------------------------------------------------------------- */

function StatTile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone: Tone }) {
  return (
    <div className={`rounded-lg px-3 py-2 ring-1 ring-inset ${TONE_CLASSES[tone]}`}>
      <div className="text-[10px] font-semibold uppercase tracking-wide opacity-80">{label}</div>
      <div className="text-lg font-bold leading-tight">{value}</div>
      {sub ? <div className="text-[11px] opacity-80">{sub}</div> : null}
    </div>
  );
}

function RealtimeBadge({ state }: { state: RealtimeState }) {
  const config: Record<RealtimeState, { dot: string; text: string }> = {
    connecting: { dot: 'bg-amber-400', text: 'Connecting' },
    live: { dot: 'bg-emerald-400', text: 'Live' },
    down: { dot: 'bg-red-500', text: 'Disconnected' },
  };
  const { dot, text } = config[state];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-slate-200 ring-1 ring-slate-600">
      <span className={`h-2 w-2 rounded-full ${dot} ${state === 'live' ? 'animate-pulse' : ''}`} aria-hidden="true" />
      {text}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                       */
/* -------------------------------------------------------------------------- */

export default function CommandConsolePage() {
  /* ---- Data ---- */
  const [hazards, setHazards] = useState<FloodReport[]>([]);
  const [shelters, setShelters] = useState<ReliefShelter[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [realtime, setRealtime] = useState<RealtimeState>('connecting');

  /* ---- Routing ---- */
  const [route, setRoute] = useState<RouteResult | null>(null);
  const [routeLoading, setRouteLoading] = useState<boolean>(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [offlineMode, setOfflineMode] = useState<boolean>(false);
  const abortRef = useRef<AbortController | null>(null);

  /* ---- UI ---- */
  const [panelOpen, setPanelOpen] = useState<boolean>(true);
  const [reportOpen, setReportOpen] = useState<boolean>(false);
  const [toast, setToast] = useState<string | null>(null);

  /* ---- Report form ---- */
  const [draftLocation, setDraftLocation] = useState<LatLngTuple | null>(null);
  const [hazardType, setHazardType] = useState<HazardType>('flooded_road');
  const [severity, setSeverity] = useState<HazardSeverity>('high');
  const [depthInput, setDepthInput] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [formError, setFormError] = useState<string | null>(null);

  /* ------------------------------------------------------------------------ */
  /*  Initial fetch                                                            */
  /* ------------------------------------------------------------------------ */
  useEffect(() => {
    let cancelled = false;

    async function loadInitialData(): Promise<void> {
      try {
        const [reportsResult, sheltersResult] = await Promise.all([
          supabase.from('flood_reports').select('*'),
          supabase.from('relief_shelters').select('*'),
        ]);
        if (cancelled) return;

        const firstError = reportsResult.error ?? sheltersResult.error;
        if (firstError) setLoadError(firstError.message);

        if (reportsResult.data) {
          const loaded = (reportsResult.data as FloodReport[]).map(normalizeReport);
          setHazards((current) => mergeById(loaded, current));
        }
        if (sheltersResult.data) {
          const loaded = (sheltersResult.data as ReliefShelter[]).map(normalizeShelter);
          setShelters((current) => mergeById(loaded, current));
        }
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load data');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void loadInitialData();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ------------------------------------------------------------------------ */
  /*  Realtime subscription                                                    */
  /* ------------------------------------------------------------------------ */
  useEffect(() => {
    const channel = supabase
      .channel('ps-s01-live')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'flood_reports' },
        (payload: RealtimePostgresChangesPayload<FloodReport>) => {
          if (payload.eventType === 'DELETE') {
            const deletedId = payload.old.id;
            if (deletedId !== undefined) setHazards((current) => removeById(current, deletedId));
            return;
          }
          const incoming = normalizeReport(payload.new);
          setHazards((current) => upsertById(current, incoming));
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'relief_shelters' },
        (payload: RealtimePostgresChangesPayload<ReliefShelter>) => {
          if (payload.eventType === 'DELETE') {
            const deletedId = payload.old.id;
            if (deletedId !== undefined) setShelters((current) => removeById(current, deletedId));
            return;
          }
          const incoming = normalizeShelter(payload.new);
          setShelters((current) => upsertById(current, incoming));
        },
      )
      .subscribe((status) => {
        const state: string = status;
        if (state === 'SUBSCRIBED') setRealtime('live');
        else if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT' || state === 'CLOSED') setRealtime('down');
        else setRealtime('connecting');
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, []);

  /* ---- Housekeeping effects ---- */
  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  /* ------------------------------------------------------------------------ */
  /*  Derived state                                                            */
  /* ------------------------------------------------------------------------ */
  const mappableHazards = useMemo(() => hazards.filter(hasValidCoordinates), [hazards]);
  const mappableShelters = useMemo(() => shelters.filter(hasValidCoordinates), [shelters]);

  const hazardStats = useMemo(() => {
    const active = mappableHazards.filter((h) => h.hazard_type !== 'safe_zone');
    return { active: active.length, blocking: active.filter(isBlockingHazard).length };
  }, [mappableHazards]);

  const shelterStats = useMemo(() => {
    let free = 0;
    let total = 0;
    let openCount = 0;
    for (const shelter of mappableShelters) {
      if (shelter.status !== 'open') continue;
      openCount += 1;
      total += shelter.capacity;
      free += Math.max(0, shelter.capacity - shelter.current_occupancy);
    }
    return { free, total, openCount };
  }, [mappableShelters]);

  const routeCoordinates = useMemo<LatLngTuple[]>(() => route?.coordinates ?? EMPTY_ROUTE, [route]);

  // Re-evaluated live: a new realtime hazard on the active route flips the status to "Blocked".
  const assessment = useMemo<RouteAssessment>(
    () => (route ? assessRoute(route.coordinates, mappableHazards) : { blockers: 0, cautions: 0 }),
    [route, mappableHazards],
  );

  const connectivity = describeConnectivity({
    loading: routeLoading,
    error: routeError,
    route,
    assessment,
    offlineMode,
  });

  const hazardTone: Tone = hazardStats.blocking > 0 ? 'bad' : hazardStats.active > 0 ? 'warn' : 'ok';
  const capacityTone: Tone =
    shelterStats.openCount === 0 || shelterStats.free === 0
      ? 'bad'
      : shelterStats.free / Math.max(1, shelterStats.total) < 0.2
        ? 'warn'
        : 'ok';

  /* ------------------------------------------------------------------------ */
  /*  Route calculation                                                        */
  /* ------------------------------------------------------------------------ */
  const calculateRoute = useCallback(async (): Promise<void> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), ROUTE_TIMEOUT_MS);

    setRouteError(null);
    setRouteLoading(true);

    try {
      if (offlineMode) {
        const response = await fetch(FALLBACK_ROUTE_URL, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error(`Cached route unavailable (${response.status})`);
        const parsed = parseFallbackRoute((await response.json()) as unknown);
        if (!parsed) throw new Error('Cached route file has an unrecognised format');
        setRoute(parsed);
        return;
      }

      const origin = DUIET_CAMPUS.position;
      const candidates = mappableShelters
        .filter(isShelterAvailable)
        .map((shelter) => ({ shelter, distance: haversineM(origin, [shelter.latitude, shelter.longitude]) }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, MAX_SHELTER_CANDIDATES);

      if (candidates.length === 0) throw new Error('No open shelter with free capacity');

      let blockedFallback: RouteResult | null = null;

      for (const { shelter } of candidates) {
        const routes = await fetchOsrmRoutes(origin, [shelter.latitude, shelter.longitude], controller.signal);
        const scored = routes.map((candidate) => {
          const named: RouteResult = { ...candidate, shelterName: shelter.name };
          return { route: named, assessment: assessRoute(named.coordinates, mappableHazards) };
        });

        // Prefer routes with no impassable hazards, then fewer cautions, then shortest travel time.
        const clear = scored
          .filter((item) => item.assessment.blockers === 0)
          .sort(
            (a, b) =>
              a.assessment.cautions - b.assessment.cautions ||
              (a.route.durationS ?? 0) - (b.route.durationS ?? 0),
          )[0];

        if (clear) {
          setRoute(clear.route);
          return;
        }
        if (blockedFallback === null) blockedFallback = scored[0].route;
      }

      // Every candidate crosses an impassable hazard: show the nearest one so responders can see why it is blocked.
      if (blockedFallback) setRoute(blockedFallback);
    } catch (err) {
      if (abortRef.current !== controller) return; // superseded by a newer request
      const message =
        err instanceof DOMException && err.name === 'AbortError'
          ? 'Routing request timed out'
          : err instanceof Error
            ? err.message
            : 'Route calculation failed';
      setRouteError(message);
    } finally {
      window.clearTimeout(timeout);
      if (abortRef.current === controller) setRouteLoading(false);
    }
  }, [offlineMode, mappableShelters, mappableHazards]);

  const handleOfflineToggle = useCallback((): void => {
    abortRef.current?.abort();
    setOfflineMode((current) => !current);
    setRoute(null);
    setRouteError(null);
    setRouteLoading(false);
  }, []);

  /* ------------------------------------------------------------------------ */
  /*  Reporting                                                                */
  /* ------------------------------------------------------------------------ */
  const handleMapClick = useCallback((lat: number, lng: number): void => {
    setDraftLocation([lat, lng]);
    setFormError(null);
  }, []);

  const handleUseGps = useCallback((): void => {
    if (!('geolocation' in navigator)) {
      setFormError('Geolocation is not supported on this device.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setDraftLocation([position.coords.latitude, position.coords.longitude]);
        setFormError(null);
      },
      () => setFormError('Could not read your GPS position. Tap the map instead.'),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }, []);

  const resetReportForm = useCallback((): void => {
    setDraftLocation(null);
    setHazardType('flooded_road');
    setSeverity('high');
    setDepthInput('');
    setDescription('');
    setFormError(null);
  }, []);

  const toggleReport = useCallback((): void => {
    setReportOpen((open) => {
      if (open) resetReportForm();
      return !open;
    });
  }, [resetReportForm]);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      setFormError(null);

      if (!draftLocation) {
        setFormError('Tap the map or use GPS to set the hazard location.');
        return;
      }
      const depth = Number(depthInput);
      if (depthInput.trim() === '' || !Number.isFinite(depth) || depth < 0 || depth > MAX_DEPTH_CM) {
        setFormError(`Enter a water depth between 0 and ${MAX_DEPTH_CM} cm.`);
        return;
      }

      setSubmitting(true);
      try {
        const trimmed = description.trim().slice(0, 500);
        const { data, error } = await supabase
          .from('flood_reports')
          .insert({
            latitude: draftLocation[0],
            longitude: draftLocation[1],
            hazard_type: hazardType,
            severity,
            water_depth_cm: depth,
            description: trimmed === '' ? null : trimmed,
          })
          .select()
          .single();

        if (error) throw new Error(error.message);
        if (data) setHazards((current) => upsertById(current, normalizeReport(data as FloodReport)));

        resetReportForm();
        setReportOpen(false);
        setToast('Report submitted. All responders can see it now.');
      } catch (err) {
        setFormError(err instanceof Error ? err.message : 'Failed to submit report');
      } finally {
        setSubmitting(false);
      }
    },
    [draftLocation, depthInput, description, hazardType, severity, resetReportForm],
  );

  /* ------------------------------------------------------------------------ */
  /*  Render                                                                   */
  /* ------------------------------------------------------------------------ */
  const routeSummary = route
    ? [
        route.shelterName ?? 'Nearest open shelter',
        route.distanceM === null ? null : `${(route.distanceM / 1000).toFixed(1)} km`,
        route.durationS === null ? null : `${Math.max(1, Math.round(route.durationS / 60))} min`,
        route.source === 'cache' ? 'cached' : null,
      ]
        .filter((part): part is string => part !== null)
        .join(' · ')
    : null;

  return (
    <main className="relative h-screen w-full overflow-hidden bg-slate-950">
      <div className="absolute inset-0">
        <MapWrapper
          hazards={mappableHazards}
          shelters={mappableShelters}
          routeCoordinates={routeCoordinates}
          onMapClick={reportOpen ? handleMapClick : undefined}
          draftLocation={draftLocation}
          origin={DUIET_CAMPUS}
        />
      </div>

      <aside className="pointer-events-none absolute inset-x-3 top-3 z-[1000] max-h-[calc(100vh-1.5rem)] overflow-y-auto sm:inset-x-auto sm:left-3 sm:w-96">
        <div className="pointer-events-auto rounded-xl bg-slate-900/95 p-3 text-slate-100 shadow-2xl ring-1 ring-slate-700 backdrop-blur">
          {/* Header */}
          <div className="flex items-start justify-between gap-2">
            <div>
              <h1 className="text-sm font-bold tracking-wide">PS-S01 · Flood Relief Command</h1>
              <p className="text-[11px] text-slate-400">Dibrugarh, Assam</p>
            </div>
            <div className="flex items-center gap-2">
              <RealtimeBadge state={realtime} />
              <button
                type="button"
                onClick={() => setPanelOpen((open) => !open)}
                aria-expanded={panelOpen}
                aria-label={panelOpen ? 'Collapse control panel' : 'Expand control panel'}
                className="rounded-md px-2 py-1 text-xs font-semibold text-slate-300 ring-1 ring-slate-600 hover:bg-slate-800"
              >
                {panelOpen ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>

          {panelOpen ? (
            <div className="mt-3 space-y-3">
              {loadError ? (
                <p role="alert" className="rounded-md bg-red-950/60 px-3 py-2 text-xs text-red-200 ring-1 ring-red-600/50">
                  Data load issue: {loadError}
                </p>
              ) : null}

              {/* Status bar */}
              <div className="grid grid-cols-3 gap-2" aria-busy={isLoading}>
                <StatTile
                  label="Active hazards"
                  value={isLoading ? '…' : String(hazardStats.active)}
                  sub={hazardStats.blocking > 0 ? `${hazardStats.blocking} impassable` : 'none impassable'}
                  tone={hazardTone}
                />
                <StatTile
                  label="Open capacity"
                  value={isLoading ? '…' : `${shelterStats.free}`}
                  sub={`of ${shelterStats.total} · ${plural(shelterStats.openCount, 'shelter')}`}
                  tone={capacityTone}
                />
                <StatTile label="Route" value={connectivity.label} sub={offlineMode ? 'offline sim' : 'live'} tone={connectivity.tone} />
              </div>

              <div role="status" aria-live="polite" className="space-y-0.5 text-xs">
                <p className="text-slate-300">{connectivity.detail}</p>
                {routeSummary ? <p className="font-medium text-cyan-300">{routeSummary}</p> : null}
              </div>

              {/* Controls */}
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => void calculateRoute()}
                  disabled={routeLoading}
                  className="w-full rounded-lg bg-cyan-500 px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {routeLoading ? 'Calculating…' : 'Route: DUIET Campus → nearest open shelter'}
                </button>

                <button
                  type="button"
                  onClick={toggleReport}
                  aria-expanded={reportOpen}
                  className={`w-full rounded-lg px-3 py-2 text-sm font-semibold ring-1 ring-inset ${
                    reportOpen
                      ? 'bg-slate-800 text-slate-100 ring-slate-500 hover:bg-slate-700'
                      : 'bg-red-600 text-white ring-red-500 hover:bg-red-500'
                  }`}
                >
                  {reportOpen ? 'Cancel report' : 'Report hazard'}
                </button>

                <div className="flex items-center justify-between rounded-lg bg-slate-800 px-3 py-2 ring-1 ring-slate-600">
                  <div>
                    <div id="offline-label" className="text-sm font-medium">
                      Offline simulation
                    </div>
                    <div className="text-[11px] text-slate-400">Routing reads {FALLBACK_ROUTE_URL}</div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={offlineMode}
                    aria-labelledby="offline-label"
                    onClick={handleOfflineToggle}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                      offlineMode ? 'bg-amber-500' : 'bg-slate-600'
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
                        offlineMode ? 'left-[1.375rem]' : 'left-0.5'
                      }`}
                    />
                  </button>
                </div>
              </div>

              {/* Report form */}
              {reportOpen ? (
                <form onSubmit={(event) => void handleSubmit(event)} className="space-y-2.5 rounded-lg bg-slate-800/80 p-3 ring-1 ring-slate-600">
                  <h2 className="text-sm font-semibold">Quick emergency report</h2>

                  <div className="rounded-md bg-slate-900 px-2.5 py-2 text-xs ring-1 ring-slate-700">
                    {draftLocation ? (
                      <span className="text-emerald-300">
                        Location set: {draftLocation[0].toFixed(5)}, {draftLocation[1].toFixed(5)}
                      </span>
                    ) : (
                      <span className="text-amber-300">Tap the map to drop the hazard pin.</span>
                    )}
                    <button type="button" onClick={handleUseGps} className="ml-2 font-semibold text-cyan-300 underline">
                      Use my GPS
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <label className="block text-xs">
                      <span className="mb-1 block text-slate-300">Hazard type</span>
                      <select
                        className={FIELD_CLASS}
                        value={hazardType}
                        onChange={(event) => setHazardType(event.target.value as HazardType)}
                      >
                        {HAZARD_TYPE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block text-xs">
                      <span className="mb-1 block text-slate-300">Severity</span>
                      <select
                        className={FIELD_CLASS}
                        value={severity}
                        onChange={(event) => setSeverity(event.target.value as HazardSeverity)}
                      >
                        {SEVERITY_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <label className="block text-xs">
                    <span className="mb-1 block text-slate-300">Water depth (cm)</span>
                    <input
                      className={FIELD_CLASS}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={MAX_DEPTH_CM}
                      step={1}
                      placeholder="e.g. 45"
                      value={depthInput}
                      onChange={(event) => setDepthInput(event.target.value)}
                    />
                  </label>

                  <label className="block text-xs">
                    <span className="mb-1 block text-slate-300">Notes (optional)</span>
                    <textarea
                      className={`${FIELD_CLASS} resize-none`}
                      rows={2}
                      maxLength={500}
                      placeholder="Landmark, vehicles stranded, etc."
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                    />
                  </label>

                  {formError ? (
                    <p role="alert" className="text-xs text-red-300">
                      {formError}
                    </p>
                  ) : null}

                  <button
                    type="submit"
                    disabled={submitting}
                    className="w-full rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {submitting ? 'Submitting…' : 'Submit report'}
                  </button>
                </form>
              ) : null}
            </div>
          ) : null}
        </div>
      </aside>

      {toast ? (
        <div
          role="status"
          className="pointer-events-none absolute bottom-6 left-1/2 z-[1000] -translate-x-1/2 rounded-full bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-lg"
        >
          {toast}
        </div>
      ) : null}
    </main>
  );
}