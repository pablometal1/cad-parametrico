// Plano de dibujo directo en 3D: grilla orientada, vista previa, enganche y medida en vivo.
import * as THREE from 'three';
import type { PlaneFrame } from '../document/planes';

export interface DrawOverlay {
  /** Segmentos de la vista previa (xyz consecutivos, de a pares). */
  segments: number[];
  /** Punto enganchado (si el cursor está sobre un punto existente). */
  snap: [number, number, number] | null;
  /** Medida en vivo junto al cursor. */
  label: { text: string; at: [number, number, number] } | null;
}

const v3 = (a: readonly number[]) => new THREE.Vector3(a[0], a[1], a[2]);

export class DrawPlane {
  readonly group = new THREE.Group();
  private readonly labelEl: HTMLDivElement;
  private frame: PlaneFrame | null = null;
  private grid: THREE.Group | null = null;
  private preview: THREE.LineSegments | null = null;
  private snapMarker: THREE.Mesh | null = null;
  private labelAt: THREE.Vector3 | null = null;
  private readonly previewMat = new THREE.LineBasicMaterial({ color: 0xffd27f, depthTest: false });
  private readonly snapMat = new THREE.MeshBasicMaterial({ color: 0x7fb8ff, depthTest: false });

  constructor(container: HTMLElement) {
    this.group.renderOrder = 15;
    this.labelEl = document.createElement('div');
    this.labelEl.className = 'draw-label';
    this.labelEl.style.display = 'none';
    container.appendChild(this.labelEl);
  }

  get active() {
    return this.frame !== null;
  }

  get currentFrame() {
    return this.frame;
  }

  /** Activa el plano (o lo apaga con null). `center` y `extent` definen el tamaño de la grilla. */
  setPlane(frame: PlaneFrame | null, center?: [number, number], extent = 100, step = 10) {
    this.clear();
    this.frame = frame;
    if (!frame) return;
    const g = new THREE.Group();
    // La grilla de three.js está en XZ: base (u, n, -v) para dejarla sobre el plano del sketch.
    const basis = new THREE.Matrix4().makeBasis(v3(frame.xDir), v3(frame.normal), v3(frame.yDir).negate());
    const [cu, cv] = center ?? [0, 0];
    const size = Math.max(step * 4, Math.ceil((extent * 2) / step) * step);
    const divisions = Math.min(200, Math.round(size / step));
    const grid = new THREE.GridHelper(size, divisions, 0x5d7fa6, 0x34465a);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.55;
    (grid.material as THREE.Material).depthWrite = false;
    grid.position.set(Math.round(cu / step) * step, 0, -Math.round(cv / step) * step);
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x4a90d9, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false }),
    );
    quad.position.copy(grid.position);
    g.add(grid, quad);
    g.applyMatrix4(basis);
    g.position.copy(v3(frame.origin));
    this.grid = g;
    this.group.add(g);
  }

  /** Intersección del rayo con el plano, en coordenadas (u, v) del sketch. */
  intersect(ray: THREE.Ray): [number, number] | null {
    const f = this.frame;
    if (!f) return null;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(v3(f.normal), v3(f.origin));
    const hit = ray.intersectPlane(plane, new THREE.Vector3());
    if (!hit) return null;
    const r = hit.sub(v3(f.origin));
    return [r.dot(v3(f.xDir)), r.dot(v3(f.yDir))];
  }

  setOverlay(o: DrawOverlay) {
    this.clearOverlay();
    if (o.segments.length >= 6) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(o.segments, 3));
      this.preview = new THREE.LineSegments(g, this.previewMat);
      this.preview.renderOrder = 16;
      this.group.add(this.preview);
    }
    if (o.snap) {
      this.snapMarker = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), this.snapMat);
      this.snapMarker.position.copy(v3(o.snap));
      this.snapMarker.renderOrder = 17;
      this.group.add(this.snapMarker);
    }
    this.labelAt = o.label ? v3(o.label.at) : null;
    this.labelEl.textContent = o.label?.text ?? '';
  }

  /** Tamaño constante del marcador y posición de la etiqueta (cada cuadro). */
  update(camera: THREE.Camera, worldPerPx: (p: THREE.Vector3) => number, size: { w: number; h: number }) {
    if (this.snapMarker) this.snapMarker.scale.setScalar(worldPerPx(this.snapMarker.position) * 5);
    if (!this.labelAt || !this.labelEl.textContent) {
      this.labelEl.style.display = 'none';
      return;
    }
    const p = this.labelAt.clone().project(camera);
    this.labelEl.style.display = '';
    this.labelEl.style.left = `${((p.x + 1) / 2) * size.w + 14}px`;
    this.labelEl.style.top = `${((1 - p.y) / 2) * size.h + 10}px`;
  }

  dispose() {
    this.clear();
    this.previewMat.dispose();
    this.snapMat.dispose();
    this.labelEl.remove();
  }

  private clearOverlay() {
    for (const o of [this.preview, this.snapMarker]) {
      if (!o) continue;
      o.geometry.dispose();
      this.group.remove(o);
    }
    this.preview = null;
    this.snapMarker = null;
  }

  private clear() {
    this.clearOverlay();
    if (this.grid) {
      this.grid.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        (m.material as THREE.Material | undefined)?.dispose?.();
      });
      this.group.remove(this.grid);
      this.grid = null;
    }
    this.labelAt = null;
    this.labelEl.style.display = 'none';
  }
}
