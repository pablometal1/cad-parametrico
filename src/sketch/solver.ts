// Puente con planegcs (solver de restricciones de FreeCAD en WASM). Funciona en el hilo principal,
// en el worker del kernel y en Node (tests).
import { make_gcs_wrapper, SolveStatus, type GcsWrapper, type SketchPrimitive } from '@salusoft89/planegcs';
import { AXIS_X, AXIS_Y, ORIGIN, type SketchConstraint, type SketchData, type SketchEntityId } from '../document/types';
import { arcParams } from './geometry';
import { SketchIndex, withSolvedValues, type Vec2 } from './model';

let wrapperPromise: Promise<GcsWrapper> | null = null;
let wrapper: GcsWrapper | null = null;

/** Carga el WASM del solver una sola vez. En el navegador hay que pasar la URL del .wasm. */
export function initSolver(wasmUrl?: string): Promise<GcsWrapper> {
  if (!wrapperPromise) {
    wrapperPromise = make_gcs_wrapper(wasmUrl).then((w) => {
      wrapper = w;
      return w;
    });
  }
  return wrapperPromise;
}

export interface DragTarget {
  point: SketchEntityId;
  to: Vec2;
}

export interface SolveResult {
  /** Datos con las posiciones resueltas. Si el solver falla, son los de entrada. */
  data: SketchData;
  ok: boolean;
  /** Grados de libertad restantes (solo significativo sin arrastre). */
  dof: number;
  conflicting: string[];
  redundant: string[];
}

// Puntos fijos auxiliares de los ejes implícitos.
const AXIS_X_END = '__axisX_end';
const AXIS_Y_END = '__axisY_end';

/**
 * Resuelve el sketch. Con `drag`, los puntos indicados se llevan a la posición pedida mediante
 * restricciones temporales de menor prioridad (como el arrastre de FreeCAD).
 */
export function solveSketch(data: SketchData, drag: DragTarget[] = []): SolveResult {
  if (!wrapper) throw new Error('El solver de sketch no está inicializado');
  const gcs = wrapper;
  const index = new SketchIndex(data);
  gcs.clear_data();

  const prims: SketchPrimitive[] = [
    { id: ORIGIN, type: 'point', x: 0, y: 0, fixed: true },
    { id: AXIS_X_END, type: 'point', x: 1, y: 0, fixed: true },
    { id: AXIS_Y_END, type: 'point', x: 0, y: 1, fixed: true },
    { id: AXIS_X, type: 'line', p1_id: ORIGIN, p2_id: AXIS_X_END },
    { id: AXIS_Y, type: 'line', p1_id: ORIGIN, p2_id: AXIS_Y_END },
  ];
  const dragged = new Map(drag.map((d) => [d.point, d.to]));
  // Los puntos primero: líneas, círculos y arcos los referencian.
  for (const p of index.points()) {
    const at = dragged.get(p.id) ?? [p.x, p.y];
    prims.push({ id: p.id, type: 'point', x: at[0], y: at[1], fixed: false });
  }
  for (const c of index.curves()) {
    switch (c.type) {
      case 'line':
        prims.push({ id: c.id, type: 'line', p1_id: c.p1, p2_id: c.p2 });
        break;
      case 'circle':
        prims.push({ id: c.id, type: 'circle', c_id: c.center, radius: c.radius });
        break;
      case 'spline':
        // Su forma sale de sus puntos: no agrega incógnitas ni ecuaciones.
        break;
      case 'arc': {
        const ap = arcParams(index, c);
        prims.push({
          id: c.id, type: 'arc', c_id: c.center, start_id: c.start, end_id: c.end,
          radius: ap.radius, start_angle: ap.startAngle, end_angle: ap.endAngle,
        });
        // Mantiene los extremos sobre la circunferencia y coherentes con los ángulos.
        prims.push({ id: `__rules_${c.id}`, type: 'arc_rules', a_id: c.id });
        break;
      }
    }
  }
  const joined = coincidentPairs(data);
  for (const c of data.constraints) prims.push(...toGcs(index, c, joined));
  for (const d of drag) {
    prims.push({ id: `__drag_x_${d.point}`, type: 'coordinate_x', p_id: d.point, x: d.to[0], temporary: true });
    prims.push({ id: `__drag_y_${d.point}`, type: 'coordinate_y', p_id: d.point, y: d.to[1], temporary: true });
  }

  gcs.push_primitives_and_params(prims);
  const status = gcs.solve();
  const ok = status === SolveStatus.Success || status === SolveStatus.Converged;
  const conflicting = userIds(gcs.get_gcs_conflicting_constraints());
  const redundant = userIds(gcs.get_gcs_redundant_constraints());
  const dof = gcs.gcs.dof();
  if (!ok) return { data, ok, dof, conflicting, redundant };

  gcs.apply_solution();
  const points = new Map<SketchEntityId, Vec2>();
  const radii = new Map<SketchEntityId, number>();
  for (const p of gcs.sketch_index.get_primitives()) {
    if (p.type === 'point' && !p.fixed) points.set(p.id, [p.x, p.y]);
    if (p.type === 'circle') radii.set(p.id, p.radius);
  }
  return { data: withSolvedValues(data, points, radii), ok, dof, conflicting, redundant };
}

