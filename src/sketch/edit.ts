// Herramientas de edición del sketch (como las de Fusion): recortar, desfasar, redondear esquinas,
// simetría y patrones. Son funciones puras sobre SketchData; la sesión las aplica con `commit`.
import { AXIS_X, AXIS_Y, ORIGIN, type SketchArc, type SketchConstraint, type SketchCurve, type SketchData, type SketchEntityId, type SketchLine } from '../document/types';
import { SketchBuilder } from './builders';
import { add, arcParams, cross, dist, dot, len, lineEnds, mul, normAngle, sampleCurve, signedArea, sub } from './geometry';
import { removeItems, SketchIndex, type Vec2 } from './model';

export type EditResult = { ok: true; data: SketchData; created: SketchEntityId[] } | { ok: false; error: string };

const fail = (error: string): EditResult => ({ ok: false, error });
const TAU = Math.PI * 2;

// ---------------------------------------------------------------- intersecciones

type Carrier = { kind: 'line'; a: Vec2; b: Vec2 } | { kind: 'circle'; c: Vec2; r: number };

function carrier(index: SketchIndex, c: SketchCurve): Carrier {
  if (c.type === 'line') return { kind: 'line', a: index.point(c.p1), b: index.point(c.p2) };
  if (c.type === 'circle') return { kind: 'circle', c: index.point(c.center), r: c.radius };
  const ap = arcParams(index, c);
  return { kind: 'circle', c: ap.center, r: ap.radius };
}

/** Intersecciones de las rectas/circunferencias completas (sin recortar a los segmentos). */
function carrierHits(x: Carrier, y: Carrier): Vec2[] {
  if (x.kind === 'line' && y.kind === 'line') {
    const d1 = sub(x.b, x.a);
    const d2 = sub(y.b, y.a);
    const den = cross(d1, d2);
    if (Math.abs(den) < 1e-12 * len(d1) * len(d2)) return [];
    const t = cross(sub(y.a, x.a), d2) / den;
    return [add(x.a, mul(d1, t))];
  }
  if (x.kind === 'circle' && y.kind === 'line') return carrierHits(y, x);
  if (x.kind === 'line' && y.kind === 'circle') {
    const d = sub(x.b, x.a);
    const L = len(d);
    if (L < 1e-12) return [];
    const u = mul(d, 1 / L);
    const t0 = dot(sub(y.c, x.a), u);
    const foot = add(x.a, mul(u, t0));
    const h = dist(foot, y.c);
    const tol = 1e-9 * Math.max(1, y.r);
    if (h > y.r + tol) return [];
    if (h > y.r - tol) return [foot];
    const k = Math.sqrt(y.r * y.r - h * h);
    return [add(foot, mul(u, -k)), add(foot, mul(u, k))];
  }
  const a = x as Extract<Carrier, { kind: 'circle' }>;
  const b = y as Extract<Carrier, { kind: 'circle' }>;
  const d = dist(a.c, b.c);
  const tol = 1e-9 * Math.max(1, a.r, b.r);
  if (d < tol || d > a.r + b.r + tol || d < Math.abs(a.r - b.r) - tol) return [];
  const along = (d * d + a.r * a.r - b.r * b.r) / (2 * d);
  const h = Math.sqrt(Math.max(0, a.r * a.r - along * along));
  const u = mul(sub(b.c, a.c), 1 / d);
  const m = add(a.c, mul(u, along));
  const n: Vec2 = [-u[1], u[0]];
  return h < tol ? [m] : [add(m, mul(n, h)), add(m, mul(n, -h))];
}

/** ¿El punto (que está sobre la recta/circunferencia de la curva) cae dentro de la curva? */
function withinCurve(index: SketchIndex, c: SketchCurve, p: Vec2, tol: number): boolean {
  if (c.type === 'circle') return true;
  if (c.type === 'line') {
    const a = index.point(c.p1);
    const d = sub(index.point(c.p2), a);
    const L = len(d);
    const t = dot(sub(p, a), d) / (L * L);
    return t >= -tol / L && t <= 1 + tol / L;
  }
  const ap = arcParams(index, c);
  const s = normAngle(Math.atan2(p[1] - ap.center[1], p[0] - ap.center[0]) - ap.startAngle);
  const span = ap.endAngle - ap.startAngle;
  const angTol = tol / Math.max(ap.radius, 1e-9);
  return s <= span + angTol || s >= TAU - angTol;
}

/** Puntos donde otras curvas cortan (o tocan) a `target`, con la curva que corta. */
function hitsOn(index: SketchIndex, target: SketchCurve, tol: number): { p: Vec2; by: SketchEntityId }[] {
  const out: { p: Vec2; by: SketchEntityId }[] = [];
  const tc = carrier(index, target);
  for (const other of index.curves()) {
    if (other.id === target.id) continue;
    for (const p of carrierHits(tc, carrier(index, other))) {
      if (withinCurve(index, target, p, tol) && withinCurve(index, other, p, tol)) out.push({ p, by: other.id });
    }
  }
  return out;
}

/** Tolerancia de longitud según el tamaño del sketch. */
function lengthTol(data: SketchData) {
  let m = 1;
  for (const e of data.entities) {
    if (e.type === 'point') m = Math.max(m, Math.abs(e.x), Math.abs(e.y));
    if (e.type === 'circle') m = Math.max(m, e.radius);
  }
  return 1e-7 * m;
}

