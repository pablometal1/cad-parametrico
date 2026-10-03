// Estado y lógica del editor de sketch (sin DOM). La vista (SketchEditor) traduce eventos a estas acciones.
import { batch, createSignal } from 'solid-js';
import type { SketchConstraint, SketchConstraintType, SketchData, SketchEntityId } from '../../document/types';
import { SketchBuilder } from '../../sketch/builders';
import { dist, sub } from '../../sketch/geometry';
import { removeItems, SketchIndex, type Vec2 } from '../../sketch/model';
import { constraintFromSelection, DIMENSIONAL, displayValue, withValue } from '../../sketch/rules';
import { solveSketch, type SolveResult } from '../../sketch/solver';

export type Tool = 'select' | 'line' | 'rectangle' | 'circle' | 'arc';

/** Posición del cursor, opcionalmente enganchada a un punto existente. */
export interface Anchor {
  pos: Vec2;
  pointId?: SketchEntityId;
}

export type Pending =
  | { tool: 'line'; start: Anchor; chainStart: SketchEntityId | null }
  | { tool: 'rectangle'; corner: Anchor }
  | { tool: 'circle'; center: Anchor }
  | { tool: 'arc'; center: Anchor; start?: Anchor };

export interface SolveInfo {
  ok: boolean;
  dof: number;
  conflicting: string[];
  redundant: string[];
}

export interface DimensionPrompt {
  /** Restricciones a crear (nueva cota) o id de la cota a editar. */
  create?: Omit<SketchConstraint, 'id'>[];
  editId?: string;
  value: number;
  unit: 'mm' | '°';
}

export type Message = { kind: 'hint' | 'error'; text: string } | null;

/** Tolerancia angular para inferir horizontal/vertical al dibujar líneas. */
const AUTO_HV_DEG = 2;

type NewConstraint = Parameters<SketchBuilder['constrain']>[0];

