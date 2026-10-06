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
  for (const c of data.constraints) prims.push(...toGcs(index, c));
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

function toGcs(index: SketchIndex, c: SketchConstraint): SketchPrimitive[] {
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
      const order = { line: 0, circle: 1, arc: 2, point: 9, text: 9 } as const;
      const [x, y] = order[ka] <= order[kb] ? [c.a, c.b] : [c.b, c.a];
      const pair = `${kind(x)}-${kind(y)}`;
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
  }
}
