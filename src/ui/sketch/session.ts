// Estado y lógica del editor de sketch (sin DOM). La vista (SketchEditor) traduce eventos a estas acciones.
import { batch, createSignal } from 'solid-js';
import { AXIS_X, AXIS_Y, ORIGIN, type SketchConstraint, type SketchConstraintType, type SketchData, type SketchEntityId, type SketchSpline, type SketchText } from '../../document/types';
import { SketchBuilder } from '../../sketch/builders';
import { filletCorner, mirrorCurves, offsetCurves, patternCurves, trimCurve, type EditResult } from '../../sketch/edit';
import { dist, sub } from '../../sketch/geometry';
import { removeItems, SketchIndex, type Vec2, curvePoints } from '../../sketch/model';
import { constraintFromSelection, DIMENSIONAL, displayValue, withValue } from '../../sketch/rules';
import { solveSketch, type SolveResult } from '../../sketch/solver';
import { evaluateText } from '../../document/evaluate';
import { plainNumber } from '../../document/expressions';

export type Tool = 'select' | 'point' | 'text' | 'line' | 'rectangle' | 'centerRect' | 'circle' | 'arc' | 'polygon' | 'slot' | 'trim' | 'spline' | 'nurbs';

/** Herramientas de edición que piden valores antes de aplicarse. */
export type EditAction = 'offset' | 'fillet' | 'circular' | 'linear';

export interface ActionField {
  label: string;
  value: number;
  unit: string;
  /** Solo enteros (cantidades). */
  integer?: boolean;
}

export interface ActionPrompt {
  action: EditAction;
  title: string;
  fields: ActionField[];
}

/** Posición del cursor, opcionalmente enganchada a un punto existente. */
export interface Anchor {
  pos: Vec2;
  pointId?: SketchEntityId;
}

export type Pending =
  | { tool: 'line'; start: Anchor; chainStart: SketchEntityId | null }
  | { tool: 'rectangle'; corner: Anchor }
  | { tool: 'circle'; center: Anchor }
  | { tool: 'arc'; center: Anchor; start?: Anchor }
  | { tool: 'centerRect'; center: Anchor }
  | { tool: 'polygon'; center: Anchor }
  | { tool: 'slot'; c1: Anchor; c2?: Anchor }
  | { tool: 'spline'; points: Anchor[]; kind: 'fit' | 'control' };

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
  /** Expresión actual de la cota (si tiene). */
  text?: string;
  unit: string;
}

export type Message = { kind: 'hint' | 'error'; text: string } | null;

/** Tolerancia angular para inferir horizontal/vertical al dibujar líneas. */
const AUTO_HV_DEG = 2;

type NewConstraint = Parameters<SketchBuilder['constrain']>[0];

export interface SessionOptions {
  /** Expresiones de cotas, por id de restricción. */
  exprs?: Record<string, string>;
  /** Valores de los parámetros, para evaluar expresiones en las cotas. */
  scope?: () => ReadonlyMap<string, number>;
  /** Unidad de longitud para mostrar en las cotas ('mm', 'in', 'cm', etc.). */
  unit?: () => string;
}

/** Estado completo para deshacer: geometría y expresiones de cotas. */
interface Snapshot {
  data: SketchData;
  exprs: Record<string, string>;
}

