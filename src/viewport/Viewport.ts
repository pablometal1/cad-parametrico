// Viewport 3D: muestra la teselación del kernel, órbita/zoom/pan y selección de caras y aristas.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { MeshPayload, SketchLines } from '../kernel/protocol';

export type PickKind = 'face' | 'edge';

/** Selección del viewport: índices en shape.faces y shape.edges, en orden de selección. */
export interface ViewportSelection {
  faces: number[];
  edges: number[];
}

export interface PickItem {
  kind: PickKind;
  index: number;
}

export interface ViewportEvents {
  onSelectionChange?: (sel: ViewportSelection) => void;
  onHoverChange?: (item: PickItem | null) => void;
}

const COLOR_BASE = new THREE.Color(0xb8c4d0);
const COLOR_HOVER = new THREE.Color(0x7fb8ff);
const COLOR_SELECTED = new THREE.Color(0xff9a3c);
/** Movimiento máximo del puntero (px) para considerar un clic y no un arrastre de órbita. */
const CLICK_TOLERANCE_PX = 4;
/** Distancia en px a la que una arista se puede elegir. */
const EDGE_PICK_PX = 6;

export class Viewport {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly raycaster = new THREE.Raycaster();
  private readonly resizeObserver: ResizeObserver;
  private readonly modelGroup = new THREE.Group();
  private readonly sketchGroup = new THREE.Group();
  private readonly grid: THREE.GridHelper;

  private mesh: THREE.Mesh | null = null;
  private edges: THREE.LineSegments | null = null;
  /** Aristas resaltadas (hover/selección) con líneas gruesas. */
  private highlight: LineSegments2 | null = null;
  private readonly highlightMaterial = new LineMaterial({ linewidth: 3.5, vertexColors: true, depthTest: false });
  private edgePositions: Float32Array = new Float32Array(0);
  private edgeRanges: Uint32Array = new Uint32Array(0);
  /** Para cada triángulo, la cara B-rep a la que pertenece. */
  private triangleFace = new Int32Array(0);
  /** Para cada vértice, la cara B-rep a la que pertenece (replicad no comparte vértices entre caras). */
  private vertexFace = new Int32Array(0);
  /** Para cada segmento de las líneas de aristas, la arista B-rep. */
  private segmentEdge = new Int32Array(0);
  private hovered: PickItem | null = null;
  private selection: ViewportSelection = { faces: [], edges: [] };
  private pickable: Record<PickKind, boolean> = { face: true, edge: true };
  private pointerDown: { x: number; y: number } | null = null;
  private needsRender = true;

