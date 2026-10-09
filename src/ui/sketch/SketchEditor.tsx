// Editor 2D de sketch: dibujo, selección, arrastre con el solver y restricciones.
import { flattenContour, fontsLoaded, textContours } from '../../sketch/text';
import { Icon, tip, type IconName } from '../icons';
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack, type JSX } from 'solid-js';
import { AXIS_X, AXIS_Y, ORIGIN, type SketchConstraint, type SketchConstraintType, type SketchCurve, type SketchData } from '../../document/types';
import { add, arcParams, curveDistance, curveMidpoint, dist, lerp, lineEnds, mul, splinePolyline, sub, type ArcParams } from '../../sketch/geometry';
import { sampleSpline } from '../../sketch/spline';
import { SketchIndex, type Vec2 } from '../../sketch/model';
import { CONSTRAINT_LABELS, dimensionText } from '../../sketch/rules';
import { previewSegments2D } from '../draw3d/preview';
import type { Anchor, EditAction, SketchSession, Tool } from './session';

interface View {
  cx: number;
  cy: number;
  /** Píxeles por mm. */
  scale: number;
}

const POINT_HIT_PX = 8;
const CURVE_HIT_PX = 6;
const LABEL_HIT_PX = 11;
const DRAG_THRESHOLD_PX = 3;

const TOOLS: { id: Tool; label: string; key: string; icon: IconName }[] = [
  { id: 'select', label: 'Seleccionar', key: 'Esc', icon: 'select' },
  { id: 'point', label: 'Punto (centro de agujero)', key: 'O', icon: 'point' },
  { id: 'text', label: 'Texto', key: 'T', icon: 'text' },
  { id: 'line', label: 'Línea', key: 'L', icon: 'line' },
  { id: 'rectangle', label: 'Rectángulo', key: 'R', icon: 'rectangle' },
  { id: 'circle', label: 'Círculo', key: 'C', icon: 'circle' },
  { id: 'arc', label: 'Arco', key: 'A', icon: 'arc' },
  { id: 'centerRect', label: 'Rectángulo desde el centro', key: 'E', icon: 'centerRect' },
  { id: 'polygon', label: 'Polígono regular', key: 'P', icon: 'polygon' },
  { id: 'slot', label: 'Ranura', key: 'S', icon: 'slot' },
  { id: 'spline', label: 'Spline', key: 'B', icon: 'spline' },
];

/** Herramientas de edición (como en Fusion): se aplican a la selección. */
const EDIT_BUTTONS: { action: EditAction | 'mirror'; label: string; key?: string; icon: IconName; desc: string }[] = [
  { action: 'offset', label: 'Desfase', key: 'D', icon: 'offset', desc: 'Copia paralela del contorno elegido, a una distancia (negativa: hacia adentro)' },
  { action: 'fillet', label: 'Redondeo de esquina', icon: 'sketchFillet', desc: 'Redondear el vértice elegido (o la esquina entre dos líneas) con un arco tangente' },
  { action: 'mirror', label: 'Simetría', key: 'M', icon: 'sketchMirror', desc: 'Reflejar la geometría elegida respecto de la última línea o eje elegido; la copia queda vinculada' },
  { action: 'circular', label: 'Patrón circular', icon: 'patternCircular', desc: 'Repetir la geometría alrededor del último punto elegido (o del origen)' },
  { action: 'linear', label: 'Patrón lineal', icon: 'patternLinear', desc: 'Repetir la geometría a lo largo del eje X, o de un eje o línea de construcción elegido al final' },
];

const CONSTRAINT_BUTTONS: { type: SketchConstraintType; icon: IconName }[] = [
  { type: 'coincident', icon: 'coincident' },
  { type: 'horizontal', icon: 'horizontal' },
  { type: 'vertical', icon: 'vertical' },
  { type: 'parallel', icon: 'parallel' },
  { type: 'perpendicular', icon: 'perpendicular' },
  { type: 'tangent', icon: 'tangent' },
  { type: 'equal', icon: 'equal' },
  { type: 'distance', icon: 'distance' },
  { type: 'radius', icon: 'radius' },
  { type: 'angle', icon: 'angle' },
  { type: 'symmetric', icon: 'symmetric' },
];

const GLYPH: Partial<Record<SketchConstraintType, string>> = {
  coincident: '◉', horizontal: 'H', vertical: 'V', parallel: '∥', perpendicular: '⊥', tangent: 'T', equal: '=', symmetric: '⇋',
};

/** Marca o cota dibujada en pantalla, seleccionable. */
interface Label {
  constraintId: string;
  at: Vec2; // pantalla
  text: string;
  dimension: boolean;
  /** Línea auxiliar de la cota, en pantalla. */
  leader?: [Vec2, Vec2];
}

