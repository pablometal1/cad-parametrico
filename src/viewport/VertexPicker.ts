// Modo "enganchar vértices": muestra los vértices del modelo, resalta el que está bajo el cursor y
// dibuja la cadena elegida (líneas 3D) con una vista previa hasta el cursor.
import * as THREE from 'three';

/** Distancia en píxeles para enganchar un vértice. */
const SNAP_PX = 12;

export class VertexPicker {
  readonly group = new THREE.Group();
  private positions: Float32Array = new Float32Array(0);
  private chain: number[] = [];
  private hovered = -1;
  /** Vértices tapados por el modelo desde la cámara actual (no se dibujan ni se eligen). */
  private hidden = new Set<number>();
  private readonly dotsMat = new THREE.PointsMaterial({ color: 0xdfe6ee, size: 7, sizeAttenuation: false, depthTest: false });
  private readonly hoverMat = new THREE.PointsMaterial({ color: 0xffa040, size: 13, sizeAttenuation: false, depthTest: false });
  private readonly chainMat = new THREE.LineBasicMaterial({ color: 0xffc857, depthTest: false });
  private readonly previewMat = new THREE.LineDashedMaterial({ color: 0xffc857, dashSize: 2, gapSize: 1.5, depthTest: false });
  private dots: THREE.Points | null = null;
  private hoverDot: THREE.Points | null = null;
  private chainLine: THREE.Line | null = null;
  private previewLine: THREE.Line | null = null;

  constructor(private readonly requestRender: () => void) {
    this.group.renderOrder = 30;
  }

  get active() {
    return this.positions.length > 0;
  }

  /** Vértices a mostrar (xyz consecutivos); vacío para apagar el modo. */
  setVertices(positions: Float32Array) {
    this.positions = positions;
    this.chain = [];
    this.hovered = -1;
    this.hidden = new Set();
    this.rebuild();
  }

  /** Vértices ya elegidos, en orden. */
  setChain(indices: number[]) {
    this.chain = indices.slice();
    this.rebuild();
  }

  /**
   * Índice del vértice visible más cercano al cursor (en píxeles), o -1. Si varios caen en el mismo
   * lugar de la pantalla (vista de frente: el de adelante tapa al de atrás) gana el más cercano a la
   * cámara, y los que tapa el modelo se descartan.
   */
  hitTest(screen: [number, number], camera: THREE.Camera, size: { w: number; h: number }, occluded?: (p: THREE.Vector3) => boolean): number {
    const v = new THREE.Vector3();
    const near: { i: number; d: number; z: number }[] = [];
    for (let i = 0; i < this.positions.length / 3; i++) {
      v.copy(this.point(i)).project(camera);
      if (v.z > 1) continue;
      const x = ((v.x + 1) / 2) * size.w;
      const y = ((1 - v.y) / 2) * size.h;
      const d = Math.hypot(x - screen[0], y - screen[1]);
      if (d < SNAP_PX) near.push({ i, d, z: v.z });
    }
    near.sort((a, b) => (Math.abs(a.d - b.d) < 2 ? a.z - b.z : a.d - b.d));
    return near.find((c) => !occluded?.(this.point(c.i)))?.i ?? -1;
  }

  /** Recalcula qué vértices tapa el modelo (se llama antes de cada cuadro, si cambió la vista). */
  updateVisibility(occluded: (p: THREE.Vector3) => boolean) {
    if (!this.positions.length) return;
    const hidden = new Set<number>();
    for (let i = 0; i < this.positions.length / 3; i++) if (occluded(this.point(i))) hidden.add(i);
    if (hidden.size === this.hidden.size && [...hidden].every((i) => this.hidden.has(i))) return;
    this.hidden = hidden;
    this.rebuild(false);
  }

  setHover(index: number) {
    if (index === this.hovered) return;
    this.hovered = index;
    this.rebuild();
  }

  get hoveredIndex() {
    return this.hovered;
  }

  dispose() {
    this.clear();
    for (const m of [this.dotsMat, this.hoverMat, this.chainMat, this.previewMat]) m.dispose();
  }

  private point(i: number) {
    return new THREE.Vector3(this.positions[3 * i], this.positions[3 * i + 1], this.positions[3 * i + 2]);
  }

  private clear() {
    for (const o of [this.dots, this.hoverDot, this.chainLine, this.previewLine]) {
      if (!o) continue;
      o.geometry.dispose();
      this.group.remove(o);
    }
    this.dots = this.hoverDot = this.chainLine = this.previewLine = null;
  }

  private rebuild(render = true) {
    this.clear();
    if (!this.positions.length) {
      this.requestRender();
      return;
    }
    const visible: THREE.Vector3[] = [];
    for (let i = 0; i < this.positions.length / 3; i++) if (!this.hidden.has(i)) visible.push(this.point(i));
    const g = new THREE.BufferGeometry().setFromPoints(visible);
    this.dots = new THREE.Points(g, this.dotsMat);
    this.dots.renderOrder = 31;
    this.group.add(this.dots);
    if (this.chain.length >= 2) {
      this.chainLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(this.chain.map((i) => this.point(i))), this.chainMat);
      this.chainLine.renderOrder = 32;
      this.group.add(this.chainLine);
    }
    if (this.hovered >= 0) {
      this.hoverDot = new THREE.Points(new THREE.BufferGeometry().setFromPoints([this.point(this.hovered)]), this.hoverMat);
      this.hoverDot.renderOrder = 34;
      this.group.add(this.hoverDot);
      const last = this.chain[this.chain.length - 1];
      if (last !== undefined && last !== this.hovered) {
        this.previewLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([this.point(last), this.point(this.hovered)]), this.previewMat);
        this.previewLine.computeLineDistances();
        this.previewLine.renderOrder = 33;
        this.group.add(this.previewLine);
      }
    }
    if (render) this.requestRender();
  }
}