// ---------------------------------------------------------------- utilidades de datos

function replaceEntity(d: SketchData, id: SketchEntityId, next: SketchCurve): SketchData {
  return { ...d, entities: d.entities.map((e) => (e.id === id ? next : e)) };
}

/** Borra los puntos que ya no usa ninguna curva/texto y que antes sí se usaban. */
function dropOrphans(d: SketchData, candidates: SketchEntityId[]): SketchData {
  const used = new Set<SketchEntityId>();
  for (const e of d.entities) {
    if (e.type === 'line') used.add(e.p1).add(e.p2);
    else if (e.type === 'circle') used.add(e.center);
    else if (e.type === 'arc') used.add(e.center).add(e.start).add(e.end);
    else if (e.type === 'text') used.add(e.point);
  }
  const orphans = candidates.filter((p) => p !== ORIGIN && !used.has(p));
  return orphans.length ? removeItems(d, orphans) : d;
}

/** Restricciones que dependen del largo de la línea (dejan de tener sentido al recortarla). */
const dependsOnLength = (c: SketchConstraint, line: SketchEntityId, index: SketchIndex) =>
  (c.type === 'distance' && c.b === undefined && c.a === line) ||
  (c.type === 'equal' && (c.a === line || c.b === line) && index.kind(c.a) === 'line');

/** Restricciones de dirección de una línea, que valen igual para un tramo de ella. */
function directionConstraints(d: SketchData, line: SketchEntityId) {
  return d.constraints.filter(
    (c) =>
      ((c.type === 'horizontal' || c.type === 'vertical') && c.line === line) ||
      ((c.type === 'parallel' || c.type === 'perpendicular') && (c.a === line || c.b === line)),
  );
}

// ---------------------------------------------------------------- recortar

/**
 * Recortar (trim): borra el tramo de la curva entre las intersecciones más cercanas a `at`.
 * Si nada la corta, borra la curva entera. Los extremos nuevos quedan restringidos sobre la curva
 * que corta, así el recorte sigue a la geometría si después cambian las cotas.
 */
export function trimCurve(data: SketchData, curveId: SketchEntityId, at: Vec2): EditResult {
  const index = new SketchIndex(data);
  const curve = index.get(curveId);
  if (!curve || (curve.type !== 'line' && curve.type !== 'circle' && curve.type !== 'arc')) return fail('Elegí una línea, un círculo o un arco');
  const tol = lengthTol(data);
  const hits = hitsOn(index, curve, tol);

  if (curve.type === 'line') {
    const a = index.point(curve.p1);
    const dv = sub(index.point(curve.p2), a);
    const L2 = dot(dv, dv);
    const param = (p: Vec2) => dot(sub(p, a), dv) / L2;
    const eps = tol / Math.sqrt(L2);
    const cuts = hits.map((h) => ({ ...h, t: param(h.p) })).filter((h) => h.t > eps && h.t < 1 - eps);
    const t0 = Math.min(1, Math.max(0, param(at)));
    return trimSpan(data, curve, cuts, t0);
  }

  if (curve.type === 'circle') {
    const c = index.point(curve.center);
    const ang = (p: Vec2) => normAngle(Math.atan2(p[1] - c[1], p[0] - c[0]));
    const cuts = uniqueBy(hits.map((h) => ({ ...h, t: ang(h.p) })), tol / curve.radius);
    if (cuts.length < 2) return { ok: true, data: removeItems(data, [curveId]), created: [] };
    const t0 = ang(at);
    // Tramo a borrar: entre el corte anterior y el siguiente a t0 (en sentido antihorario).
    const sorted = cuts.slice().sort((x, y) => x.t - y.t);
    const next = sorted.find((h) => h.t > t0) ?? sorted[0];
    const prev = [...sorted].reverse().find((h) => h.t < t0) ?? sorted[sorted.length - 1];
    const b = new SketchBuilder(data);
    const start = b.point(next.p);
    const end = b.point(prev.p);
    b.constrain({ type: 'coincident', a: start, b: next.by });
    b.constrain({ type: 'coincident', a: end, b: prev.by });
    // El círculo pasa a ser un arco con el mismo id: sus restricciones (radio, tangencias) siguen.
    const arc: SketchArc = { id: curve.id, type: 'arc', center: curve.center, start, end, construction: curve.construction };
    return { ok: true, data: replaceEntity(b.data, curve.id, arc), created: [] };
  }

  const ap = arcParams(index, curve);
  const span = ap.endAngle - ap.startAngle;
  const param = (p: Vec2) => normAngle(Math.atan2(p[1] - ap.center[1], p[0] - ap.center[0]) - ap.startAngle) / span;
  const eps = tol / (ap.radius * span);
  const cuts = hits.map((h) => ({ ...h, t: param(h.p) })).filter((h) => h.t > eps && h.t < 1 - eps);
  const raw = param(at);
  // Un clic fuera del barrido (cerca de un extremo) va al extremo más cercano.
  const t0 = raw <= 1 ? raw : raw - 1 > (TAU / span - 1) / 2 ? 0 : 1;
  return trimSpan(data, curve, cuts, t0);
}