  constructor(private readonly container: HTMLElement, private readonly events: ViewportEvents = {}) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0x1e2228);
    container.appendChild(this.renderer.domElement);

    // Convención CAD: Z hacia arriba.
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100_000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(80, -100, 70);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.15;
    this.controls.addEventListener('change', () => (this.needsRender = true));

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(0.5, 0.3, 1); // relativa a la cámara
    this.camera.add(key);
    this.scene.add(this.camera);

    this.grid = new THREE.GridHelper(200, 20, 0x556070, 0x343a44);
    this.grid.rotation.x = Math.PI / 2; // al plano XY
    this.scene.add(this.grid);
    this.scene.add(new THREE.AxesHelper(20));
    this.scene.add(this.modelGroup);
    this.scene.add(this.sketchGroup);

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerleave', this.onPointerLeave);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.renderer.setAnimationLoop(this.tick);
  }

  setMesh(data: MeshPayload) {
    this.clearModel();
    const faceCount = data.faceRanges.length / 2;

    this.triangleFace = new Int32Array(data.indices.length / 3).fill(-1);
    this.vertexFace = new Int32Array(data.positions.length / 3).fill(-1);
    for (let f = 0; f < faceCount; f++) {
      const start = data.faceRanges[2 * f];
      const count = data.faceRanges[2 * f + 1];
      for (let j = start; j < start + count; j++) this.vertexFace[data.indices[j]] = f;
      this.triangleFace.fill(f, start / 3, (start + count) / 3);
    }

    this.edgePositions = data.edgePositions;
    this.edgeRanges = data.edgeRanges;
    this.segmentEdge = new Int32Array(data.edgePositions.length / 6).fill(-1);
    for (let e = 0; e < data.edgeRanges.length / 2; e++) {
      const start = data.edgeRanges[2 * e];
      const count = data.edgeRanges[2 * e + 1];
      this.segmentEdge.fill(e, start / 2, (start + count) / 2);
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(data.positions.length), 3));
    geom.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geom.computeBoundingSphere();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      metalness: 0.05,
      roughness: 0.65,
      side: THREE.DoubleSide,
      // Empuja las caras hacia atrás para que las aristas se vean nítidas encima.
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    this.mesh = new THREE.Mesh(geom, mat);
    this.modelGroup.add(this.mesh);

    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.BufferAttribute(data.edgePositions, 3));
    this.edges = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0x15181c }));
    this.modelGroup.add(this.edges);

    this.hovered = null;
    this.setSelection({ faces: [], edges: [] });
  }

  /** Quita el modelo (documento vacío o sin sólido). */
  clear() {
    this.clearModel();
    this.triangleFace = new Int32Array(0);
    this.vertexFace = new Int32Array(0);
    this.segmentEdge = new Int32Array(0);
    this.hovered = null;
    this.setSelection({ faces: [], edges: [] });
    this.needsRender = true;
  }

  get hasModel() {
    return this.mesh !== null;
  }

  /** Qué se puede elegir con el mouse (p. ej. solo aristas al elegir para un redondeo). */
  setPickable(p: Partial<Record<PickKind, boolean>>) {
    this.pickable = { face: true, edge: true, ...p };
  }

  /** Curvas de sketches en 3D. Solo se muestran las de `visible`. */
  setSketches(sketches: SketchLines[], visible: ReadonlySet<string>) {
    for (const child of [...this.sketchGroup.children]) {
      const l = child as THREE.LineSegments;
      l.geometry.dispose();
      (l.material as THREE.Material).dispose();
      this.sketchGroup.remove(l);
    }
    for (const sk of sketches) {
      if (!visible.has(sk.id)) continue;
      for (const [positions, construction] of [[sk.segments, false], [sk.construction, true]] as const) {
        if (positions.length === 0) continue;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const mat = construction
          ? new THREE.LineDashedMaterial({ color: 0x8a96a3, dashSize: 2, gapSize: 1.5 })
          : new THREE.LineBasicMaterial({ color: 0xffc857 });
        const lines = new THREE.LineSegments(g, mat);
        if (construction) lines.computeLineDistances();
        this.sketchGroup.add(lines);
      }
    }
    this.needsRender = true;
  }

  /** Encuadra el modelo completo. */
  fitView() {
    if (!this.mesh) return;
    const sphere = this.mesh.geometry.boundingSphere!;
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const dist = (sphere.radius / Math.sin(fov / 2)) * 1.15;
    const dir = new THREE.Vector3(0.55, -0.7, 0.45).normalize();
    this.controls.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(dir, dist);
    this.camera.near = Math.max(dist / 1000, 0.01);
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.needsRender = true;
  }

  setSelection(sel: ViewportSelection) {
    this.selection = { faces: [...sel.faces], edges: [...sel.edges] };
    this.repaint();
    this.events.onSelectionChange?.({ faces: [...sel.faces], edges: [...sel.edges] });
  }

  getSelection(): ViewportSelection {
    return { faces: [...this.selection.faces], edges: [...this.selection.edges] };
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.clearModel();
    this.highlightMaterial.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private tick = () => {
    this.controls.update();
    if (!this.needsRender) return;
    this.needsRender = false;
    this.renderer.render(this.scene, this.camera);
  };

  private resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.highlightMaterial.resolution.set(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.needsRender = true;
  }

  private clearModel() {
    for (const obj of [this.mesh, this.edges]) {
      if (!obj) continue;
      obj.geometry.dispose();
      (obj.material as THREE.Material).dispose();
      this.modelGroup.remove(obj);
    }
    this.clearHighlight();
    this.mesh = null;
    this.edges = null;
  }

  private clearHighlight() {
    if (!this.highlight) return;
    this.highlight.geometry.dispose();
    this.modelGroup.remove(this.highlight);
    this.highlight = null;
  }

  /** Recolorea caras y reconstruye el resaltado de aristas. */
  private repaint() {
    if (this.mesh) {
      const attr = this.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      const selected = new Set(this.selection.faces);
      const hov = this.hovered?.kind === 'face' ? this.hovered.index : -1;
      for (let v = 0; v < this.vertexFace.length; v++) {
        const f = this.vertexFace[v];
        const c = selected.has(f) ? COLOR_SELECTED : f === hov ? COLOR_HOVER : COLOR_BASE;
        arr[3 * v] = c.r;
        arr[3 * v + 1] = c.g;
        arr[3 * v + 2] = c.b;
      }
      attr.needsUpdate = true;
    }

    this.clearHighlight();
    const edges = new Map<number, THREE.Color>();
    if (this.hovered?.kind === 'edge') edges.set(this.hovered.index, COLOR_HOVER);
    for (const e of this.selection.edges) edges.set(e, COLOR_SELECTED);
    if (edges.size > 0) {
      const pos: number[] = [];
      const col: number[] = [];
      for (const [e, c] of edges) {
        const start = this.edgeRanges[2 * e];
        const count = this.edgeRanges[2 * e + 1];
        for (let p = start; p < start + count; p++) {
          pos.push(this.edgePositions[3 * p], this.edgePositions[3 * p + 1], this.edgePositions[3 * p + 2]);
          col.push(c.r, c.g, c.b);
        }
      }
      const g = new LineSegmentsGeometry();
      g.setPositions(pos);
      g.setColors(col);
      this.highlight = new LineSegments2(g, this.highlightMaterial);
      this.highlight.renderOrder = 10;
      this.modelGroup.add(this.highlight);
    }
    this.needsRender = true;
  }

  private pick(ev: PointerEvent): PickItem | null {
    if (!this.mesh) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const faceHit = this.raycaster.intersectObject(this.mesh, false)[0];

    // Umbral de aristas en unidades del mundo, equivalente a EDGE_PICK_PX en pantalla.
    const depth = faceHit?.distance ?? this.camera.position.distanceTo(this.controls.target);
    const worldPerPx = (2 * depth * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / rect.height;
    if (this.pickable.edge && this.edges) {
      this.raycaster.params.Line = { threshold: worldPerPx * EDGE_PICK_PX };
      const edgeHit = this.raycaster.intersectObject(this.edges, false)[0];
      // Solo aristas visibles: no más lejos que la cara bajo el cursor.
      if (edgeHit && edgeHit.index != null && (!faceHit || edgeHit.distance <= faceHit.distance + worldPerPx * 4)) {
        const e = this.segmentEdge[Math.floor(edgeHit.index / 2)];
        if (e >= 0) return { kind: 'edge', index: e };
      }
    }
    if (this.pickable.face && faceHit && faceHit.faceIndex != null) {
      const f = this.triangleFace[faceHit.faceIndex];
      if (f >= 0) return { kind: 'face', index: f };
    }
    return null;
  }

  private onPointerDown = (ev: PointerEvent) => {
    if (ev.button === 0) this.pointerDown = { x: ev.clientX, y: ev.clientY };
  };

  private onPointerUp = (ev: PointerEvent) => {
    const down = this.pointerDown;
    this.pointerDown = null;
    if (ev.button !== 0 || !down) return;
    if (Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > CLICK_TOLERANCE_PX) return; // fue órbita
    const item = this.pick(ev);
    const multi = ev.shiftKey || ev.ctrlKey || ev.metaKey;
    if (!item) {
      if (!multi) this.setSelection({ faces: [], edges: [] });
      return;
    }
    const key = item.kind === 'face' ? 'faces' : 'edges';
    if (multi) {
      const list = this.selection[key];
      const next = list.includes(item.index) ? list.filter((x) => x !== item.index) : [...list, item.index];
      this.setSelection({ ...this.selection, [key]: next });
    } else {
      this.setSelection({ faces: [], edges: [], [key]: [item.index] });
    }
  };

  private onPointerMove = (ev: PointerEvent) => {
    if (ev.buttons !== 0) return; // no resaltar mientras se orbita
    this.setHovered(this.pick(ev));
  };

  private onPointerLeave = () => this.setHovered(null);

  private setHovered(item: PickItem | null) {
    if (item?.kind === this.hovered?.kind && item?.index === this.hovered?.index) return;
    this.hovered = item;
    this.repaint();
    this.events.onHoverChange?.(item);
  }
}