/** Los ids internos (reglas de arcos) no se muestran al usuario. */
function userIds(ids: string[]) {
  return ids.map((id) => (id.startsWith('__rules_') ? `arco ${id.slice(8)}` : id));
}

const DEG = Math.PI / 180;

/** Pares de puntos unidos por una restricción de coincidencia (en los dos órdenes). */
function coincidentPairs(data: SketchData): Set<string> {
  const out = new Set<string>();
  for (const c of data.constraints) {
    if (c.type === 'coincident') out.add(`${c.a}|${c.b}`).add(`${c.b}|${c.a}`);
  }
  return out;
}

/** Extremos de una línea y un arco (o de dos arcos) que coinciden: [punto de x, punto de y]. */
function sharedEnd(index: SketchIndex, x: SketchEntityId, y: SketchEntityId, joined: Set<string>): [SketchEntityId, SketchEntityId] | null {
  const ends = (id: SketchEntityId): SketchEntityId[] => {
    const e = index.get(id);
    return e?.type === 'line' ? [e.p1, e.p2] : e?.type === 'arc' ? [e.start, e.end] : [];
  };
  for (const p of ends(x)) for (const q of ends(y)) if (p === q || joined.has(`${p}|${q}`)) return [p, q];
  return null;
}

function toGcs(index: SketchIndex, c: SketchConstraint, joined: Set<string> = new Set()): SketchPrimitive[] {
  const kind = (id: SketchEntityId) => {
    const k = index.kind(id);
    if (!k) throw new Error(`La restricción ${c.id} referencia ${id}, que no existe`);
    return k;
  };
  const bad = (): never => {
    throw new Error(`Restricción ${c.id} (${c.type}) aplicada a entidades incompatibles`);
  };
  const id = c.id;

  switch (c.type) {
    case 'coincident': {
      const [ka, kb] = [kind(c.a), kind(c.b)];
      if (ka !== 'point') bad();
      if (kb === 'point') return [{ id, type: 'p2p_coincident', p1_id: c.a, p2_id: c.b }];
      if (kb === 'line') return [{ id, type: 'point_on_line_pl', p_id: c.a, l_id: c.b }];
      if (kb === 'circle') return [{ id, type: 'point_on_circle', p_id: c.a, c_id: c.b }];
      return [{ id, type: 'point_on_arc', p_id: c.a, a_id: c.b }];
    }
    case 'horizontal':
      if (kind(c.line) !== 'line') bad();
      return [{ id, type: 'horizontal_l', l_id: c.line }];
    case 'vertical':
      if (kind(c.line) !== 'line') bad();
      return [{ id, type: 'vertical_l', l_id: c.line }];
    case 'parallel':
      if (kind(c.a) !== 'line' || kind(c.b) !== 'line') bad();
      return [{ id, type: 'parallel', l1_id: c.a, l2_id: c.b }];
    case 'perpendicular':
      if (kind(c.a) !== 'line' || kind(c.b) !== 'line') bad();
      return [{ id, type: 'perpendicular_ll', l1_id: c.a, l2_id: c.b }];
    case 'tangent': {
      const [ka, kb] = [kind(c.a), kind(c.b)];
      // Se normaliza el orden: línea primero, luego círculo, luego arco.
      const order = { line: 0, circle: 1, arc: 2, point: 9, text: 9, spline: 9 } as const;
      const [x, y] = order[ka] <= order[kb] ? [c.a, c.b] : [c.b, c.a];
      const pair = `${kind(x)}-${kind(y)}`;
      // Tangencia en un extremo compartido: la forma general es degenerada ahí (el solver converge
      // mal y la marca redundante). Como en FreeCAD: la línea es perpendicular al radio en ese punto,
      // o los dos centros quedan alineados con él.
      const shared = pair === 'line-arc' || pair === 'arc-arc' ? sharedEnd(index, x, y, joined) : null;
      if (shared && pair === 'line-arc') {
        const l = index.get(x) as { p1: string; p2: string };
        const a = index.get(y) as { center: string };
        return [{ id, type: 'perpendicular_pppp', l1p1_id: l.p1, l1p2_id: l.p2, l2p1_id: a.center, l2p2_id: shared[1] }];
      }
      if (shared && pair === 'arc-arc') {
        const [a1, a2] = [index.get(x) as { center: string }, index.get(y) as { center: string }];
        return [{ id, type: 'point_on_line_ppp', p_id: shared[0], lp1_id: a1.center, lp2_id: a2.center }];
      }
      if (pair === 'line-circle') return [{ id, type: 'tangent_lc', l_id: x, c_id: y }];
      if (pair === 'line-arc') return [{ id, type: 'tangent_la', l_id: x, a_id: y }];
      if (pair === 'circle-circle') return [{ id, type: 'tangent_cc', c1_id: x, c2_id: y }];
      if (pair === 'circle-arc') return [{ id, type: 'tangent_ca', c_id: x, a_id: y }];
      if (pair === 'arc-arc') return [{ id, type: 'tangent_aa', a1_id: x, a2_id: y }];
      return bad();
    }
    case 'equal': {
      const [ka, kb] = [kind(c.a), kind(c.b)];
      if (ka === 'line' && kb === 'line') return [{ id, type: 'equal_length', l1_id: c.a, l2_id: c.b }];
      if (ka === 'circle' && kb === 'circle') return [{ id, type: 'equal_radius_cc', c1_id: c.a, c2_id: c.b }];
      if (ka === 'arc' && kb === 'arc') return [{ id, type: 'equal_radius_aa', a1_id: c.a, a2_id: c.b }];
      if (ka === 'circle' && kb === 'arc') return [{ id, type: 'equal_radius_ca', c1_id: c.a, a2_id: c.b }];
      if (ka === 'arc' && kb === 'circle') return [{ id, type: 'equal_radius_ca', c1_id: c.b, a2_id: c.a }];
      return bad();
    }
    case 'distance': {
      if (!(c.value > 0)) throw new Error(`La distancia ${c.id} debe ser mayor que 0`);
      const ka = kind(c.a);
      if (c.b === undefined) {
        if (ka !== 'line') bad();
        const l = index.get(c.a);
        if (!l || l.type !== 'line') return bad();
        return [{ id, type: 'p2p_distance', p1_id: l.p1, p2_id: l.p2, distance: c.value }];
      }
      const kb = kind(c.b);
      if (ka === 'point' && kb === 'point') return [{ id, type: 'p2p_distance', p1_id: c.a, p2_id: c.b, distance: c.value }];
      if (ka === 'point' && kb === 'line') return [{ id, type: 'p2l_distance', p_id: c.a, l_id: c.b, distance: c.value }];
      if (ka === 'line' && kb === 'point') return [{ id, type: 'p2l_distance', p_id: c.b, l_id: c.a, distance: c.value }];
      if (ka === 'line' && kb === 'line') {
        // Entre líneas (paralelas): distancia de un extremo de b a la recta a.
        const lb = index.get(c.b);
        if (!lb || lb.type !== 'line') return bad();
        return [{ id, type: 'p2l_distance', p_id: lb.p1, l_id: c.a, distance: c.value }];
      }
      return bad();
    }
    case 'radius': {
      if (!(c.value > 0)) throw new Error(`El radio ${c.id} debe ser mayor que 0`);
      const k = kind(c.curve);
      if (k === 'circle') return [{ id, type: 'circle_radius', c_id: c.curve, radius: c.value }];
      if (k === 'arc') return [{ id, type: 'arc_radius', a_id: c.curve, radius: c.value }];
      return bad();
    }
    case 'angle':
      if (kind(c.a) !== 'line' || kind(c.b) !== 'line') bad();
      return [{ id, type: 'l2l_angle_ll', l1_id: c.a, l2_id: c.b, angle: c.value * DEG }];
    case 'symmetric':
      if (kind(c.a) !== 'point' || kind(c.b) !== 'point' || kind(c.line) !== 'line') bad();
      return [{ id, type: 'p2p_symmetric_ppl', p1_id: c.a, p2_id: c.b, l_id: c.line }];
  }
}
