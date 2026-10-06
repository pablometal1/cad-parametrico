// Manipulador 3D: flecha (lineal) o arco (angular) arrastrables, con etiqueta editable del valor.
import * as THREE from 'three';
import type { Manipulator } from '../kernel/protocol';

export interface ManipulatorHandlers {
  /** Mientras se arrastra (vista previa en vivo). */
  onDrag: (value: number) => void;
  /** Al soltar o al escribir un valor. */
  onCommit: (value: number) => void;
}

const COLOR = 0xffa040;
const COLOR_ACTIVE = 0xffd27f;
/** Tamaño del asa en píxeles (se mantiene constante con el zoom). */
const HANDLE_PX = 14;

const v3 = (a: [number, number, number]) => new THREE.Vector3(a[0], a[1], a[2]);

export class ManipulatorWidget {
  readonly group = new THREE.Group();
  private readonly label: HTMLDivElement;
  private spec: Manipulator | null = null;
  private handlers: ManipulatorHandlers | null = null;
  /** Valor mostrado (puede diferir del spec mientras se arrastra). */
  private value = 0;
  private dragging = false;
  private pendingSpec: { spec: Manipulator | null; handlers: ManipulatorHandlers | null } | null = null;
  private hovered = false;

  private readonly handleMat = new THREE.MeshBasicMaterial({ color: COLOR, depthTest: false });
  private readonly lineMat = new THREE.LineBasicMaterial({ color: COLOR, depthTest: false });
  private readonly axisMat = new THREE.LineDashedMaterial({ color: 0x7fb8ff, dashSize: 3, gapSize: 2, depthTest: false });
  private handle: THREE.Mesh | null = null;
  private shaft: THREE.Line | null = null;
  private axis: THREE.Line | null = null;

  constructor(container: HTMLElement, private readonly requestRender: () => void) {
    this.group.renderOrder = 20;
    this.label = document.createElement('div');
    this.label.className = 'manip-label';
    this.label.style.display = 'none';
    this.label.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.label.addEventListener('click', () => this.editLabel());
    container.appendChild(this.label);
  }

  get active() {
    return this.spec !== null;
  }

  get isDragging() {
    return this.dragging;
  }

  set(spec: Manipulator | null, handlers: ManipulatorHandlers | null) {
    // Durante un arrastre no se reemplaza: el recálculo en vivo devolvería un asa que "salta".
    if (this.dragging) {
      this.pendingSpec = { spec, handlers };
      return;
    }
    this.spec = spec;
    this.handlers = handlers;
    this.value = spec?.value ?? 0;
    this.rebuild();
  }

