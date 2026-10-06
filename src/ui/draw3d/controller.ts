// Dibujo directo en 3D: líneas, rectángulos, círculos y arcos sobre un plano o una cara,
// sin abrir el editor de sketch. Reutiliza la sesión del editor (herramientas, enganches, solver)
// y guarda cada figura terminada en un sketch del documento.
import { createSignal } from 'solid-js';
import { toWorld, type PlaneFrame } from '../../document/planes';
import { ORIGIN, type SketchData, type SketchFeature } from '../../document/types';
import { SketchIndex, type Vec2 } from '../../sketch/model';
import type { Viewport } from '../../viewport/Viewport';
import { createSketchSession, type Anchor, type SketchSession, type Tool } from '../sketch/session';
import type { CadStore } from '../store';
import { gridStep, previewLabel, previewSegments2D, snapToGrid, toWorldSegments } from './preview';

export type DrawTool = Exclude<Tool, 'select'>;

export interface DrawTarget {
  plane: SketchFeature['plane'];
  frame: PlaneFrame;
  /** Sketch existente en el que se sigue dibujando (null: se crea uno nuevo). */
  featureId: FeatureIdOrNull;
  /** Geometría actual del sketch (vacía si es nuevo). */
  data: SketchData;
  label: string;
  /** Centro (u, v) y tamaño aproximado para la grilla. */
  center: [number, number];
  extent: number;
}
type FeatureIdOrNull = string | null;

/** Distancia en píxeles para engancharse a un punto existente. */
const SNAP_PX = 10;

export function createDirectDraw(store: CadStore, viewport: () => Viewport | undefined) {
  const [active, setActive] = createSignal<{ label: string; plane: SketchFeature['plane'] } | null>(null);
  const [tool, setToolSignal] = createSignal<DrawTool>('line');
  const [gridSnap, setGridSnap] = createSignal(true);
  const [message, setMessage] = createSignal<string | null>(null);

  let session: SketchSession | null = null;
  let target: DrawTarget | null = null;
  let featureId: string | null = null;
  let cursor: Vec2 | null = null;
  let step = 1;

  function start(t: DrawTarget, initialTool: DrawTool) {
    stop();
    target = t;
    featureId = t.featureId;
    session = createSketchSession(t.data, { scope: () => store.evaluated().scope });
    session.setTool(initialTool);
    setToolSignal(initialTool);
    setMessage(null);
    const vp = viewport();
    if (!vp) return;
    // Paso de grilla según el zoom, para que una celda mida unos 18 px en el centro del plano.
    const centerWorld = toWorld(t.frame, ...t.center);
    step = gridStep(vp.mmPerPixelAt(centerWorld));
    vp.setDrawMode(t.frame, { move: onMove, click: onClick }, t.center, t.extent, step);
    store.setDrawing(true);
    setActive({ label: t.label, plane: t.plane });
    if (typeof window !== 'undefined') window.addEventListener('keydown', onKey, true);
  }

  function stop() {
    if (typeof window !== 'undefined') window.removeEventListener('keydown', onKey, true);
    viewport()?.setDrawMode(null, null);
    viewport()?.setDrawOverlay({ segments: [], snap: null, label: null });
    session = null;
    target = null;
    cursor = null;
    if (active()) store.setDrawing(false);
    setActive(null);
  }

  function setTool(t: DrawTool) {
    if (!session) return;
    session.setTool(t);
    setToolSignal(t);
    refresh();
  }

  /** Punto de dibujo: enganche a un punto existente del sketch (o al origen), si no a la grilla. */
  function anchorAt(uv: Vec2, screen: [number, number], free: boolean): Anchor {
    const vp = viewport();
    if (vp && session && target) {
      const index = new SketchIndex(session.data());
      const candidates: [string, Vec2][] = [[ORIGIN, [0, 0]], ...index.points().map((p) => [p.id, [p.x, p.y]] as [string, Vec2])];
      let best: { id: string; pos: Vec2; d: number } | null = null;
      for (const [id, pos] of candidates) {
        const s = vp.project(toWorld(target.frame, pos[0], pos[1]));
        const d = Math.hypot(s[0] - screen[0], s[1] - screen[1]);
        if (d <= SNAP_PX && (!best || d < best.d)) best = { id, pos, d };
      }
      if (best) return { pos: best.pos, pointId: best.id };
    }
    return { pos: gridSnap() && !free ? snapToGrid(uv, step) : uv };
  }

  let lastAnchor: Anchor | null = null;

  function onMove(uv: Vec2, screen: [number, number], ev: PointerEvent) {
    lastAnchor = anchorAt(uv, screen, ev.altKey);
    cursor = lastAnchor.pos;
    refresh();
  }

  function onClick(uv: Vec2, screen: [number, number], ev: PointerEvent) {
    if (!session || !target) return;
    const anchor = anchorAt(uv, screen, ev.altKey);
    const before = session.data();
    session.click(anchor);
    const after = session.data();
    const msg = session.message();
    setMessage(msg?.kind === 'error' ? msg.text : null);
    if (after !== before) {
      // Figura (o tramo de línea) terminada: se guarda en el documento.
      featureId = store.commitDirectDraw(featureId, target.plane, after);
    }
    cursor = anchor.pos;
    refresh();
  }

  function refresh() {
    const vp = viewport();
    if (!vp || !session || !target) return;
    const t = target;
    const pending = session.pending();
    const segs = previewSegments2D(pending, cursor);
    const text = previewLabel(pending, cursor);
    vp.setDrawOverlay({
      segments: toWorldSegments(t.frame, segs),
      snap: lastAnchor?.pointId ? toWorld(t.frame, ...lastAnchor.pos) : null,
      label: text && cursor ? { text, at: toWorld(t.frame, cursor[0], cursor[1]) } : null,
    });
  }

  function onKey(e: KeyboardEvent) {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    if (!session) return;
    const k = e.key.toLowerCase();
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      // Primero cancela la figura en curso; si no hay, termina el modo dibujo.
      if (session.pending()) {
        session.escape();
        refresh();
      } else stop();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      stop();
    } else if ((e.ctrlKey || e.metaKey) && k === 'z') {
      // Deshacer la última figura sin salir del modo.
      e.preventDefault();
      e.stopPropagation();
      session.undo();
      if (featureId && target) featureId = store.commitDirectDraw(featureId, target.plane, session.data());
      refresh();
    } else if (!e.ctrlKey && !e.metaKey) {
      const tools: Record<string, DrawTool> = { l: 'line', r: 'rectangle', c: 'circle', a: 'arc' };
      if (tools[k]) {
        e.preventDefault();
        setTool(tools[k]);
      } else if (k === 'g') {
        setGridSnap(!gridSnap());
      }
    }
  }

  return {
    active,
    tool,
    gridSnap,
    setGridSnap,
    message,
    start,
    stop,
    setTool,
    /** Id del sketch donde se está dibujando (para abrirlo en el editor). */
    currentSketch: () => featureId,
  };
}

export type DirectDraw = ReturnType<typeof createDirectDraw>;