export function SketchEditor(props: {
  session: SketchSession;
  title: string;
  /** Contorno de la cara de apoyo (segmentos u1,v1,u2,v2…), si el sketch está sobre una cara. */
  reference?: () => Float32Array | undefined;
  onFinish: () => void;
  onCancel: () => void;
}) {
  const s = props.session;
  let svgEl!: SVGSVGElement;
  let promptInput: HTMLInputElement | undefined;
  const [size, setSize] = createSignal({ w: 800, h: 600 });
  const [view, setView] = createSignal<View>({ cx: 0, cy: 0, scale: 4 });
  const [cursor, setCursor] = createSignal<Anchor | null>(null);
  const [hover, setHover] = createSignal<string | null>(null);

  const index = createMemo(() => new SketchIndex(s.data()));
  const fully = createMemo(() => s.info().ok && s.info().conflicting.length === 0 && s.info().dof === 0);

  const toScreen = (p: Vec2): Vec2 => {
    const v = view();
    const { w, h } = size();
    return [w / 2 + (p[0] - v.cx) * v.scale, h / 2 - (p[1] - v.cy) * v.scale];
  };
  const toSketch = (p: Vec2): Vec2 => {
    const v = view();
    const { w, h } = size();
    return [(p[0] - w / 2) / v.scale + v.cx, -(p[1] - h / 2) / v.scale + v.cy];
  };

  // ---------------------------------------------------------------- encuadre y tamaño

  function fit() {
    const idx = index();
    const pts: Vec2[] = [[0, 0]];
    for (const p of idx.points()) pts.push([p.x, p.y]);
    const ref = props.reference?.();
    if (ref) for (let i = 0; i + 1 < ref.length; i += 2) pts.push([ref[i], ref[i + 1]]);
    for (const c of idx.curves()) {
      if (c.type === 'circle') {
        const ctr = idx.point(c.center);
        pts.push([ctr[0] - c.radius, ctr[1] - c.radius], [ctr[0] + c.radius, ctr[1] + c.radius]);
      }
    }
    for (const t of textShapes()) pts.push([t.box[0], t.box[1]], [t.box[2], t.box[3]]);
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of pts) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    const spanX = Math.max(x1 - x0, 20);
    const spanY = Math.max(y1 - y0, 20);
    const { w, h } = size();
    const scale = Math.min(w / (spanX * 1.4), h / (spanY * 1.4));
    setView({ cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, scale });
  }

  // El contorno de la cara de apoyo llega con el primer recálculo: se re-encuadra una vez al recibirlo.
  let fittedToReference = false;
  createEffect(() => {
    const ref = props.reference?.();
    if (!fittedToReference && ref && ref.length > 0) {
      fittedToReference = true;
      untrack(fit);
    }
  });

  onMount(() => {
    const ro = new ResizeObserver(() => {
      const r = svgEl.getBoundingClientRect();
      setSize({ w: Math.max(1, r.width), h: Math.max(1, r.height) });
    });
    ro.observe(svgEl);
    const r = svgEl.getBoundingClientRect();
    setSize({ w: Math.max(1, r.width), h: Math.max(1, r.height) });
    fit();
    window.addEventListener('keydown', onKey);
    onCleanup(() => {
      ro.disconnect();
      window.removeEventListener('keydown', onKey);
    });
  });

  // ---------------------------------------------------------------- etiquetas de restricciones

  const labels = createMemo<Label[]>(() => {
    const idx = index();
    const out: Label[] = [];
    const perEntity = new Map<string, number>();
    const badgeAt = (entity: string, base: Vec2): Vec2 => {
      const k = perEntity.get(entity) ?? 0;
      perEntity.set(entity, k + 1);
      const p = toScreen(base);
      const e = idx.get(entity);
      if (e?.type === 'line') {
        // A lo largo de la línea (la cota de longitud va en la perpendicular, en el medio).
        const [a, b] = [toScreen(idx.point(e.p1)), toScreen(idx.point(e.p2))];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const u: Vec2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
        const along = Math.min(len / 2 - 4, 26 + k * 18);
        return [p[0] + u[0] * along + u[1] * 10, p[1] + u[1] * along - u[0] * 10];
      }
      return [p[0] + 12 + k * 16, p[1] - 12];
    };
    const anchorOf = (id: string): Vec2 => {
      if (id === ORIGIN) return [0, 0];
      if (id === AXIS_X) return [view().cx + 20 / view().scale, 0];
      if (id === AXIS_Y) return [0, view().cy + 20 / view().scale];
      const e = idx.get(id);
      if (!e) return [0, 0];
      return e.type === 'point' ? [e.x, e.y] : e.type === 'text' ? idx.point(e.point) : curveMidpoint(idx, e);
    };

    for (const c of s.data().constraints) {
      try {
        if (c.type === 'distance' || c.type === 'radius' || c.type === 'angle') {
          const label = dimensionLabel(idx, c, toScreen, s.data());
          // Las cotas que vienen de una expresión se marcan con ƒ.
          if (s.exprs()[c.id]) label.text = `ƒ ${label.text}`;
          out.push(label);
          continue;
        }
        const glyph = GLYPH[c.type]!;
        const ids = c.type === 'horizontal' || c.type === 'vertical' ? [c.line] : c.type === 'coincident' ? [c.a] : [c.a, c.b];
        for (const id of ids) out.push({ constraintId: c.id, at: badgeAt(id, anchorOf(id)), text: glyph, dimension: false });
      } catch {
        // Restricción sobre geometría inexistente: no se dibuja (el solver ya la reporta).
      }
    }
    return out;
  });

  // ---------------------------------------------------------------- selección por proximidad

  /** Elemento bajo el cursor (en px de pantalla), con prioridad: puntos, etiquetas, curvas, ejes. */
  function hitTest(screen: Vec2): string | null {
    const idx = index();
    const p = toSketch(screen);
    const scale = view().scale;
    let best: { id: string; d: number } | null = null;
    const consider = (id: string, dPx: number, limit: number) => {
      if (dPx <= limit && (!best || dPx < best.d)) best = { id, d: dPx };
    };
    for (const pt of idx.points()) consider(pt.id, dist(toScreen([pt.x, pt.y]), screen), POINT_HIT_PX);
    consider(ORIGIN, dist(toScreen([0, 0]), screen), POINT_HIT_PX);
    if (best) return (best as { id: string }).id;
    for (const l of labels()) consider(l.constraintId, dist(l.at, screen), LABEL_HIT_PX);
    if (best) return (best as { id: string }).id;
    for (const c of idx.curves()) consider(c.id, curveDistance(idx, c, p) * scale, CURVE_HIT_PX);
    if (best) return (best as { id: string }).id;
    for (const t of textShapes()) {
      if (p[0] >= t.box[0] && p[0] <= t.box[2] && p[1] >= t.box[1] && p[1] <= t.box[3]) return t.id;
    }
    consider(AXIS_X, Math.abs(p[1]) * scale, CURVE_HIT_PX);
    consider(AXIS_Y, Math.abs(p[0]) * scale, CURVE_HIT_PX);
    return best ? (best as { id: string }).id : null;
  }

  /** Curva bajo el cursor (para recortar). */
  function curveHit(screen: Vec2): string | null {
    const idx = index();
    const p = toSketch(screen);
    let best: { id: string; d: number } | null = null;
    for (const c of idx.curves()) {
      const d = curveDistance(idx, c, p) * view().scale;
      if (d <= CURVE_HIT_PX && (!best || d < best.d)) best = { id: c.id, d };
    }
    return best ? (best as { id: string }).id : null;
  }

  /** Posición para dibujar: se engancha a un punto existente si está cerca. */
  function snap(screen: Vec2): Anchor {
    const idx = index();
    let best: { id: string; pos: Vec2; d: number } | null = null;
    const candidates: [string, Vec2][] = [[ORIGIN, [0, 0]], ...idx.points().map((p) => [p.id, [p.x, p.y]] as [string, Vec2])];
    for (const [id, pos] of candidates) {
      const d = dist(toScreen(pos), screen);
      if (d <= POINT_HIT_PX + 2 && (!best || d < best.d)) best = { id, pos, d };
    }
    return best ? { pos: best.pos, pointId: best.id } : { pos: toSketch(screen) };
  }

  // ---------------------------------------------------------------- eventos de puntero

  let pointer: { start: Vec2; button: number; target: string | null; dragging: boolean; panFrom?: View } | null = null;

  const screenOf = (e: PointerEvent | WheelEvent | MouseEvent): Vec2 => {
    const r = svgEl.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  function onPointerDown(e: PointerEvent) {
    svgEl.setPointerCapture(e.pointerId);
    const sp = screenOf(e);
    if (e.button === 1 || e.button === 2) {
      pointer = { start: sp, button: e.button, target: null, dragging: true, panFrom: view() };
      return;
    }
    if (e.button !== 0) return;
    if (s.tool() === 'trim') {
      s.trimAt(curveHit(sp), toSketch(sp));
      setHover(curveHit(sp));
      return;
    }
    if (s.tool() !== 'select') {
      s.click(snap(sp));
      return;
    }
    pointer = { start: sp, button: 0, target: hitTest(sp), dragging: false };
  }

  function onPointerMove(e: PointerEvent) {
    const sp = screenOf(e);
    if (pointer?.panFrom) {
      const v = pointer.panFrom;
      setView({ ...v, cx: v.cx - (sp[0] - pointer.start[0]) / v.scale, cy: v.cy + (sp[1] - pointer.start[1]) / v.scale });
      return;
    }
    if (s.tool() === 'trim') {
      setHover(curveHit(sp));
      return;
    }
    if (s.tool() !== 'select') {
      setCursor(snap(sp));
      return;
    }
    if (pointer && pointer.button === 0) {
      const t = pointer.target;
      const draggable = t !== null && index().get(t) !== undefined;
      if (!pointer.dragging && draggable && dist(sp, pointer.start) > DRAG_THRESHOLD_PX) {
        pointer.dragging = true;
        s.beginDrag(t!, toSketch(pointer.start));
      }
      if (pointer.dragging) s.drag(toSketch(sp));
      return;
    }
    setHover(hitTest(sp));
  }

  function onPointerUp(e: PointerEvent) {
    const p = pointer;
    pointer = null;
    if (!p || p.panFrom) return;
    if (p.dragging) {
      s.endDrag();
      return;
    }
    if (s.tool() === 'select' && p.button === 0) s.select(p.target, e.shiftKey || e.ctrlKey || e.metaKey);
  }

  function onDblClick(e: MouseEvent) {
    const id = hitTest(screenOf(e));
    if (id && s.data().constraints.some((c) => c.id === id && 'value' in c)) s.editDimension(id);
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const sp = screenOf(e);
    const before = toSketch(sp);
    const factor = Math.exp(-e.deltaY * 0.0015);
    const v = view();
    const scale = Math.min(500, Math.max(0.05, v.scale * factor));
    // Mantiene fijo el punto bajo el cursor.
    const { w, h } = size();
    setView({ scale, cx: before[0] - (sp[0] - w / 2) / scale, cy: before[1] + (sp[1] - h / 2) / scale });
  }

  function onKey(e: KeyboardEvent) {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey) {
      if (k === 'z' && !e.shiftKey) { s.undo(); e.preventDefault(); }
      if (k === 'y' || (k === 'z' && e.shiftKey)) { s.redo(); e.preventDefault(); }
      return;
    }
    if (e.key === 'Escape') s.escape();
    else if (e.key === 'Delete' || e.key === 'Backspace') s.deleteSelection();
    else if (k === 'o') s.setTool('point');
    else if (k === 't') s.setTool('text');
    else if (k === 'l') s.setTool('line');
    else if (k === 'r') s.setTool('rectangle');
    else if (k === 'c') s.setTool('circle');
    else if (k === 'a') s.setTool('arc');
    else if (k === 'e') s.setTool('centerRect');
    else if (k === 'p') s.setTool('polygon');
    else if (k === 's') s.setTool('slot');
    else if (k === 'x') s.setTool('trim');
    else if (k === 'b') s.setTool('spline');
    else if (e.key === 'Enter') s.finishPending();
    else if (k === 'd') s.startEdit('offset');
    else if (k === 'm') s.startEdit('mirror');
    else if (k === 'f') fit();
    else if (k === 'g') s.toggleConstruction();
  }

  // ---------------------------------------------------------------- dibujo

  const color = (id: string, construction = false) => {
    if (s.selection().includes(id)) return 'var(--sk-selected)';
    if (hover() === id) return 'var(--sk-hover)';
    if (construction) return 'var(--sk-construction)';
    return fully() ? 'var(--sk-defined)' : 'var(--sk-geometry)';
  };

  const gridLines = createMemo(() => {
    const v = view();
    const { w, h } = size();
    // Paso de 1/2/5 × 10^n con ~25-60 px entre líneas.
    const raw = 30 / v.scale;
    const pow = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 5, 10].map((m) => m * pow).find((st) => st * v.scale >= 25)!;
    const [x0, y1] = toSketch([0, 0]);
    const [x1, y0] = toSketch([w, h]);
    const lines: { a: Vec2; b: Vec2; major: boolean }[] = [];
    for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) {
      lines.push({ a: toScreen([x, y0]), b: toScreen([x, y1]), major: Math.abs(Math.round(x / step)) % 5 === 0 });
    }
    for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) {
      lines.push({ a: toScreen([x0, y]), b: toScreen([x1, y]), major: Math.abs(Math.round(y / step)) % 5 === 0 });
    }
    return { lines, step };
  });

  /** Textos del sketch ya convertidos en contornos (coordenadas del sketch) y su caja. */
  const textShapes = createMemo(() => {
    const idx = index();
    if (!fontsLoaded()) return [];
    return idx.texts().map((t) => {
      const polys = t.text.trim() ? textContours(t, idx.point(t.point)).map((c) => flattenContour(c, 4)) : [];
      const all = polys.flat();
      const [ax, ay] = idx.point(t.point);
      const box: [number, number, number, number] = all.length
        ? [Math.min(...all.map((q) => q[0])), Math.min(...all.map((q) => q[1])), Math.max(...all.map((q) => q[0])), Math.max(...all.map((q) => q[1]))]
        : [ax, ay, ax + 1, ay + 1];
      return { id: t.id, polys, box };
    });
  });

  /** Texto elegido (para editarlo), si hay exactamente uno. */
  const selectedText = createMemo(() => {
    const ids = s.selection();
    if (ids.length !== 1) return null;
    const e = index().get(ids[0]);
    return e?.type === 'text' ? e : null;
  });

  const curveElement = (c: SketchCurve) => {
    const idx = index();
    const stroke = color(c.id, c.construction);
    const common = {
      stroke,
      'stroke-width': s.selection().includes(c.id) || hover() === c.id ? 2.5 : 1.6,
      'stroke-dasharray': c.construction ? '6 4' : undefined,
      fill: 'none',
    };
    if (c.type === 'line') {
      const [a, b] = [toScreen(idx.point(c.p1)), toScreen(idx.point(c.p2))];
      return <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} {...common} />;
    }
    if (c.type === 'circle') {
      const ctr = toScreen(idx.point(c.center));
      return <circle cx={ctr[0]} cy={ctr[1]} r={c.radius * view().scale} {...common} />;
    }
    if (c.type === 'spline') {
      return <path d={'M' + splinePolyline(idx, c).map((q) => toScreen(q).join(' ')).join('L') + (c.closed ? 'Z' : '')} {...common} />;
    }
    return <path d={arcPath(arcParams(idx, c), toScreen, view().scale)} {...common} />;
  };

  const preview = createMemo((): JSX.Element => {
    const p = s.pending();
    const cur = cursor();
    if (!p || !cur) return null;
    const style = { stroke: 'var(--sk-preview)', 'stroke-width': 1.4, 'stroke-dasharray': '5 3', fill: 'none' };
    switch (p.tool) {
      case 'line': {
        const [a, b] = [toScreen(p.start.pos), toScreen(cur.pos)];
        return <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} {...style} />;
      }
      case 'rectangle': {
        const [a, b] = [toScreen(p.corner.pos), toScreen(cur.pos)];
        return <rect x={Math.min(a[0], b[0])} y={Math.min(a[1], b[1])} width={Math.abs(b[0] - a[0])} height={Math.abs(b[1] - a[1])} {...style} />;
      }
      case 'circle': {
        const c = toScreen(p.center.pos);
        return <circle cx={c[0]} cy={c[1]} r={dist(p.center.pos, cur.pos) * view().scale} {...style} />;
      }
      case 'arc': {
        const c = toScreen(p.center.pos);
        if (!p.start) {
          const b = toScreen(cur.pos);
          return <line x1={c[0]} y1={c[1]} x2={b[0]} y2={b[1]} {...style} />;
        }
        const r = dist(p.center.pos, p.start.pos);
        const a0 = Math.atan2(p.start.pos[1] - p.center.pos[1], p.start.pos[0] - p.center.pos[0]);
        let a1 = Math.atan2(cur.pos[1] - p.center.pos[1], cur.pos[0] - p.center.pos[0]);
        while (a1 <= a0) a1 += Math.PI * 2;
        return <path d={arcPath({ center: p.center.pos, radius: r, startAngle: a0, endAngle: a1 }, toScreen, view().scale)} {...style} />;
      }
      case 'spline': {
        const pts = sampleSpline([...p.points.map((a) => a.pos), cur.pos], false);
        return <path d={'M' + pts.map((q) => toScreen(q).join(' ')).join('L')} {...style} />;
      }
      default: {
        // Rectángulo desde el centro, polígono y ranura: misma vista previa que el dibujo en 3D.
        const segs = previewSegments2D(p, cur.pos, s.polygonSides());
        let d = '';
        for (let i = 0; i + 1 < segs.length; i += 2) {
          const a = toScreen(segs[i]);
          const b = toScreen(segs[i + 1]);
          d += `M${a[0]} ${a[1]}L${b[0]} ${b[1]}`;
        }
        return <path d={d} {...style} />;
      }
    }
  });

  const status = createMemo(() => {
    const i = s.info();
    if (!i.ok) return { cls: 'error', text: 'El sketch no tiene solución con estas restricciones' };
    if (s.data().entities.length === 0) return { cls: 'muted', text: 'Sketch vacío: elegí una herramienta de dibujo' };
    if (i.conflicting.length) return { cls: 'error', text: `Restricciones en conflicto: ${i.conflicting.join(', ')}` };
    if (i.dof === 0) return { cls: 'ok', text: 'Totalmente definido' };
    return { cls: 'muted', text: `${i.dof} grado${i.dof === 1 ? '' : 's'} de libertad` };
  });

  const badgeClass = (id: string) => {
    const i = s.info();
    if (i.conflicting.includes(id)) return 'conflict';
    if (i.redundant.includes(id)) return 'redundant';
    if (s.selection().includes(id)) return 'selected';
    if (hover() === id) return 'hover';
    return '';
  };

  return (
    <div class="sketch-editor">
      <div class="sketch-toolbar">
        <span class="sketch-title with-icon" {...tip('Editando sketch', undefined, props.title)}><Icon name="sketch" size={16} />{props.title}</span>
        <div class="tool-group">
          <For each={TOOLS}>
            {(t) => (
              <button class="tb" classList={{ active: s.tool() === t.id }} {...tip(t.label, t.key)} onClick={() => s.setTool(t.id)}>
                <Icon name={t.icon} />
              </button>
            )}
          </For>
          <Show when={selectedText()} fallback={
            <Show when={s.tool() === 'text'}>
              <span class="text-opts">
                <input class="text-input" value={s.textOptions().text} placeholder="Texto"
                  onInput={(e) => s.setTextOptions({ ...s.textOptions(), text: e.currentTarget.value })} />
                <label class="sides" title="Altura de las mayúsculas (mm)">
                  <input type="number" min="0.5" step="0.5" value={s.textOptions().height}
                    onChange={(e) => s.setTextOptions({ ...s.textOptions(), height: Math.max(0.5, Number(e.currentTarget.value) || 10) })} /> mm
                </label>
                <label class="sides" title="Negrita: más legible al imprimir">
                  <input type="checkbox" checked={s.textOptions().bold} onChange={(e) => s.setTextOptions({ ...s.textOptions(), bold: e.currentTarget.checked })} /> negrita
                </label>
              </span>
            </Show>
          }>
            {(t) => (
              <span class="text-opts" title="Texto elegido">
                <input class="text-input" value={t().text} onChange={(e) => s.updateText(t().id, { text: e.currentTarget.value })} />
                <label class="sides" title="Altura de las mayúsculas (mm)">
                  <input type="number" min="0.5" step="0.5" value={t().height}
                    onChange={(e) => s.updateText(t().id, { height: Math.max(0.5, Number(e.currentTarget.value) || t().height) })} /> mm
                </label>
                <label class="sides" title="Ángulo (grados)">
                  <input type="number" step="5" value={t().angle} onChange={(e) => s.updateText(t().id, { angle: Number(e.currentTarget.value) || 0 })} /> °
                </label>
                <label class="sides">
                  <input type="checkbox" checked={t().bold} onChange={(e) => s.updateText(t().id, { bold: e.currentTarget.checked })} /> negrita
                </label>
              </span>
            )}
          </Show>
          <Show when={s.tool() === 'polygon'}>
            <label class="sides" title="Cantidad de lados del polígono">
              <input type="number" min="3" max="64" value={s.polygonSides()}
                onChange={(e) => s.setPolygonSides(Math.max(3, Math.min(64, Number(e.currentTarget.value) || 6)))} /> lados
            </label>
          </Show>
          <button class="tb" classList={{ active: s.construction() }} {...tip('Modo construcción', undefined, 'Lo que se dibuja queda como geometría auxiliar (no forma perfiles)')}
            onClick={() => s.setConstruction(!s.construction())}>
            <Icon name="construction" />
          </button>
        </div>
        <div class="tool-group">
          <button class="tb" classList={{ active: s.tool() === 'trim' }} {...tip('Recortar', 'X', 'Clic en el tramo de curva a borrar, hasta las intersecciones')} onClick={() => s.setTool('trim')}>
            <Icon name="trim" />
          </button>
          <For each={EDIT_BUTTONS}>
            {(b) => (
              <button class="tb" classList={{ active: s.actionPrompt()?.action === b.action }} {...tip(b.label, b.key, b.desc)} onClick={() => s.startEdit(b.action)}>
                <Icon name={b.icon} />
              </button>
            )}
          </For>
        </div>
        <div class="tool-group">
          <For each={CONSTRAINT_BUTTONS}>
            {(c) => (
              <button class="tb" {...tip(CONSTRAINT_LABELS[c.type], undefined, 'Se aplica a la selección actual')} onClick={() => s.applyConstraint(c.type)}><Icon name={c.icon} /></button>
            )}
          </For>
        </div>
        <div class="tool-group">
          <button class="tb" {...tip('Pasar a construcción', 'G', 'Alterna la selección entre geometría normal y auxiliar')} onClick={() => s.toggleConstruction()} disabled={!s.selection().length}>
            <Icon name="construction" class="swap" />
          </button>
          <button class="tb" {...tip('Borrar selección', 'Supr')} onClick={() => s.deleteSelection()} disabled={!s.selection().length}><Icon name="trash" /></button>
          <button class="tb" {...tip('Deshacer', 'Ctrl+Z')} onClick={() => s.undo()} disabled={!s.historySize().undo}><Icon name="undo" /></button>
          <button class="tb" {...tip('Rehacer', 'Ctrl+Y')} onClick={() => s.redo()} disabled={!s.historySize().redo}><Icon name="redo" /></button>
          <button class="tb" {...tip('Encuadrar', 'F')} onClick={fit}><Icon name="fit" /></button>
        </div>
        <span class="spacer" />
        <button class="with-icon" onClick={props.onCancel} {...tip('Cancelar', undefined, 'Descartar los cambios del sketch')}><Icon name="close" size={16} />Cancelar</button>
        <button class="primary with-icon" onClick={props.onFinish} {...tip('Terminar sketch', undefined, 'Guardar y volver al modelo 3D')}><Icon name="check" size={16} />Terminar</button>
      </div>

      <div class="sketch-canvas">
        <svg
          ref={svgEl}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => { setHover(null); setCursor(null); }}
          onDblClick={onDblClick}
          onWheel={onWheel}
          onContextMenu={(e) => e.preventDefault()}
          classList={{ drawing: s.tool() !== 'select' }}
        >
          <g class="grid">
            <For each={gridLines().lines}>
              {(l) => <line x1={l.a[0]} y1={l.a[1]} x2={l.b[0]} y2={l.b[1]} class={l.major ? 'major' : ''} />}
            </For>
          </g>
          {(() => {
            const o = toScreen([0, 0]);
            const { w, h } = size();
            return (
              <g class="axes">
                <line x1={0} y1={o[1]} x2={w} y2={o[1]} class="axis-x" classList={{ sel: s.selection().includes(AXIS_X), hov: hover() === AXIS_X }} />
                <line x1={o[0]} y1={0} x2={o[0]} y2={h} class="axis-y" classList={{ sel: s.selection().includes(AXIS_Y), hov: hover() === AXIS_Y }} />
              </g>
            );
          })()}

          {/* Contorno de la cara de apoyo: solo referencia visual, no seleccionable. */}
          {(() => {
            const ref = props.reference?.();
            if (!ref || ref.length === 0) return null;
            const parts: string[] = [];
            for (let i = 0; i + 3 < ref.length; i += 4) {
              const a = toScreen([ref[i], ref[i + 1]]);
              const b = toScreen([ref[i + 2], ref[i + 3]]);
              parts.push(`M${a[0]} ${a[1]}L${b[0]} ${b[1]}`);
            }
            return <path class="face-reference" d={parts.join('')} />;
          })()}
          {/* Se regenera entero en cada cambio: las líneas no cambian de identidad al mover sus puntos. */}
          {index().curves().map((c) => curveElement(c))}
          {textShapes().map((t) => (
            <path d={t.polys.map((poly) => 'M' + poly.map((q) => toScreen(q).join(' ')).join('L') + 'Z').join('')}
              stroke={color(t.id, false)} stroke-width={s.selection().includes(t.id) || hover() === t.id ? 2.2 : 1.3}
              fill={s.selection().includes(t.id) ? 'rgba(255,154,60,0.18)' : 'rgba(255,200,87,0.08)'} fill-rule="evenodd" />
          ))}

          {/* Líneas auxiliares de cotas */}
          <For each={labels().filter((l) => l.leader)}>
            {(l) => <line class="dim-leader" x1={l.leader![0][0]} y1={l.leader![0][1]} x2={l.leader![1][0]} y2={l.leader![1][1]} />}
          </For>

          {preview()}

          {index().points().map((p) => {
            const sp = toScreen([p.x, p.y]);
            return <circle class="sk-point" cx={sp[0]} cy={sp[1]} r={s.selection().includes(p.id) || hover() === p.id ? 4.5 : 3} fill={color(p.id)} />;
          })}
          {(() => {
            const o = toScreen([0, 0]);
            return <circle class="sk-origin" cx={o[0]} cy={o[1]} r={4} classList={{ sel: s.selection().includes(ORIGIN), hov: hover() === ORIGIN }} />;
          })()}

          <Show when={cursor()?.pointId && s.tool() !== 'select'}>
            {(() => {
              const c = toScreen(cursor()!.pos);
              return <circle class="snap" cx={c[0]} cy={c[1]} r={8} />;
            })()}
          </Show>

          <For each={labels()}>
            {(l) => (
              <g class={`sk-label ${l.dimension ? 'dimension' : 'badge'} ${badgeClass(l.constraintId)}`}>
                <rect x={l.at[0] - textWidth(l.text) / 2} y={l.at[1] - 8} width={textWidth(l.text)} height={16} rx={3} />
                <text x={l.at[0]} y={l.at[1] + 4}>{l.text}</text>
              </g>
            )}
          </For>
        </svg>

        <Show when={s.actionPrompt()}>
          {(p) => {
            const inputs: HTMLInputElement[] = [];
            const confirm = () => s.confirmAction(inputs.map((i) => i.value));
            return (
              <div class="dim-prompt">
                <strong>{p().title}</strong>
                <For each={p().fields}>
                  {(f, i) => (
                    <label>
                      {f.label}
                      <input
                        ref={(el) => { inputs[i()] = el; if (i() === 0) queueMicrotask(() => { el.focus(); el.select(); }); }}
                        value={String(f.value)}
                        inputmode="decimal"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') confirm();
                          if (e.key === 'Escape') s.setActionPrompt(null);
                        }}
                      />
                      <Show when={f.unit}><span class="unit">{f.unit}</span></Show>
                    </label>
                  )}
                </For>
                <button onClick={confirm}>Aplicar</button>
                <button onClick={() => s.setActionPrompt(null)}>Cancelar</button>
              </div>
            );
          }}
        </Show>

        <Show when={s.prompt()}>
          {(p) => (
            <div class="dim-prompt">
              <label>
                {p().unit === '°' ? 'Ángulo' : 'Cota'}
                <input
                  ref={(el) => { promptInput = el; queueMicrotask(() => { el.focus(); el.select(); }); }}
                  value={p().text ?? String(p().value)}
                  inputmode="decimal"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') s.confirmPrompt(e.currentTarget.value);
                    if (e.key === 'Escape') s.setPrompt(null);
                  }}
                />
                <span class="unit">{p().unit}</span>
              </label>
              <button onClick={() => s.confirmPrompt(promptInput?.value ?? '')}>Aplicar</button>
              <button onClick={() => s.setPrompt(null)}>Cancelar</button>
            </div>
          )}
        </Show>
      </div>

      <div class="sketch-status">
        <span class={`dof ${status().cls}`}>{status().cls === 'ok' ? '✓ ' : ''}{status().text}</span>
        <Show when={s.info().redundant.length > 0}>
          <span class="warn">Redundantes: {s.info().redundant.join(', ')}</span>
        </Show>
        <Show when={s.message()}>{(m) => <span class={m().kind === 'error' ? 'error' : 'muted'}>{m().text}</span>}</Show>
        <span class="spacer" />
        <span class="muted">Rueda: zoom · botón derecho/medio: mover · doble clic en una cota: editar · grilla {formatStep(gridLines().step)} mm</span>
      </div>
    </div>
  );
}