  /** Reubica el asa y la etiqueta según la cámara (tamaño constante en pantalla). */
  update(camera: THREE.Camera, worldPerPx: (p: THREE.Vector3) => number, size: { w: number; h: number }) {
    if (!this.spec || !this.handle) {
      this.label.style.display = 'none';
      return;
    }
    const pos = this.handlePosition();
    const s = worldPerPx(pos) * HANDLE_PX;
    this.handle.position.copy(pos);
    this.handle.scale.setScalar(s);
    if (this.spec.kind === 'linear') {
      // La punta de la flecha mira en la dirección de crecimiento del valor.
      this.handle.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v3(this.spec.dir).normalize());
    }
    const p = pos.clone().project(camera);
    if (p.z > 1) {
      this.label.style.display = 'none';
      return;
    }
    this.label.style.display = '';
    this.label.style.left = `${((p.x + 1) / 2) * size.w + 16}px`;
    this.label.style.top = `${((1 - p.y) / 2) * size.h - 12}px`;
  }

  /** ¿El rayo toca el asa? (para empezar a arrastrar antes de orbitar). */
  hitTest(ray: THREE.Raycaster): boolean {
    if (!this.handle) return false;
    // Esfera de captura un poco más grande que el asa.
    const sphere = new THREE.Sphere(this.handle.position, this.handle.scale.x * 1.4);
    return ray.ray.intersectsSphere(sphere);
  }

  setHover(on: boolean) {
    if (on === this.hovered) return;
    this.hovered = on;
    this.handleMat.color.set(on || this.dragging ? COLOR_ACTIVE : COLOR);
    this.requestRender();
  }

  beginDrag() {
    this.dragging = true;
    this.handleMat.color.set(COLOR_ACTIVE);
  }

  /** Mueve el asa siguiendo el rayo del puntero. `fine` = paso más fino (Shift). */
  drag(ray: THREE.Raycaster, fine: boolean) {
    const m = this.spec;
    if (!m || !this.dragging) return;
    let value: number;
    if (m.kind === 'linear') {
      // Punto de la recta del manipulador más cercano al rayo.
      const o = v3(m.origin);
      const d = v3(m.dir).normalize();
      const r0 = ray.ray.origin;
      const rd = ray.ray.direction;
      const w = o.clone().sub(r0);
      const b = d.dot(rd);
      const denom = 1 - b * b;
      if (denom < 1e-9) return; // rayo paralelo a la flecha
      const t = (b * rd.dot(w) - d.dot(w)) / denom;
      value = t / m.factor;
      value = Math.max(m.min, roundTo(value, fine ? 0.01 : 0.1));
    } else {
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(v3(m.axis).normalize(), v3(m.center));
      const hit = ray.ray.intersectPlane(plane, new THREE.Vector3());
      if (!hit) return;
      const r = hit.sub(v3(m.center));
      const u = v3(m.startDir);
      const wv = v3(m.axis).normalize().cross(u);
      let deg = (Math.atan2(r.dot(wv), r.dot(u)) * 180) / Math.PI;
      if (deg <= 0) deg += 360;
      value = Math.min(360, Math.max(1, roundTo(deg, fine ? 0.1 : 1)));
    }
    if (value !== this.value) {
      this.value = value;
      this.rebuild();
      this.handlers?.onDrag(value);
    }
  }

  endDrag() {
    if (!this.dragging) return;
    this.dragging = false;
    this.handleMat.color.set(this.hovered ? COLOR_ACTIVE : COLOR);
    this.handlers?.onCommit(this.value);
    if (this.pendingSpec) {
      const p = this.pendingSpec;
      this.pendingSpec = null;
      this.set(p.spec, p.handlers);
    }
  }

  dispose() {
    this.clearObjects();
    this.handleMat.dispose();
    this.lineMat.dispose();
    this.axisMat.dispose();
    this.label.remove();
  }

  private handlePosition(): THREE.Vector3 {
    const m = this.spec!;
    if (m.kind === 'linear') return v3(m.origin).addScaledVector(v3(m.dir).normalize(), this.value * m.factor);
    return this.arcPoint(this.value);
  }

  private arcPoint(deg: number): THREE.Vector3 {
    const m = this.spec as Extract<Manipulator, { kind: 'angular' }>;
    const a = (deg * Math.PI) / 180;
    const u = v3(m.startDir);
    const w = v3(m.axis).normalize().cross(u);
    return v3(m.center).addScaledVector(u, Math.cos(a) * m.radius).addScaledVector(w, Math.sin(a) * m.radius);
  }

  private clearObjects() {
    for (const o of [this.handle, this.shaft, this.axis]) {
      if (!o) continue;
      o.geometry.dispose();
      this.group.remove(o);
    }
    this.handle = this.shaft = this.axis = null;
  }

  private rebuild() {
    this.clearObjects();
    const m = this.spec;
    if (!m) {
      this.label.style.display = 'none';
      this.requestRender();
      return;
    }
    if (m.kind === 'linear') {
      // Asa: cono (punta en +Y local), orientado en update().
      this.handle = new THREE.Mesh(new THREE.ConeGeometry(0.45, 1.2, 20), this.handleMat);
      const end = this.handlePosition();
      this.shaft = new THREE.Line(new THREE.BufferGeometry().setFromPoints([v3(m.origin), end]), this.lineMat);
    } else {
      this.handle = new THREE.Mesh(new THREE.SphereGeometry(0.5, 20, 14), this.handleMat);
      const pts: THREE.Vector3[] = [];
      const n = Math.max(8, Math.ceil(this.value / 4));
      for (let i = 0; i <= n; i++) pts.push(this.arcPoint((this.value * i) / n));
      this.shaft = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), this.lineMat);
      const ax = v3(m.axis).normalize();
      const c = v3(m.center);
      this.axis = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          c.clone().addScaledVector(ax, -m.axisLength / 2),
          c.clone().addScaledVector(ax, m.axisLength / 2),
        ]),
        this.axisMat,
      );
      this.axis.computeLineDistances();
      this.axis.renderOrder = 19;
      this.group.add(this.axis);
    }
    this.handle.renderOrder = 21;
    this.shaft.renderOrder = 20;
    this.group.add(this.shaft, this.handle);
    this.label.textContent = `${m.label}: ${formatValue(this.value)} ${m.kind === 'angular' ? '°' : 'mm'}`;
    this.requestRender();
  }

  /** Clic en la etiqueta: se convierte en un campo para escribir el valor exacto. */
  private editLabel() {
    const m = this.spec;
    if (!m || this.label.querySelector('input')) return;
    const input = document.createElement('input');
    input.value = formatValue(this.value);
    input.inputMode = 'decimal';
    this.label.textContent = `${m.label}: `;
    this.label.appendChild(input);
    input.focus();
    input.select();
    const finish = (apply: boolean) => {
      const v = Number(input.value.trim().replace(',', '.'));
      if (apply && Number.isFinite(v) && v > 0) {
        this.value = m.kind === 'angular' ? Math.min(360, v) : Math.max(m.min, v);
        this.handlers?.onCommit(this.value);
      }
      this.rebuild();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }
}

function roundTo(v: number, step: number) {
  // toPrecision limpia el ruido de coma flotante (3 × 0.1 = 0.30000000000000004 → 0.3).
  return Number((Math.round(v / step) * step).toPrecision(12));
}

function formatValue(v: number) {
  return String(Math.round(v * 1000) / 1000);
}