function uniqueBy<T extends { t: number }>(xs: T[], tol: number): T[] {
  const out: T[] = [];
  for (const x of xs) if (!out.some((y) => Math.abs(y.t - x.t) < tol || Math.abs(Math.abs(y.t - x.t) - TAU) < tol)) out.push(x);
  return out;
}

/** Recorte de una línea o arco parametrizados en [0, 1] (0 = p1/start, 1 = p2/end). */
function trimSpan(
  data: SketchData, curve: SketchLine | SketchArc, cuts: { p: Vec2; by: SketchEntityId; t: number }[], t0: number,
): EditResult {
  const lo = cuts.filter((h) => h.t < t0).sort((x, y) => y.t - x.t)[0];
  const hi = cuts.filter((h) => h.t > t0).sort((x, y) => x.t - y.t)[0];
  if (!lo && !hi) return { ok: true, data: removeItems(data, [curve.id]), created: [] };

  const index = new SketchIndex(data);
  const [first, last] = curve.type === 'line' ? [curve.p1, curve.p2] : [curve.start, curve.end];
  const b = new SketchBuilder(data);
  const created: SketchEntityId[] = [];
  const cutPoint = (h: { p: Vec2; by: SketchEntityId }) => {
    const id = b.point(h.p);
    b.constrain({ type: 'coincident', a: id, b: h.by });
    return id;
  };
  const with2 = (c: SketchLine | SketchArc, s: SketchEntityId, e: SketchEntityId): SketchLine | SketchArc =>
    c.type === 'line' ? { ...c, p1: s, p2: e } : { ...c, start: s, end: e };

  let piece: SketchLine | SketchArc;
  let extra: SketchLine | SketchArc | null = null;
  if (lo && !hi) piece = with2(curve, first, cutPoint(lo));
  else if (hi && !lo) piece = with2(curve, cutPoint(hi), last);
  else {
    piece = with2(curve, first, cutPoint(lo!));
    const id = nextFree(b.data, curve.type === 'line' ? 'l' : 'a');
    extra = with2({ ...curve, id }, cutPoint(hi!), last);
    created.push(id);
  }

  let d = replaceEntity(b.data, curve.id, piece);
  if (extra) {
    const second = extra;
    const copies: SketchConstraint[] = [];
    if (curve.type === 'line') {
      for (const c of directionConstraints(data, curve.id)) {
        const k = nextFree({ ...d, constraints: [...d.constraints, ...copies] }, 'k');
        if (c.type === 'horizontal' || c.type === 'vertical') copies.push({ ...c, id: k, line: second.id });
        else if (c.type === 'parallel' || c.type === 'perpendicular') copies.push({ ...c, id: k, a: c.a === curve.id ? second.id : c.a, b: c.b === curve.id ? second.id : c.b });
      }
    } else {
      // Los dos tramos de un arco siguen en la misma circunferencia.
      copies.push({ id: nextFree(d, 'k'), type: 'equal', a: curve.id, b: second.id });
    }
    d = { entities: [...d.entities, second], constraints: [...d.constraints, ...copies] };
  }
  if (curve.type === 'line') d = { ...d, constraints: d.constraints.filter((c) => !dependsOnLength(c, curve.id, index)) };
  return { ok: true, data: dropOrphans(d, [first, last]), created };
}