export function createSketchSession(initial: SketchData, options: SessionOptions = {}) {
  const lengthUnit = () => options.unit?.() ?? 'mm';
  const [exprs, setExprs] = createSignal<Record<string, string>>(options.exprs ?? {});
  const first = safeSolve(initial);
  const [data, setData] = createSignal<SketchData>(first.result?.ok ? first.result.data : initial);
  const [info, setInfo] = createSignal<SolveInfo>(toInfo(first.result));
  const [tool, setToolSignal] = createSignal<Tool>('select');
  const [construction, setConstruction] = createSignal(false);
  /** Lados del polígono regular. */
  const [polygonSides, setPolygonSides] = createSignal(6);
  /** Texto, altura y negrita para la herramienta Texto. */
  const [textOptions, setTextOptions] = createSignal({ text: 'Texto', height: 10, bold: true });

  /** Cambia un texto ya ubicado (contenido, altura, ángulo, negrita). */
  function updateText(id: SketchEntityId, patch: Partial<Pick<SketchText, 'text' | 'height' | 'angle' | 'bold'>>) {
    const d = data();
    commit({ ...d, entities: d.entities.map((e) => (e.id === id && e.type === 'text' ? { ...e, ...patch } : e)) }, { allowRedundant: true });
  }
  const [selection, setSelection] = createSignal<string[]>([]);
  const [pending, setPending] = createSignal<Pending | null>(null);
  const [message, setMessage] = createSignal<Message>(first.error ? { kind: 'error', text: first.error } : null);
  const [prompt, setPrompt] = createSignal<DimensionPrompt | null>(null);
  const [actionPrompt, setActionPrompt] = createSignal<ActionPrompt | null>(null);
  const [dirty, setDirty] = createSignal(false);

  const undoStack: Snapshot[] = [];
  const redoStack: Snapshot[] = [];
  const snap = (d: SketchData = data()): Snapshot => ({ data: d, exprs: exprs() });
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
      undoStack.push(snap());
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
      setActionPrompt(null);
      if (t !== 'select') setSelection([]);
      setMessage(t === 'select' ? null : { kind: 'hint', text: TOOL_HINTS[t] });
    });
  }

  /** Clic con una herramienta de dibujo. */
  function click(at: Anchor) {
    const p = pending();
    switch (tool()) {
      case 'select':
      case 'trim':
        return;
      case 'text': {
        // Texto anclado en el punto (o en uno existente, si se hizo clic sobre él).
        const opts = textOptions();
        if (!opts.text.trim()) {
          setMessage({ kind: 'hint', text: 'Escribí el texto arriba antes de ubicarlo' });
          return;
        }
        const b = new SketchBuilder(data());
        const point = b.point(at.pointId ?? at.pos);
        const id = nextTextId(data());
        const next = { ...b.data, entities: [...b.data.entities, { id, type: 'text' as const, point, text: opts.text, height: opts.height, angle: 0, bold: opts.bold }] };
        if (commit(next)) setSelection([id]);
        return;
      }
      case 'point': {
        // Un punto suelto (centro de agujero). Sobre un punto existente no agrega nada.
        if (at.pointId) return;
        const b = new SketchBuilder(data());
        b.point(at.pos);
        commit(b.data);
        return;
      }
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
      case 'centerRect': {
        if (!p || p.tool !== 'centerRect') {
          setPending({ tool: 'centerRect', center: at });
          return;
        }
        const [w, h] = sub(at.pos, p.center.pos).map(Math.abs);
        if (w < 1e-6 || h < 1e-6) return;
        const b = new SketchBuilder(data());
        b.centerRectangle(p.center.pointId ?? p.center.pos, at.pos, construction());
        if (commit(b.data)) setPending(null);
        return;
      }
      case 'polygon': {
        if (!p || p.tool !== 'polygon') {
          setPending({ tool: 'polygon', center: at });
          return;
        }
        if (dist(p.center.pos, at.pos) < 1e-6) return;
        const b = new SketchBuilder(data());
        b.polygon(p.center.pointId ?? p.center.pos, at.pos, polygonSides(), construction());
        if (commit(b.data)) setPending(null);
        return;
      }
      case 'spline':
      case 'nurbs': {
        if (!p || p.tool !== 'spline') {
          setPending({ tool: 'spline', points: [at], kind: tool() === 'nurbs' ? 'control' : 'fit' });
          return;
        }
        const first = p.points[0];
        const last = p.points[p.points.length - 1];
        const same = (a: Anchor, b: Anchor) => (a.pointId && a.pointId === b.pointId) || dist(a.pos, b.pos) < 1e-9;
        // Clic en el primer punto: cierra. Clic otra vez en el último: termina abierta.
        if (p.points.length >= 3 && same(at, first)) return finishSpline(true);
        if (same(at, last)) return finishSpline(false);
        setPending({ ...p, points: [...p.points, at] });
        return;
      }
      case 'slot': {
        if (!p || p.tool !== 'slot') {
          setPending({ tool: 'slot', c1: at });
          return;
        }
        if (!p.c2) {
          if (dist(p.c1.pos, at.pos) < 1e-6) return;
          setPending({ ...p, c2: at });
          return;
        }
        // Tercer clic: el ancho (distancia del cursor a la línea entre centros).
        const r = slotRadius(p.c1.pos, p.c2.pos, at.pos);
        if (r < 1e-6) return;
        const b = new SketchBuilder(data());
        b.slot(p.c1.pointId ?? p.c1.pos, p.c2.pointId ?? p.c2.pos, r, construction());
        if (commit(b.data)) setPending(null);
        return;
      }
    }
  }

  /** Termina la spline en curso (con al menos 2 puntos). */
  function finishSpline(closed: boolean) {
    const p = pending();
    if (!p || p.tool !== 'spline') return;
    if (p.points.length < 2) return setPending(null);
    const b = new SketchBuilder(data());
    const id = b.spline(p.points.map((a) => a.pointId ?? a.pos), closed && p.points.length >= 3, construction(), { kind: p.kind });
    if (commit(b.data)) {
      setPending(null);
      setSelection([id]);
    }
  }

  /** Enter: termina lo que se está dibujando (la spline queda abierta). */
  function finishPending() {
    if (pending()?.tool === 'spline') finishSpline(false);
    else setPending(null);
  }

  /** Esc: cancela el dibujo en curso; si no hay, limpia la selección; si no, vuelve a seleccionar. */
  function escape() {
    if (prompt()) return setPrompt(null);
    if (actionPrompt()) return setActionPrompt(null);
    const sp = pending();
    if (sp?.tool === 'spline' && sp.points.length >= 2) return finishSpline(false);
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
    const pointIds = e.type === 'point' ? [e.id] : curvePoints(e);
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
      undoStack.push(snap(dragBase.data));
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
      setPrompt({ create: rule.constraints, value: round(rule.value ?? 0), unit: type === 'angle' ? '°' : lengthUnit() });
      return;
    }
    const b = new SketchBuilder(data());
    for (const c of rule.constraints) b.constrain(c as NewConstraint);
    if (commit(b.data)) setSelection([]);
  }

  function editDimension(id: string) {
    const c = data().constraints.find((x) => x.id === id);
    if (!c || !('value' in c)) return;
    setPrompt({ editId: id, value: round(displayValue(c, data())), text: exprs()[id], unit: c.type === 'angle' ? '°' : lengthUnit() });
  }

  /** Confirma la cota escrita: un número, o una expresión con parámetros (`largo / 2`). */
  function confirmPrompt(text: string) {
    const p = prompt();
    if (!p) return;
    let value: number;
    let expr: string | undefined;
    try {
      const n = plainNumber(text);
      if (n !== null) value = n;
      else {
        value = evaluateText(text, options.scope?.() ?? new Map());
        expr = text.trim();
      }
    } catch (err) {
      setMessage({ kind: 'error', text: (err as Error).message });
      return;
    }
    if (!(value > 0) && p.unit !== '°') {
      setMessage({ kind: 'error', text: `La cota debe ser mayor que 0 (da ${value})` });
      return;
    }
    const setExpr = (id: string) =>
      setExprs((m) => {
        const next = { ...m };
        if (expr) next[id] = expr;
        else delete next[id];
        return next;
      });
    let ok: boolean;
    if (p.editId) {
      const next = {
        ...data(),
        constraints: data().constraints.map((c) => (c.id === p.editId && 'value' in c ? (withValue(c, value, data()) as SketchConstraint) : c)),
      };
      ok = commit(next, { allowRedundant: true });
      if (ok) setExpr(p.editId);
    } else {
      const b = new SketchBuilder(data());
      const ids = (p.create ?? []).map((c) => b.constrain(withValue(c as NewConstraint, value, data())));
      ok = commit(b.data);
      if (ok) {
        ids.forEach(setExpr);
        setSelection([]);
      }
    }
    if (ok) setPrompt(null);
  }

  // ------------------------------------------------------------ herramientas de edición

  /** Aplica una edición; la geometría nueva queda elegida. */
  function applyEdit(r: EditResult): boolean {
    if (!r.ok) {
      setMessage({ kind: 'error', text: r.error });
      return false;
    }
    if (!commit(r.data, { allowRedundant: true })) return false;
    setSelection(r.created);
    return true;
  }

  /** Recortar: clic sobre el tramo de curva a borrar. */
  function trimAt(curveId: SketchEntityId | null, at: Vec2) {
    if (!curveId) {
      setMessage({ kind: 'hint', text: TOOL_HINTS.trim });
      return;
    }
    if (applyEdit(trimCurve(data(), curveId, at))) setSelection([]);
  }

  /** Simetría o pedido de valores para desfase, redondeo de esquina y patrones. */
  function startEdit(action: EditAction | 'mirror') {
    const sel = selection().filter((id) => isEntity(id));
    const index = new SketchIndex(data());
    const last = sel[sel.length - 1];
    if (action === 'mirror') {
      if (sel.length < 2 || index.kind(last) !== 'line') {
        setMessage({ kind: 'hint', text: 'Simetría: elegí la geometría y, al final, la línea o el eje de simetría' });
        return;
      }
      applyEdit(mirrorCurves(data(), sel.slice(0, -1), last));
      return;
    }
    if (!sel.length) {
      setMessage({ kind: 'hint', text: EDIT_HINTS[action] });
      return;
    }
    const prompts: Record<EditAction, ActionPrompt> = {
      offset: { action, title: 'Desfase', fields: [{ label: 'Distancia (negativa: hacia adentro)', value: 2, unit: lengthUnit() }] },
      fillet: { action, title: 'Redondeo de esquina', fields: [{ label: 'Radio', value: 2, unit: lengthUnit() }] },
      circular: { action, title: 'Patrón circular', fields: [{ label: 'Cantidad', value: 6, unit: '', integer: true }, { label: 'Ángulo total', value: 360, unit: '°' }] },
      linear: { action, title: 'Patrón lineal', fields: [{ label: 'Cantidad', value: 3, unit: '', integer: true }, { label: 'Separación', value: 10, unit: lengthUnit() }] },
    };
    setActionPrompt(prompts[action]);
    setMessage({ kind: 'hint', text: EDIT_HINTS[action] });
  }

  /** Confirma los valores (números o expresiones con parámetros) y aplica la edición. */
  function confirmAction(texts: string[]) {
    const p = actionPrompt();
    if (!p) return;
    const values: number[] = [];
    for (const [i, f] of p.fields.entries()) {
      try {
        const t = texts[i] ?? String(f.value);
        const v = plainNumber(t) ?? evaluateText(t, options.scope?.() ?? new Map());
        values.push(f.integer ? Math.round(v) : v);
      } catch (err) {
        setMessage({ kind: 'error', text: `${f.label}: ${(err as Error).message}` });
        return;
      }
    }
    const sel = selection().filter((id) => isEntity(id));
    const index = new SketchIndex(data());
    const last = sel[sel.length - 1];
    let r: EditResult;
    switch (p.action) {
      case 'offset':
        r = offsetCurves(data(), sel, values[0]);
        break;
      case 'fillet':
        r = filletCorner(data(), sel, values[0]);
        break;
      case 'circular': {
        // Centro: el último punto elegido (si se eligió algo más), o el origen.
        const center = sel.length > 1 && index.kind(last) === 'point' ? last : ORIGIN;
        r = patternCurves(data(), sel.filter((id) => id !== center), { kind: 'circular', center, count: values[0], angle: values[1] });
        break;
      }
      case 'linear': {
        // Dirección: un eje o una línea de construcción elegida al final; si no, el eje X.
        const e = index.get(last);
        const isDir = sel.length > 1 && (last === AXIS_X || last === AXIS_Y || (e?.type === 'line' && e.construction));
        const direction = isDir ? last : AXIS_X;
        r = patternCurves(data(), sel.filter((id) => id !== direction), { kind: 'linear', direction, count: values[0], spacing: values[1] });
        break;
      }
    }
    if (applyEdit(r)) setActionPrompt(null);
  }

  /** Expresiones de cotas que siguen existiendo, con la ruta que usa el documento. */
  function documentExprs(): Record<string, string> {
    const alive = new Set(data().constraints.map((c) => c.id));
    return Object.fromEntries(Object.entries(exprs()).filter(([id]) => alive.has(id)).map(([id, t]) => [`constraint:${id}`, t]));
  }

  function deleteSelection() {
    const ids = selection();
    if (!ids.length) return;
    if (commit(removeItems(data(), ids), { allowRedundant: true })) setSelection([]);
  }

  function toggleConstruction() {
    const ids = new Set(selection());
    const curves = data().entities.filter((e) => ids.has(e.id) && e.type !== 'point' && e.type !== 'text');
    if (!curves.length) {
      setMessage({ kind: 'hint', text: 'Elegí líneas, círculos o arcos para alternar construcción' });
      return;
    }
    const value = !curves.every((c) => c.type !== 'point' && c.type !== 'text' && c.construction);
    commit({
      ...data(),
      entities: data().entities.map((e) => (ids.has(e.id) && e.type !== 'point' && e.type !== 'text' ? { ...e, construction: value } : e)),
    }, { allowRedundant: true });
  }

  /** Cambia el tipo (por puntos o NURBS) o el grado de la spline elegida. */
  function setSplineShape(id: SketchEntityId, shape: { kind?: 'fit' | 'control'; degree?: number }) {
    const e = data().entities.find((x) => x.id === id);
    if (e?.type !== 'spline') return;
    const next: SketchSpline = { ...e, ...shape };
    if (next.kind !== 'control') {
      delete next.kind;
      delete next.degree;
    }
    commit({ ...data(), entities: data().entities.map((x) => (x.id === id ? next : x)) }, { allowRedundant: true });
    setSelection([id]);
  }

  function undo() {
    const prev = undoStack.pop();
    if (!prev) return;
    redoStack.push(snap());
    restore(prev);
  }

  function redo() {
    const next = redoStack.pop();
    if (!next) return;
    undoStack.push(snap());
    restore(next);
  }

  function restore(s: Snapshot) {
    const d = s.data;
    const { result } = safeSolve(d);
    batch(() => {
      setData(d);
      setExprs(s.exprs);
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
    data, exprs, documentExprs, info, tool, construction, selection, pending, message, prompt, actionPrompt, dirty, historySize,
    polygonSides, setPolygonSides, textOptions, setTextOptions, updateText,
    setTool, setConstruction, setMessage, setPrompt,
    click, escape, select, beginDrag, drag, endDrag,
    applyConstraint, editDimension, confirmPrompt, deleteSelection, toggleConstruction, setSplineShape, undo, redo,
    trimAt, startEdit, confirmAction, setActionPrompt, finishPending,
  };
}

export type SketchSession = ReturnType<typeof createSketchSession>;

const TOOL_HINTS: Record<Exclude<Tool, 'select'>, string> = {
  point: 'Punto: clic donde va cada centro de agujero (después, Agujero los usa todos).',
  text: 'Texto: escribilo arriba y hacé clic donde empieza (esquina inferior izquierda). Se graba o se pone en relieve extruyendo.',
  line: 'Línea: clic en el inicio y en cada vértice. Esc termina; clic en el primer punto cierra.',
  rectangle: 'Rectángulo: clic en dos esquinas opuestas.',
  circle: 'Círculo: clic en el centro y luego en un punto del borde.',
  arc: 'Arco: clic en el centro, el inicio y el final (sentido antihorario).',
  centerRect: 'Rectángulo desde el centro: clic en el centro y luego en una esquina.',
  polygon: 'Polígono regular: clic en el centro y luego en un vértice.',
  slot: 'Ranura: clic en los dos centros y luego para el ancho.',
  trim: 'Recortar: clic en el tramo a borrar; se corta hasta las intersecciones más cercanas.',
  spline: 'Spline: clic en cada punto por donde pasa. Enter, Esc o clic otra vez en el último punto termina; clic en el primero la cierra.',
  nurbs: 'Curva NURBS: clic en cada punto de control (la curva pasa por el primero y el último y se acerca a los demás). Enter, Esc o clic otra vez en el último termina; clic en el primero la cierra.',
};

const EDIT_HINTS: Record<EditAction, string> = {
  offset: 'Desfase: elegí las líneas, arcos o círculos del contorno.',
  fillet: 'Redondeo de esquina: elegí el vértice entre dos líneas, o las dos líneas.',
  circular: 'Patrón circular: elegí la geometría y, al final, el punto central (si no, el origen).',
  linear: 'Patrón lineal: elegí la geometría y, al final, un eje o una línea de construcción como dirección (si no, el eje X).',
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

/** Radio de una ranura: distancia del punto a la recta que une los centros. */
export function slotRadius(c1: Vec2, c2: Vec2, p: Vec2): number {
  const d = sub(c2, c1);
  const L = Math.hypot(d[0], d[1]);
  if (L < 1e-12) return 0;
  return Math.abs(d[0] * (p[1] - c1[1]) - d[1] * (p[0] - c1[0])) / L;
}

/** Próximo id libre para un texto (t1, t2…). */
function nextTextId(d: SketchData): string {
  const used = new Set(d.entities.map((e) => e.id));
  let n = 1;
  while (used.has(`t${n}`)) n++;
  return `t${n}`;
}
