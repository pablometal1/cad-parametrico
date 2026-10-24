// Asas de las curvas 3D (como los puntos de control en Plasticity): una esfera por control de cada
// tramo, unida con una línea a su vértice. Se arrastran en el plano de la pantalla; la curva se
// redibuja en vivo y al soltar se guarda en la feature.
import * as THREE from 'three';
import { moveHandle, sampleSegments, type BezierSegment } from '../document/curve3d';
import type { Vec3 } from '../document/types';

export interface CurveHandleData {
  segments: BezierSegment[];
  closed: boolean;
  /** Al mover un control, alinear el del tramo vecino (tangente continua). */
  keepTangent: boolean;
}

export interface CurveHandleHandlers {
  /** Al soltar: tramos nuevos y cuáles cambiaron. */
  onCommit: (segments: BezierSegment[], touched: number[]) => void;
}

const COLOR = 0x5fb3ff;
const COLOR_ACTIVE = 0xffd27f;
/** Diámetro del asa en píxeles (constante con el zoom). */
const HANDLE_PX = 9;

export class CurveHandles {
  readonly group = new THREE.Group();
  private data: CurveHandleData | null = null;
  private handlers: CurveHandleHandlers | null = null;
  private segments: BezierSegment[] = [];
  private touched: number[] = [];
  private spheres: THREE.Mesh[] = [];
  private stems: THREE.LineSegments | null = null;
  private preview: THREE.Line | null = null;
  private dragIndex = -1;
  private hoverIndex = -1;
  private dragPlane = new THREE.Plane();
  private pending: { data: CurveHandleData | null; handlers: CurveHandleHandlers | null } | null = null;

  private readonly sphereGeo = new THREE.SphereGeometry(0.5, 12, 8);
  private readonly sphereMat = new THREE.MeshBasicMaterial({ color: COLOR, depthTest: false });
  private readonly activeMat = new THREE.MeshBasicMaterial({ color: COLOR_ACTIVE, depthTest: false });
  private readonly stemMat = new THREE.LineBasicMaterial({ color: COLOR, depthTest: false, transparent: true, opacity: 0.7 });
  private readonly previewMat = new THREE.LineBasicMaterial({ color: COLOR_ACTIVE, depthTest: false });

  constructor(private readonly requestRender: () => void) {
    this.group.renderOrder = 21;
  }

  get active() {
    return this.data !== null && this.spheres.length > 0;
  }

  get isDragging() {
    return this.dragIndex >= 0;
  }

  set(data: CurveHandleData | null, handlers: CurveHandleHandlers | null) {
    // Durante un arrastre no se reemplaza: el recálculo devolvería asas que "saltan".
    if (this.isDragging) {
      this.pending = { data, handlers };
      return;
    }
    this.data = data;
    this.handlers = handlers;
    this.segments = data ? data.segments.map((s) => s.slice() as BezierSegment) : [];
    this.touched = [];
    this.rebuild(false);
  }

  /** Posición del asa `i`: tramo i/2, control 1 (par) o 2 (impar). */
  private handlePos(i: number): Vec3 {
    return this.segments[i >> 1][(i & 1) === 0 ? 1 : 2];
  }

  private rebuild(withPreview: boolean) {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      if (c instanceof THREE.Line || c instanceof THREE.LineSegments) c.geometry.dispose();
    }
    this.spheres = [];
    this.stems = null;
    this.preview = null;
    if (!this.data) {
      this.requestRender();
      return;
    }
    const stem: number[] = [];
    this.segments.forEach((s, k) => {
      for (const end of [0, 1] as const) {
        const m = new THREE.Mesh(this.sphereGeo, this.sphereMat);
        m.position.set(...s[end === 0 ? 1 : 2]);
        m.renderOrder = 22;
        this.spheres[k * 2 + end] = m;
        this.group.add(m);
        stem.push(...s[end === 0 ? 0 : 3], ...s[end === 0 ? 1 : 2]);
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(stem, 3));
    this.stems = new THREE.LineSegments(g, this.stemMat);
    this.stems.renderOrder = 21;
    this.group.add(this.stems);
    if (withPreview) {
      const pg = new THREE.BufferGeometry();
      pg.setAttribute('position', new THREE.Float32BufferAttribute(sampleSegments(this.segments, 32).flat(), 3));
      this.preview = new THREE.Line(pg, this.previewMat);
      this.preview.renderOrder = 21;
      this.group.add(this.preview);
    }
    this.highlight();
    this.requestRender();
  }

  private highlight() {
    this.spheres.forEach((m, i) => (m.material = i === this.dragIndex || i === this.hoverIndex ? this.activeMat : this.sphereMat));
  }

  /** Tamaño constante en pantalla. */
  update(worldPerPx: (p: THREE.Vector3) => number) {
    for (const m of this.spheres) m.scale.setScalar(worldPerPx(m.position) * HANDLE_PX);
  }

  /** Asa bajo el rayo (la más cercana), o −1. */
  hitTest(ray: THREE.Raycaster): number {
    let best = -1;
    let bestD = Infinity;
    this.spheres.forEach((m, i) => {
      const sphere = new THREE.Sphere(m.position, m.scale.x * 0.9);
      if (!ray.ray.intersectsSphere(sphere)) return;
      const d = ray.ray.distanceSqToPoint(m.position);
      if (d < bestD) [best, bestD] = [i, d];
    });
    return best;
  }

  setHover(i: number) {
    if (i === this.hoverIndex) return;
    this.hoverIndex = i;
    this.highlight();
    this.requestRender();
  }

  /** Empieza a arrastrar el asa `i` en el plano que mira a la cámara y pasa por ella. */
  beginDrag(i: number, camera: THREE.Camera) {
    this.dragIndex = i;
    const normal = camera.getWorldDirection(new THREE.Vector3());
    this.dragPlane.setFromNormalAndCoplanarPoint(normal, new THREE.Vector3(...this.handlePos(i)));
    this.highlight();
    this.requestRender();
  }

  drag(ray: THREE.Raycaster) {
    if (!this.isDragging || !this.data) return;
    const hit = ray.ray.intersectPlane(this.dragPlane, new THREE.Vector3());
    if (!hit) return;
    const seg = this.dragIndex >> 1;
    const end = (this.dragIndex & 1) as 0 | 1;
    const r = moveHandle(this.segments, this.data.closed, seg, end, [hit.x, hit.y, hit.z], this.data.keepTangent);
    this.segments = r.segs;
    this.touched = [...new Set([...this.touched, ...r.touched])];
    this.rebuild(true);
  }

  endDrag() {
    const moved = this.touched.length > 0;
    this.dragIndex = -1;
    if (moved) this.handlers?.onCommit(this.segments, this.touched);
    this.touched = [];
    this.highlight();
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      this.set(p.data, p.handlers);
    }
    this.requestRender();
  }

  dispose() {
    this.set(null, null);
    this.sphereGeo.dispose();
    this.sphereMat.dispose();
    this.activeMat.dispose();
    this.stemMat.dispose();
    this.previewMat.dispose();
  }
}
