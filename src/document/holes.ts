// Agujeros: centros a partir de un sketch y medidas típicas para impresión 3D.
import type { HoleFeature, SketchData } from './types';

/**
 * Centros de agujero de un sketch: los puntos sueltos (que no son extremo ni centro de ninguna
 * curva) y los centros de los círculos que no son de construcción.
 */
export function holeCenters(data: SketchData): { id: string; pos: [number, number] }[] {
  const used = new Set<string>();
  const centers: string[] = [];
  for (const e of data.entities) {
    if (e.type === 'line') used.add(e.p1).add(e.p2);
    else if (e.type === 'arc') used.add(e.center).add(e.start).add(e.end);
    else if (e.type === 'circle') {
      used.add(e.center);
      if (!e.construction) centers.push(e.center);
    }
  }
  const points = new Map(data.entities.filter((e) => e.type === 'point').map((p) => [p.id, p as { x: number; y: number }]));
  const ids = [...data.entities.filter((e) => e.type === 'point' && !used.has(e.id)).map((e) => e.id), ...centers];
  return [...new Set(ids)].flatMap((id) => {
    const p = points.get(id);
    return p ? [{ id, pos: [p.x, p.y] as [number, number] }] : [];
  });
}

export type HolePresetGroup = 'clearance' | 'counterbore' | 'countersink' | 'insert' | 'tap';

export interface HolePreset {
  id: string;
  group: HolePresetGroup;
  label: string;
  /** Campos que fija el preset (el resto queda como estaba). */
  values: Partial<Pick<HoleFeature, 'kind' | 'diameter' | 'depth' | 'extent' | 'tip' | 'cbDiameter' | 'cbDepth' | 'csDiameter' | 'csAngle'>>;
}

export const PRESET_GROUPS: Record<HolePresetGroup, string> = {
  clearance: 'Paso libre para tornillo',
  counterbore: 'Cajeado para cabeza Allen (DIN 912)',
  countersink: 'Avellanado para cabeza plana (DIN 7991)',
  insert: 'Inserto roscado térmico',
  tap: 'Rosca en el plástico (atornillar directo)',
};

const SIZES = ['M2', 'M2.5', 'M3', 'M4', 'M5', 'M6', 'M8'] as const;
/** Paso libre normal (ISO 273, serie media). */
const CLEARANCE: Record<(typeof SIZES)[number], number> = { M2: 2.4, 'M2.5': 2.9, M3: 3.4, M4: 4.5, M5: 5.5, M6: 6.6, M8: 9 };
/** Alojamiento de cabeza cilíndrica Allen: diámetro y profundidad, con un poco de juego. */
const COUNTERBORE: Record<(typeof SIZES)[number], [number, number]> = {
  M2: [4.4, 2.2], 'M2.5': [5.5, 2.7], M3: [6.5, 3.3], M4: [8, 4.4], M5: [9.5, 5.4], M6: [11, 6.4], M8: [14.5, 8.6],
};
/** Diámetro de la cabeza avellanada a 90°. */
const COUNTERSINK: Record<(typeof SIZES)[number], number> = { M2: 4.4, 'M2.5': 5.5, M3: 6.7, M4: 9, M5: 11.2, M6: 13.4, M8: 17.9 };
/** Insertos térmicos de bronce (versión corta): agujero y profundidad orientativos; confirmá con el fabricante. */
const INSERT: Partial<Record<(typeof SIZES)[number], [number, number]>> = {
  M2: [3.2, 4], 'M2.5': [3.6, 4.5], M3: [4, 5.7], M4: [5.6, 8.1], M5: [6.4, 9.5], M6: [8, 12.7],
};
/** Agujero piloto para que el tornillo haga la rosca en el plástico. */
const TAP: Partial<Record<(typeof SIZES)[number], number>> = { M2: 1.6, 'M2.5': 2.1, M3: 2.5, M4: 3.3, M5: 4.2, M6: 5 };

export const HOLE_PRESETS: HolePreset[] = [
  ...SIZES.map((s): HolePreset => ({
    id: `clearance-${s}`, group: 'clearance', label: `${s} · Ø${CLEARANCE[s]}`,
    values: { kind: 'simple', diameter: CLEARANCE[s], extent: 'through' },
  })),
  ...SIZES.map((s): HolePreset => ({
    id: `counterbore-${s}`, group: 'counterbore', label: `${s} · Ø${CLEARANCE[s]} / Ø${COUNTERBORE[s][0]} × ${COUNTERBORE[s][1]}`,
    values: { kind: 'counterbore', diameter: CLEARANCE[s], extent: 'through', cbDiameter: COUNTERBORE[s][0], cbDepth: COUNTERBORE[s][1] },
  })),
  ...SIZES.map((s): HolePreset => ({
    id: `countersink-${s}`, group: 'countersink', label: `${s} · Ø${CLEARANCE[s]} / Ø${COUNTERSINK[s]} 90°`,
    values: { kind: 'countersink', diameter: CLEARANCE[s], extent: 'through', csDiameter: COUNTERSINK[s], csAngle: 90 },
  })),
  ...SIZES.flatMap((s): HolePreset[] => {
    const v = INSERT[s];
    return v ? [{ id: `insert-${s}`, group: 'insert', label: `${s} · Ø${v[0]} × ${v[1]}`, values: { kind: 'simple', diameter: v[0], extent: 'distance', depth: v[1], tip: 'flat' } }] : [];
  }),
  ...SIZES.flatMap((s): HolePreset[] => {
    const d = TAP[s];
    return d ? [{ id: `tap-${s}`, group: 'tap', label: `${s} · Ø${d}`, values: { kind: 'simple', diameter: d } }] : [];
  }),
];

/** Valida las medidas de un agujero. null si están bien; si no, el motivo. */
export function holeProblem(f: HoleFeature): string | null {
  if (!(f.diameter > 0)) return `El diámetro debe ser mayor que 0 (es ${f.diameter})`;
  if (f.extent === 'distance' && !(f.depth > 0)) return `La profundidad debe ser mayor que 0 (es ${f.depth})`;
  if (f.kind === 'counterbore') {
    if (!(f.cbDiameter > f.diameter)) return 'El diámetro del cajeado tiene que ser mayor que el del agujero';
    if (!(f.cbDepth > 0)) return 'La profundidad del cajeado debe ser mayor que 0';
    if (f.extent === 'distance' && !(f.cbDepth < f.depth)) return 'El cajeado tiene que ser menos profundo que el agujero';
  }
  if (f.kind === 'countersink') {
    if (!(f.csDiameter > f.diameter)) return 'El diámetro del avellanado tiene que ser mayor que el del agujero';
    if (!(f.csAngle > 0 && f.csAngle < 180)) return 'El ángulo del avellanado tiene que estar entre 0° y 180°';
    const coneDepth = (f.csDiameter - f.diameter) / 2 / Math.tan((f.csAngle * Math.PI) / 360);
    if (f.extent === 'distance' && !(coneDepth < f.depth)) return 'El avellanado es más profundo que el agujero';
  }
  return null;
}