function arcPath(ap: ArcParams, toScreen: (p: Vec2) => Vec2, scale: number): string {
  const s = toScreen([ap.center[0] + ap.radius * Math.cos(ap.startAngle), ap.center[1] + ap.radius * Math.sin(ap.startAngle)]);
  const e = toScreen([ap.center[0] + ap.radius * Math.cos(ap.endAngle), ap.center[1] + ap.radius * Math.sin(ap.endAngle)]);
  const r = ap.radius * scale;
  const large = ap.endAngle - ap.startAngle > Math.PI ? 1 : 0;
  // Antihorario en el sketch (y hacia arriba) = sentido negativo de SVG (y hacia abajo): sweep 0.
  return `M ${s[0]} ${s[1]} A ${r} ${r} 0 ${large} 0 ${e[0]} ${e[1]}`;
}

function dimensionLabel(idx: SketchIndex, c: SketchConstraint, toScreen: (p: Vec2) => Vec2, data: SketchData): Label {
  const text = dimensionText(c, data);
  const base = { constraintId: c.id, text, dimension: true };
  if (c.type === 'radius') {
    const e = idx.get(c.curve) as SketchCurve;
    const m = toScreen(curveMidpoint(idx, e));
    const ctr = toScreen(idx.point(e.type === 'circle' || e.type === 'arc' ? e.center : ''));
    const dir = normalize(sub(m, ctr));
    return { ...base, at: add(m, mul(dir, 18)), leader: [ctr, m] };
  }
  if (c.type === 'angle') {
    const [a1, a2] = lineEnds(idx, c.a).map(toScreen);
    const [b1, b2] = lineEnds(idx, c.b).map(toScreen);
    return { ...base, at: lerp(lerp(a1, a2, 0.5), lerp(b1, b2, 0.5), 0.5) };
  }
  if (c.type !== 'distance') throw new Error('no es una cota');
  const kind = (id: string) => idx.kind(id);
  if (c.b === undefined) {
    const [a, b] = lineEnds(idx, c.a).map(toScreen);
    const n = normalize([b[1] - a[1], a[0] - b[0]]);
    return { ...base, at: add(lerp(a, b, 0.5), mul(n, 16)) };
  }
  let p: Vec2;
  let q: Vec2;
  if (kind(c.a) === 'point' && kind(c.b) === 'point') {
    [p, q] = [idx.point(c.a), idx.point(c.b)];
  } else {
    const [pointId, lineId] = kind(c.a) === 'point' ? [c.a, c.b] : kind(c.b) === 'point' ? [c.b, c.a] : [null, c.a];
    const pt = pointId ? idx.point(pointId) : lineEnds(idx, c.b)[0];
    const [l1, l2] = lineEnds(idx, lineId);
    const d = sub(l2, l1);
    const t = ((pt[0] - l1[0]) * d[0] + (pt[1] - l1[1]) * d[1]) / (d[0] * d[0] + d[1] * d[1] || 1);
    [p, q] = [pt, add(l1, mul(d, t))];
  }
  const [sp, sq] = [toScreen(p), toScreen(q)];
  return { ...base, at: lerp(sp, sq, 0.5), leader: [sp, sq] };
}

function normalize(v: Vec2): Vec2 {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
}

function textWidth(t: string) {
  return Math.max(16, t.length * 7 + 8);
}

function formatStep(step: number) {
  return step >= 1 ? String(Math.round(step)) : step.toPrecision(1);
}