export function createSketchSession(initial: SketchData) {
  const first = safeSolve(initial);
  const [data, setData] = createSignal<SketchData>(first.result?.ok ? first.result.data : initial);
  const [info, setInfo] = createSignal<SolveInfo>(toInfo(first.result));
  const [tool, setToolSignal] = createSignal<Tool>('select');
  const [construction, setConstruction] = createSignal(false);
  const [selection, setSelection] = createSignal<string[]>([]);
  const [pending, setPending] = createSignal<Pending | null>(null);
  const [message, setMessage] = createSignal<Message>(first.error ? { kind: 'error', text: first.error } : null);
  const [prompt, setPrompt] = createSignal<DimensionPrompt | null>(null);
  const [dirty, setDirty] = createSignal(false);

  const undoStack: SketchData[] = [];
  const redoStack: SketchData[] = [];
  const [historySize, setHistorySize] = createSignal({ undo: 0, redo: 0 });
  const syncHistory = () => setHistorySize({ undo: undoStack.length, redo: redoStack.length });

  /**
   * Resuelve y aplica un cambio. Si el sketch estaba bien y el cambio lo rompe
   * (conflicto, redundancia o sin solución), lo rechaza y deja un mensaje.
   */
  function commit(next: SketchData, opts: { allowRedundant?: boolean; quiet?: boolean } = {}): boolean {
    const { result, error } = safeSolve(next);
    const wasOk = info().ok && info().conflicting.length === 0;
    if (wasOk) {
      if (error || !result) return reject(error ?? 'No se pudo resolver el sketch', opts.quiet);
      if (!result.ok || result.conflicting.length) return reject('Ese cambio genera restricciones en conflicto', opts.quiet);
      if (!opts.allowRedundant && result.redundant.length > info().redundant.length) {
        return reject('Esa restricción es redundante: ya está implicada por otras', opts.quiet);
      }
    }
    batch(() => {
      undoStack.push(data());
      redoStack.length = 0;
      syncHistory();
      setData(result?.ok ? result.data : next);
      setInfo(toInfo(result));
      setDirty(true);
      if (!opts.quiet) setMessage(error ? { kind: 'error', text: error } : null);
    });
    return true;
  }

  function reject(text: string, quiet?: boolean): false {
    if (!quiet) setMessage({ kind: 'error', text });
    return false;
  }

  // ------------------------------------------------------------ herramientas de dibujo

  function setTool(t: Tool) {
    batch(() => {
      setToolSignal(t);
      setPending(null);
      if (t !== 'select') setSelection([]);
      setMessage(t === 'select' ? null : { kind: 'hint', text: TOOL_HINTS[t] });
    });
  }

  /** Clic con una herramienta de dibujo. */
  function click(at: Anchor) {
    const p = pending();
    switch (tool()) {
      case 'select':
        return;
      case 'line': {
        if (!p || p.tool !== 'line') {
          setPending({ tool: 'line', start: at, chainStart: null });
          return;
        }
        if (dist(p.start.pos, at.pos) < 1e-9) return;
        const b = new SketchBuilder(data());
        const startId = b.point(p.start.pointId ?? p.start.pos);
        const endId = b.point(at.pointId ?? at.pos);
        const lineId = b.line(startId, endId, construction());
        const hv = inferHV(p.start.pos, at.pos);
        const withAuto = hv ? new SketchBuilder(b.data) : null;
        withAuto?.constrain(hv === 'h' ? { type: 'horizontal', line: lineId } : { type: 'vertical', line: lineId });
        // Con la restricción automática primero; si es redundante o choca, sin ella.
        const done = (withAuto && commit(withAuto.data, { quiet: true })) || commit(b.data);
        if (!done) return;
        const chainStart = p.chainStart ?? startId;
        // Cerrar el contorno al volver al punto inicial termina la cadena.
        if (at.pointId && at.pointId === chainStart) setPending(null);
        else setPending({ tool: 'line', start: { pos: at.pos, pointId: endId }, chainStart });
        return;
      }
      case 'rectangle': {
        if (!p || p.tool !== 'rectangle') {
          setPending({ tool: 'rectangle', corner: at });
          return;
        }
        const [w, h] = sub(at.pos, p.corner.pos).map(Math.abs);
        if (w < 1e-6 || h < 1e-6) return;
        const b = new SketchBuilder(data());
        const lines = b.rectangle(p.corner.pos, at.pos, construction());
        // Esquinas enganchadas a puntos existentes: restricción de coincidencia.
        const corners = cornerPoints(b.data, lines);
        for (const a of [p.corner, at]) {
          if (!a.pointId) continue;
          const corner = corners.find((c) => dist(c.pos, a.pos) < 1e-9);
          if (corner) b.constrain({ type: 'coincident', a: corner.id, b: a.pointId });
        }
        if (commit(b.data)) setPending(null);
        return;
      }
      case 'circle': {
        if (!p || p.tool !== 'circle') {
          setPending({ tool: 'circle', center: at });
          return;
        }
        const r = dist(p.center.pos, at.pos);
        if (r < 1e-6) return;
        const b = new SketchBuilder(data());
        b.circle(p.center.pointId ?? p.center.pos, r, construction());
        if (commit(b.data)) setPending(null);
        return;
      }
      case 'arc': {
        if (!p || p.tool !== 'arc') {
          setPending({ tool: 'arc', center: at });
          return;
        }
        if (!p.start) {
          if (dist(p.center.pos, at.pos) < 1e-6) return;
          setPending({ ...p, start: at });
          return;
        }
        const b = new SketchBuilder(data());
        const positions = new Map<string, Vec2>([
          [p.center.pointId ?? '', p.center.pos],
          [p.start.pointId ?? '', p.start.pos],
          [at.pointId ?? '', at.pos],
        ]);
        b.arc(p.center.pointId ?? p.center.pos, p.start.pointId ?? p.start.pos, at.pointId ?? at.pos, construction(), positions);
        if (commit(b.data)) setPending(null);
        return;
      }
    }
  }

  /** Esc: cancela el dibujo en curso; si no hay, limpia la selección; si no, vuelve a seleccionar. */
  function escape() {
    if (prompt()) return setPrompt(null);
    if (pending()) return setPending(null);
    if (selection().length) return setSelection([]);
    if (tool() !== 'select') setTool('select');
  }

  // ------------------------------------------------------------ selección y arrastre

  function select(id: string | null, additive: boolean) {
    if (id === null) {
      if (!additive) setSelection([]);
      return;
    }
    const cur = selection();
    if (additive) setSelection(cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
    else setSelection([id]);
  }

  let dragBase: { data: SketchData; points: { id: SketchEntityId; from: Vec2 }[]; origin: Vec2; moved: boolean } | null = null;

  /** Empieza a arrastrar: un punto, o una curva (se mueven sus puntos de definición). */
  function beginDrag(id: SketchEntityId, at: Vec2) {
    const index = new SketchIndex(data());
    const e = index.get(id);
    if (!e) return; // origen/ejes: no se arrastran
    const pointIds = e.type === 'point' ? [e.id] : e.type === 'line' ? [e.p1, e.p2] : e.type === 'circle' ? [e.center] : [e.center, e.start, e.end];
    dragBase = { data: data(), points: pointIds.map((p) => ({ id: p, from: index.point(p) })), origin: at, moved: false };
  }

  function drag(at: Vec2) {
    if (!dragBase) return;
    const d = sub(at, dragBase.origin);
    const targets = dragBase.points.map((p) => ({ point: p.id, to: [p.from[0] + d[0], p.from[1] + d[1]] as Vec2 }));
    const { result } = safeSolve(dragBase.data, targets);
    if (result?.ok) {
      setData(result.data);
      dragBase.moved = true;
    }
  }

  function endDrag() {
    if (!dragBase) return;
    if (dragBase.moved) {
      undoStack.push(dragBase.data);
      redoStack.length = 0;
      syncHistory();
      setDirty(true);
      // Re-resolver sin restricciones temporales para actualizar los grados de libertad.
      const { result } = safeSolve(data());
      if (result) setInfo(toInfo(result));
    }
    dragBase = null;
  }

  // ------------------------------------------------------------ restricciones

  function applyConstraint(type: SketchConstraintType) {
    const rule = constraintFromSelection(type, data(), selection().filter((id) => isEntity(id)));
    if (!rule.ok) {
      setMessage({ kind: 'hint', text: rule.hint });
      return;
    }
    if (DIMENSIONAL.has(type)) {
      setPrompt({ create: rule.constraints, value: round(rule.value ?? 0), unit: type === 'angle' ? '°' : 'mm' });
      return;
    }
    const b = new SketchBuilder(data());
    for (const c of rule.constraints) b.constrain(c as NewConstraint);
    if (commit(b.data)) setSelection([]);
  }

  function editDimension(id: string) {
    const c = data().constraints.find((x) => x.id === id);
    if (!c || !('value' in c)) return;
    setPrompt({ editId: id, value: round(displayValue(c, data())), unit: c.type === 'angle' ? '°' : 'mm' });
  }

  function confirmPrompt(value: number) {
    const p = prompt();
    if (!p) return;
    if (!(value > 0) && p.unit === 'mm') {
      setMessage({ kind: 'error', text: 'La cota debe ser mayor que 0' });
      return;
    }
    let ok: boolean;
    if (p.editId) {
      const next = {
        ...data(),
        constraints: data().constraints.map((c) => (c.id === p.editId && 'value' in c ? (withValue(c, value, data()) as SketchConstraint) : c)),
      };
      ok = commit(next, { allowRedundant: true });
    } else {
      const b = new SketchBuilder(data());
      for (const c of p.create ?? []) b.constrain(withValue(c as NewConstraint, value, data()));
      ok = commit(b.data);
      if (ok) setSelection([]);
    }
    if (ok) setPrompt(null);
  }

  function deleteSelection() {
    const ids = selection();
    if (!ids.length) return;
    if (commit(removeItems(data(), ids), { allowRedundant: true })) setSelection([]);
  }

  function toggleConstruction() {
    const ids = new Set(selection());
    const curves = data().entities.filter((e) => ids.has(e.id) && e.type !== 'point');
    if (!curves.length) {
      setMessage({ kind: 'hint', text: 'Elegí líneas, círculos o arcos para alternar construcción' });
      return;
    }
    const value = !curves.every((c) => c.type !== 'point' && c.construction);
    commit({
      ...data(),
      entities: data().entities.map((e) => (ids.has(e.id) && e.type !== 'point' ? { ...e, construction: value } : e)),
    }, { allowRedundant: true });
  }

  function undo() {
    const prev = undoStack.pop();
    if (!prev) return;
    redoStack.push(data());
    restore(prev);
  }

  function redo() {
    const next = redoStack.pop();
    if (!next) return;
    undoStack.push(data());
    restore(next);
  }

  function restore(d: SketchData) {
    const { result } = safeSolve(d);
    batch(() => {
      setData(d);
      setInfo(toInfo(result));
      setSelection([]);
      setPending(null);
      setDirty(true);
      syncHistory();
    });
  }

  function isEntity(id: string) {
    return !data().constraints.some((c) => c.id === id);
  }

  return {
    data, info, tool, construction, selection, pending, message, prompt, dirty, historySize,
    setTool, setConstruction, setMessage, setPrompt,
    click, escape, select, beginDrag, drag, endDrag,
    applyConstraint, editDimension, confirmPrompt, deleteSelection, toggleConstruction, undo, redo,
  };
}

export type SketchSession = ReturnType<typeof createSketchSession>;

const TOOL_HINTS: Record<Exclude<Tool, 'select'>, string> = {
  line: 'Línea: clic en el inicio y en cada vértice. Esc termina; clic en el primer punto cierra.',
  rectangle: 'Rectángulo: clic en dos esquinas opuestas.',
  circle: 'Círculo: clic en el centro y luego en un punto del borde.',
  arc: 'Arco: clic en el centro, el inicio y el final (sentido antihorario).',
};

function safeSolve(d: SketchData, drag?: Parameters<typeof solveSketch>[1]): { result?: SolveResult; error?: string } {
  try {
    return { result: solveSketch(d, drag) };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

function toInfo(r: SolveResult | undefined): SolveInfo {
  if (!r) return { ok: false, dof: 0, conflicting: [], redundant: [] };
  return { ok: r.ok, dof: r.dof, conflicting: r.conflicting, redundant: r.redundant };
}

function inferHV(a: Vec2, b: Vec2): 'h' | 'v' | null {
  const ang = Math.abs((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI);
  if (ang < AUTO_HV_DEG || ang > 180 - AUTO_HV_DEG) return 'h';
  if (Math.abs(ang - 90) < AUTO_HV_DEG) return 'v';
  return null;
}

function cornerPoints(d: SketchData, lines: string[]) {
  const index = new SketchIndex(d);
  return lines.map((l) => {
    const e = index.get(l) as { p1: string };
    return { id: e.p1, pos: index.point(e.p1) };
  });
}

function round(v: number) {
  return Math.round(v * 1000) / 1000;
}