function nextFree(d: SketchData, prefix: string): string {
  const used = new Set<string>([...d.entities.map((e) => e.id), ...d.constraints.map((c) => c.id)]);
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

// ---------------------------------------------------------------- desfasar

interface ChainItem {
  curve: SketchLine | SketchArc;
  /** Punto por el que se entra y por el que se sale, en el sentido de la cadena. */
  from: SketchEntityId;
  to: SketchEntityId;
}

const ends = (c: SketchLine | SketchArc): [SketchEntityId, SketchEntityId] => (c.type === 'line' ? [c.p1, c.p2] : [c.start, c.end]);

/** Ordena líneas y arcos conectados en cadenas (abiertas o cerradas). */
function chains(curves: (SketchLine | SketchArc)[]): { items: ChainItem[]; closed: boolean }[] | string {
  const byPoint = new Map<SketchEntityId, (SketchLine | SketchArc)[]>();
  for (const c of curves) for (const p of ends(c)) byPoint.set(p, [...(byPoint.get(p) ?? []), c]);
  if ([...byPoint.values()].some((cs) => cs.length > 2)) return 'Las curvas se ramifican: elegí un contorno sin bifurcaciones';
  const left = new Set(curves);
  const out: { items: ChainItem[]; closed: boolean }[] = [];
  while (left.size) {
    // Arranca por un extremo libre si hay (cadena abierta).
    const startCurve = [...left].find((c) => ends(c).some((p) => byPoint.get(p)!.length === 1)) ?? [...left][0];
    const [a, b] = ends(startCurve);
    let from = byPoint.get(a)!.length === 1 ? a : byPoint.get(b)!.length === 1 ? b : a;
    let cur: SketchLine | SketchArc | undefined = startCurve;
    const items: ChainItem[] = [];
    while (cur && left.has(cur)) {
      left.delete(cur);
      const [p, q] = ends(cur);
      const to = from === p ? q : p;
      items.push({ curve: cur, from, to });
      from = to;
      cur = byPoint.get(to)!.find((c) => c !== cur && left.has(c));
    }
    const closed = items.length > 1 && items[items.length - 1].to === items[0].from;
    out.push({ items, closed });
  }
  return out;
}

/**
 * Desfase (offset) de líneas, arcos y círculos a una distancia. Positiva = hacia afuera del
 * contorno (para una línea sola, a la izquierda de su sentido). Las líneas nuevas quedan
 * paralelas y acotadas respecto de las originales, y los arcos son concéntricos.
 */
export function offsetCurves(data: SketchData, ids: SketchEntityId[], distance: number): EditResult {
  if (!(Math.abs(distance) > 0)) return fail('La distancia del desfase no puede ser 0');
  const index = new SketchIndex(data);
  const selected = ids.map((id) => index.get(id)).filter((e): e is SketchCurve => !!e && (e.type === 'line' || e.type === 'arc' || e.type === 'circle'));
  if (!selected.length) return fail('Elegí las líneas, arcos o círculos a desfasar');
  const b = new SketchBuilder(data);
  const created: SketchEntityId[] = [];

  for (const c of selected) {
    if (c.type !== 'circle') continue;
    const r = c.radius + distance;
    if (!(r > 0)) return fail(`El círculo ${c.id} queda con radio ≤ 0`);
    created.push(b.circle(c.center, r, c.construction));
  }

  const open = selected.filter((c): c is SketchLine | SketchArc => c.type !== 'circle');
  const groups = chains(open);
  if (typeof groups === 'string') return fail(groups);

  for (const g of groups) {
    // Orientación antihoraria (cerrando la cadena por su cuerda): "afuera" queda a la derecha.
    const poly = g.items.flatMap((it) => {
      const pts = sampleCurve(index, it.curve);
      const forward = ends(it.curve)[0] === it.from;
      return forward ? pts : pts.reverse();
    });
    if (signedArea(poly) < 0) {
      g.items.reverse();
      for (const it of g.items) [it.from, it.to] = [it.to, it.from];
    }
    const off = g.items.map((it) => offsetItem(index, it, distance));
    const bad = off.find((o) => typeof o === 'string');
    if (bad) return fail(bad as string);
    const pieces = off as OffsetPiece[];

    // Uniones: donde terminan dos tramos desfasados se busca el punto común. Índice de unión k:
    // el tramo i va de la unión i a la i + 1 (en una cadena cerrada, la n es la 0).
    const n = pieces.length;
    const nJ = g.closed ? n : n + 1;
    const J = (k: number) => (g.closed ? ((k % n) + n) % n : k);
    const pos: Vec2[] = [];
    /** Unión tangente o extremo libre: el punto nuevo está sobre la normal del original. */
    const normalJoint: boolean[] = [];
    for (let k = 0; k < nJ; k++) {
      if (!g.closed && (k === 0 || k === n)) {
        pos[k] = k === 0 ? pieces[0].start : pieces[n - 1].end;
        normalJoint[k] = true;
        continue;
      }
      const j = join(pieces[J(k - 1)], pieces[J(k)], index.point(g.items[J(k)].from));
      if (!j) return fail('No se puede unir el desfase en una esquina: probá con una distancia menor');
      pos[k] = j.p;
      normalJoint[k] = j.tangent;
    }
    const original = (k: number) => (k < n ? g.items[k].from : g.items[n - 1].to);
    const item = (k: number) => (k >= 0 && k < n ? g.items[k] : g.closed ? g.items[J(k)] : undefined);

    // Cómo queda fija cada unión. Las ecuaciones tienen que alcanzar justo (ni de menos, porque
    // queda suelta, ni de más, porque el solver las marca redundantes):
    // - 'direct': fija del todo (rayo con ángulo y largo desde el punto original);
    // - 'radial': sobre el radio de su arco (el radio lo da la regla del arco con el otro extremo).
    type Mode = { kind: 'direct' } | { kind: 'radial'; arc: SketchArc };
    const mode: (Mode | null)[] = new Array(nJ).fill(null);
    const needsRadius: number[] = [];
    for (let i = 0; i < n; i++) {
      const arc = g.items[i].curve;
      if (arc.type !== 'arc') continue;
      const [ka, kb] = [J(i), J(i + 1)];
      const [da, db] = [mode[ka] !== null, mode[kb] !== null];
      if (!da && !db) {
        if (normalJoint[ka]) {
          mode[ka] = { kind: 'direct' };
          if (normalJoint[kb]) mode[kb] = { kind: 'radial', arc };
        } else if (normalJoint[kb]) mode[kb] = { kind: 'direct' };
        else needsRadius.push(i);
      } else if (da && !db) {
        if (normalJoint[kb]) mode[kb] = { kind: 'radial', arc };
      } else if (!da && db) {
        if (normalJoint[ka]) mode[ka] = { kind: 'radial', arc };
      }
    }
    // Extremos libres de líneas: fijos sobre la perpendicular.
    for (const k of g.closed ? [] : [0, n]) if (!mode[k]) mode[k] = { kind: 'direct' };

    const pointIds = pos.map((p) => b.point(p));
    const pid = (k: number) => pointIds[J(k)];
    const lineAt = (k: number) => [item(k - 1), item(k)].find((it) => it?.curve.type === 'line')?.curve as SketchLine | undefined;
    const arcAt = (k: number) => [item(k - 1), item(k)].find((it) => it?.curve.type === 'arc')?.curve as SketchArc | undefined;
    const radialLine = (arc: SketchArc, through: SketchEntityId) => b.line(arc.center, through, true);

    for (let k = 0; k < nJ; k++) {
      const m = mode[k];
      if (!m) continue;
      const T = original(k);
      if (m.kind === 'radial') {
        b.constrain({ type: 'coincident', a: pointIds[k], b: radialLine(m.arc, T) });
        continue;
      }
      const line = lineAt(k);
      if (line) {
        // Rayo perpendicular a la línea, con ángulo con signo (no se pasa al otro lado).
        const ray = b.line(T, pointIds[k], true);
        const dir = sub(index.point(line.p2), index.point(line.p1));
        const nrm = sub(pos[k], index.point(T));
        const value = (Math.atan2(cross(dir, nrm), dot(dir, nrm)) * 180) / Math.PI;
        b.constrain({ type: 'angle', a: line.id, b: ray, value: Math.round(value) });
        b.constrain({ type: 'distance', a: ray, value: Math.abs(distance) });
      } else {
        const arc = arcAt(k)!;
        b.constrain({ type: 'coincident', a: pointIds[k], b: radialLine(arc, T) });
        b.constrain({ type: 'distance', a: T, b: pointIds[k], value: Math.abs(distance) });
      }
    }

    pieces.forEach((pc, i) => {
      const it = g.items[i];
      const [s, e] = [pid(i), pid(i + 1)];
      if (it.curve.type === 'line') {
        const id = b.line(s, e, it.curve.construction);
        created.push(id);
        const fixedEnds = [J(i), J(i + 1)].filter((k) => mode[k]).length;
        if (fixedEnds < 2) b.constrain({ type: 'parallel', a: it.curve.id, b: id });
        if (fixedEnds === 0) {
          // Distancia con lado: rayo perpendicular desde el inicio de la original hasta la nueva.
          const [p1, p2] = [it.curve.p1, it.curve.p2];
          const dir = sub(index.point(p2), index.point(p1));
          const right: Vec2 = mul([dir[1], -dir[0]], 1 / len(dir));
          const sign = (it.from === p1 ? 1 : -1) * Math.sign(distance);
          const foot = b.point(add(index.point(p1), mul(right, sign * Math.abs(distance))));
          const ray = b.line(p1, foot, true);
          b.constrain({ type: 'coincident', a: foot, b: id });
          b.constrain({ type: 'angle', a: it.curve.id, b: ray, value: sign > 0 ? -90 : 90 });
          b.constrain({ type: 'distance', a: ray, value: Math.abs(distance) });
        }
      } else {
        // Mismo centro (concéntrico). El arco va siempre antihorario de start a end.
        const positions = new Map<string, Vec2>([[it.curve.center, index.point(it.curve.center)]]);
        const id = b.arc(it.curve.center, pc.ccw ? s : e, pc.ccw ? e : s, it.curve.construction, positions);
        created.push(id);
        if (needsRadius.includes(i)) {
          // Sin uniones tangentes: un punto del arco nuevo sobre el radio, a la distancia del desfase.
          const T = it.from;
          const r = b.point(add(index.point(T), mul(sub(index.point(T), index.point(it.curve.center)), (pc.ccw ? 1 : -1) * distance / dist(index.point(T), index.point(it.curve.center)))));
          b.constrain({ type: 'coincident', a: r, b: radialLine(it.curve, T) });
          b.constrain({ type: 'coincident', a: r, b: id });
          b.constrain({ type: 'distance', a: T, b: r, value: Math.abs(distance) });
        }
      }
    });
  }
  return { ok: true, data: b.data, created };
}

interface OffsetPiece {
  carrier: Carrier;
  start: Vec2;
  end: Vec2;
  /** Para arcos: si el tramo se recorre en sentido antihorario. */
  ccw: boolean;
}

function offsetItem(index: SketchIndex, it: ChainItem, distance: number): OffsetPiece | string {
  const from = index.point(it.from);
  const to = index.point(it.to);
  if (it.curve.type === 'line') {
    const d = sub(to, from);
    const L = len(d);
    const right: Vec2 = [d[1] / L, -d[0] / L];
    const s = add(from, mul(right, distance));
    const e = add(to, mul(right, distance));
    return { carrier: { kind: 'line', a: s, b: e }, start: s, end: e, ccw: true };
  }
  const c = index.point(it.curve.center);
  const ccw = it.from === it.curve.start;
  const r0 = dist(c, from);
  // Recorrido antihorario: la derecha (afuera) es alejándose del centro.
  const r = ccw ? r0 + distance : r0 - distance;
  if (!(r > 1e-9)) return `El arco ${it.curve.id} queda con radio ≤ 0`;
  const at = (p: Vec2) => add(c, mul(sub(p, c), r / dist(p, c)));
  return { carrier: { kind: 'circle', c, r }, start: at(from), end: at(to), ccw };
}

/** Punto donde se unen dos tramos desfasados consecutivos (tangent: ya se tocaban). */
function join(prev: OffsetPiece, next: OffsetPiece, corner: Vec2): { p: Vec2; tangent: boolean } | null {
  const scale = Math.max(1, len(prev.end), len(next.start));
  if (dist(prev.end, next.start) < 1e-9 * scale) return { p: prev.end, tangent: true };
  const target: Vec2 = [(prev.end[0] + next.start[0]) / 2, (prev.end[1] + next.start[1]) / 2];
  const hits = carrierHits(prev.carrier, next.carrier);
  if (!hits.length) return null;
  hits.sort((x, y) => dist(x, target) - dist(y, target));
  // Una unión absurda (muy lejos de la esquina) indica que el desfase no entra.
  const span = dist(prev.start, prev.end) + dist(next.start, next.end) + dist(corner, target) * 4;
  return dist(hits[0], target) <= span ? { p: hits[0], tangent: false } : null;
}

// ---------------------------------------------------------------- redondear esquina

/**
 * Redondeo de una esquina entre dos líneas (elegir el vértice o las dos líneas): acorta las
 * líneas y agrega un arco tangente con cota de radio. Si el vértice tenía cotas, o las líneas
 * cotas de largo, se conserva como "esquina virtual" (líneas de construcción) para no perderlas.
 */
export function filletCorner(data: SketchData, selection: SketchEntityId[], radius: number): EditResult {
  if (!(radius > 0)) return fail('El radio debe ser mayor que 0');
  const index = new SketchIndex(data);
  let corner: SketchEntityId | null = null;
  let lines: SketchLine[] = [];
  const usesOf = (p: SketchEntityId) =>
    index.curves().filter((c) => (c.type === 'line' ? [c.p1, c.p2] : c.type === 'arc' ? [c.start, c.end, c.center] : [c.center]).includes(p));
  // Las líneas de construcción (por ejemplo, de una esquina virtual vecina) no cuentan como lados.
  const sides = (p: SketchEntityId) => {
    const all = usesOf(p);
    const real = all.filter((c) => !c.construction);
    return real.length === 2 ? real : all;
  };
  if (selection.length === 1 && index.kind(selection[0]) === 'point') {
    corner = selection[0];
    const uses = sides(corner);
    if (uses.length !== 2 || uses.some((c) => c.type !== 'line')) return fail('El vértice tiene que unir exactamente dos líneas');
    lines = uses as SketchLine[];
  } else if (selection.length === 2 && selection.every((id) => index.get(id)?.type === 'line')) {
    lines = selection.map((id) => index.get(id) as SketchLine);
    const shared = [lines[0].p1, lines[0].p2].find((p) => p === lines[1].p1 || p === lines[1].p2);
    if (!shared) return fail('Las dos líneas tienen que compartir un vértice');
    corner = shared;
    if (!sides(corner).every((c) => lines.includes(c as SketchLine))) return fail('El vértice tiene que unir exactamente dos líneas');
  } else {
    return fail('Elegí el vértice entre dos líneas, o las dos líneas');
  }
  // Otras curvas que usan el vértice (líneas de construcción): también obligan a conservarlo.
  const sharedCorner = usesOf(corner).length > 2;

  const P = index.point(corner);
  const other = (l: SketchLine) => (l.p1 === corner ? l.p2 : l.p1);
  const [Q1, Q2] = lines.map((l) => index.point(other(l)));
  const L1 = dist(P, Q1);
  const L2 = dist(P, Q2);
  const u1 = mul(sub(Q1, P), 1 / L1);
  const u2 = mul(sub(Q2, P), 1 / L2);
  const theta = Math.acos(Math.max(-1, Math.min(1, dot(u1, u2))));
  if (theta < 1e-6 || Math.PI - theta < 1e-6) return fail('Las líneas están alineadas: no hay esquina que redondear');
  const back = radius / Math.tan(theta / 2);
  if (back >= Math.min(L1, L2) * (1 - 1e-9)) {
    const max = Math.min(L1, L2) * Math.tan(theta / 2);
    return fail(`El radio no entra en esa esquina: hasta ≈ ${Math.floor(max * 100 + 1e-6) / 100} mm`);
  }
  const T1 = add(P, mul(u1, back));
  const T2 = add(P, mul(u2, back));
  const bis = mul(add(u1, u2), 1 / len(add(u1, u2)));
  const C = add(P, mul(bis, radius / Math.sin(theta / 2)));

  const virtual =
    sharedCorner ||
    data.constraints.some((c) => constraintTouches(c, corner!)) ||
    data.constraints.some((c) => lines.some((l) => dependsOnLength(c, l.id, index)));

  const b = new SketchBuilder(data);
  const t1 = b.point(T1);
  const t2 = b.point(T2);
  const c = b.point(C);
  const ccw = cross(sub(T1, C), sub(T2, C)) > 0;
  const positions = new Map<string, Vec2>([[c, C], [t1, T1], [t2, T2]]);
  const construction = lines[0].construction && lines[1].construction;
  const arc = b.arc(c, ccw ? t1 : t2, ccw ? t2 : t1, construction, positions);
  // Tangencia como en la ranura: radios de construcción perpendiculares a cada línea.
  const r1 = b.line(c, t1, true);
  const r2 = b.line(c, t2, true);
  b.constrain({ type: 'perpendicular', a: r1, b: lines[0].id });
  b.constrain({ type: 'perpendicular', a: r2, b: lines[1].id });
  b.constrain({ type: 'radius', curve: arc, value: radius });

  /** Línea de construcción completa (vértice → otro extremo), solo si una igualdad la necesita. */
  const full = new Map<SketchEntityId, SketchEntityId>();
  if (virtual) {
    // Esquina virtual: el vértice queda sobre ambas líneas, con dos tramos cortos de construcción
    // hasta los puntos de tangencia (así se ve y no queda como punto suelto).
    b.line(corner, t1, true);
    b.line(corner, t2, true);
    b.constrain({ type: 'coincident', a: corner, b: lines[0].id });
    b.constrain({ type: 'coincident', a: corner, b: lines[1].id });
    for (const l of lines) {
      if (data.constraints.some((k) => k.type === 'equal' && (k.a === l.id || k.b === l.id))) full.set(l.id, b.line(corner, other(l), true));
    }
  }
  const trimmed = (l: SketchLine, t: SketchEntityId): SketchLine => (l.p1 === corner ? { ...l, p1: t } : { ...l, p2: t });
  let d = replaceEntity(replaceEntity(b.data, lines[0].id, trimmed(lines[0], t1)), lines[1].id, trimmed(lines[1], t2));
  d = {
    ...d,
    constraints: d.constraints.map((k) => {
      const line = lines.find((l) => dependsOnLength(k, l.id, index));
      if (!line) return k;
      // El largo de cada lado se sigue midiendo hasta la esquina virtual.
      if (k.type === 'distance') return { ...k, a: corner!, b: other(line) };
      if (k.type === 'equal') {
        const to = full.get(line.id)!;
        return { ...k, a: k.a === line.id ? to : k.a, b: k.b === line.id ? to : k.b };
      }
      return k;
    }),
  };
  if (!virtual) d = dropOrphans(d, [corner]);
  return { ok: true, data: d, created: [arc] };
}

function constraintTouches(c: SketchConstraint, id: SketchEntityId): boolean {
  switch (c.type) {
    case 'horizontal':
    case 'vertical':
      return c.line === id;
    case 'radius':
      return c.curve === id;
    case 'distance':
      return c.a === id || c.b === id;
    case 'symmetric':
      return c.a === id || c.b === id || c.line === id;
    default:
      return c.a === id || c.b === id;
  }
}

// ---------------------------------------------------------------- simetría y patrones

type Transform = (p: Vec2) => Vec2;

/**
 * Copia curvas y puntos sueltos aplicando `tf`. `mapPoint` decide, para cada punto original,
 * si se reutiliza (devuelve su id) o se crea uno nuevo (null).
 */
function copyGeometry(
  b: SketchBuilder, index: SketchIndex, ids: SketchEntityId[], tf: Transform, mirror: boolean,
  mapPoint: (id: SketchEntityId) => SketchEntityId | null,
): { points: Map<SketchEntityId, SketchEntityId>; curves: Map<SketchEntityId, SketchEntityId> } {
  const points = new Map<SketchEntityId, SketchEntityId>();
  const curves = new Map<SketchEntityId, SketchEntityId>();
  const positions = new Map<string, Vec2>();
  const pt = (id: SketchEntityId) => {
    let n = points.get(id);
    if (!n) {
      const reuse = mapPoint(id);
      const pos = tf(index.point(id));
      n = reuse ?? b.point(pos);
      positions.set(n, reuse ? index.point(reuse) : pos);
      points.set(id, n);
    }
    return n;
  };
  for (const id of ids) {
    const e = index.get(id);
    if (!e) continue;
    if (e.type === 'point') pt(e.id);
    else if (e.type === 'line') curves.set(e.id, b.line(pt(e.p1), pt(e.p2), e.construction));
    else if (e.type === 'circle') curves.set(e.id, b.circle(pt(e.center), e.radius, e.construction));
    else if (e.type === 'arc') {
      const [c, s, en] = [pt(e.center), pt(e.start), pt(e.end)];
      // Reflejar invierte el sentido: el arco nuevo va del reflejo del final al del inicio.
      curves.set(e.id, mirror ? b.arc(c, en, s, e.construction, positions) : b.arc(c, s, en, e.construction, positions));
    }
  }
  return { points, curves };
}

const isGeometry = (index: SketchIndex, id: SketchEntityId) => {
  const k = index.get(id)?.type;
  return k === 'line' || k === 'circle' || k === 'arc' || k === 'point';
};

/**
 * Simetría respecto de una línea (o un eje): copia la geometría elegida y la vincula con
 * restricciones de simetría, así la copia sigue a la original. Los puntos que están sobre la
 * línea de simetría se comparten.
 */
export function mirrorCurves(data: SketchData, ids: SketchEntityId[], axis: SketchEntityId): EditResult {
  const index = new SketchIndex(data);
  if (index.kind(axis) !== 'line') return fail('La línea de simetría tiene que ser una línea o un eje');
  const geo = ids.filter((id) => id !== axis && isGeometry(index, id));
  if (!geo.length) return fail('Elegí la geometría a reflejar y, al final, la línea de simetría');
  const [a, bb] = lineEnds(index, axis);
  const d = sub(bb, a);
  const u = mul(d, 1 / len(d));
  const reflect: Transform = (p) => {
    const v = sub(p, a);
    const along = mul(u, dot(v, u));
    return add(a, sub(mul(along, 2), v));
  };
  const tol = lengthTol(data);
  const axisPoints = axis === AXIS_X || axis === AXIS_Y ? [] : (() => {
    const l = index.get(axis) as SketchLine;
    return [l.p1, l.p2];
  })();
  const onAxis = (id: SketchEntityId) => dist(reflect(index.point(id)), index.point(id)) < tol;
  // Una curva que está entera sobre la línea de simetría no se copia (quedaría encimada).
  const geo2 = geo.filter((id) => {
    const e = index.get(id)!;
    return e.type === 'point' || e.type === 'circle' || !curvePointIds(e as SketchCurve).every(onAxis);
  });
  // Centro de un solo arco (y nada más): en vez de reflejarlo, radio igual. Reflejar centro y
  // extremos de un arco es redundante con la regla que mantiene sus extremos sobre el radio.
  const uses = new Map<SketchEntityId, number>();
  for (const id of geo2) {
    const e = index.get(id)!;
    for (const p of e.type === 'point' ? [e.id] : curvePointIds(e as SketchCurve)) uses.set(p, (uses.get(p) ?? 0) + 1);
  }
  const loneCenters = new Set(
    geo2.flatMap((id) => {
      const e = index.get(id)!;
      return e.type === 'arc' && uses.get(e.center) === 1 && !onAxis(e.center) ? [e.center] : [];
    }),
  );
  const b = new SketchBuilder(data);
  const { points, curves } = copyGeometry(b, index, geo2, reflect, true, (id) => (onAxis(id) ? id : null));
  for (const [orig, copy] of points) {
    if (loneCenters.has(orig)) continue;
    if (orig !== copy) b.constrain({ type: 'symmetric', a: orig, b: copy, line: axis });
    else if (orig !== ORIGIN && !axisPoints.includes(orig) && !alreadyOn(data, orig, axis)) {
      b.constrain({ type: 'coincident', a: orig, b: axis });
    }
  }
  for (const [orig, copy] of curves) {
    const e = index.get(orig);
    if (e?.type === 'circle' || (e?.type === 'arc' && loneCenters.has(e.center))) b.constrain({ type: 'equal', a: orig, b: copy });
  }
  const loosePoints = [...points].filter(([o, c]) => o !== c && geo2.includes(o)).map(([, c]) => c);
  return { ok: true, data: b.data, created: [...curves.values(), ...loosePoints] };
}

function curvePointIds(e: SketchCurve): SketchEntityId[] {
  return e.type === 'line' ? [e.p1, e.p2] : e.type === 'arc' ? [e.center, e.start, e.end] : [e.center];
}

function alreadyOn(data: SketchData, point: SketchEntityId, line: SketchEntityId) {
  return data.constraints.some((c) => c.type === 'coincident' && c.a === point && c.b === line);
}

export type PatternSpec =
  | { kind: 'circular'; center: SketchEntityId; count: number; /** Grados que ocupa el patrón (360 = vuelta completa). */ angle: number }
  | { kind: 'linear'; direction: SketchEntityId; count: number; spacing: number };

/**
 * Patrón dentro del sketch: copias de la geometría elegida, en círculo alrededor de un punto o
 * en línea a lo largo de una dirección. Los círculos copiados quedan con radio igual al original.
 */
export function patternCurves(data: SketchData, ids: SketchEntityId[], spec: PatternSpec): EditResult {
  const index = new SketchIndex(data);
  const count = Math.round(spec.count);
  if (!(count >= 2) || count > 200) return fail('La cantidad tiene que estar entre 2 y 200');
  const exclude = spec.kind === 'circular' ? spec.center : spec.direction;
  const geo = ids.filter((id) => id !== exclude && isGeometry(index, id));
  if (!geo.length) return fail('Elegí la geometría a repetir');

  let tfs: Transform[];
  if (spec.kind === 'circular') {
    if (index.kind(spec.center) !== 'point') return fail('El centro del patrón tiene que ser un punto');
    const c = index.point(spec.center);
    const full = Math.abs(Math.abs(spec.angle) - 360) < 1e-9;
    const step = ((spec.angle * Math.PI) / 180) / (full ? count : count - 1);
    tfs = Array.from({ length: count - 1 }, (_, k) => {
      const a = step * (k + 1);
      const [cs, sn] = [Math.cos(a), Math.sin(a)];
      return (p: Vec2): Vec2 => {
        const v = sub(p, c);
        return [c[0] + v[0] * cs - v[1] * sn, c[1] + v[0] * sn + v[1] * cs];
      };
    });
  } else {
    if (index.kind(spec.direction) !== 'line') return fail('La dirección del patrón tiene que ser una línea o un eje');
    if (!(spec.spacing !== 0)) return fail('La separación no puede ser 0');
    const [a, bb] = lineEnds(index, spec.direction);
    const u = mul(sub(bb, a), 1 / dist(a, bb));
    tfs = Array.from({ length: count - 1 }, (_, k) => (p: Vec2) => add(p, mul(u, spec.spacing * (k + 1))));
  }

  const b = new SketchBuilder(data);
  const created: SketchEntityId[] = [];
  const centerFixed = spec.kind === 'circular' ? spec.center : null;
  for (const tf of tfs) {
    const { points, curves } = copyGeometry(b, index, geo, tf, false, (id) => (id === centerFixed ? id : null));
    for (const [orig, copy] of curves) {
      created.push(copy);
      if (index.get(orig)?.type === 'circle') b.constrain({ type: 'equal', a: orig, b: copy });
    }
    for (const [orig, copy] of points) if (orig !== copy && index.get(orig)?.type === 'point' && geo.includes(orig)) created.push(copy);
  }
  return { ok: true, data: b.data, created };
}
