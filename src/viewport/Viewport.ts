// Viewport 3D: muestra la teselación del kernel, órbita/zoom/pan y selección de caras y aristas.
import { iconMarkup, type IconName } from '../ui/iconPaths';
import {
  baseFaceColor, createFaceMaterial, disposeShadingTextures, highlightColor, isShadingMode, nextShading, SHADING_MODES,
  type ShadingMode,
} from './shading';

const SHADING_KEY = 'cad-parametrico:sombreado';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { Manipulator, MeshPayload, SketchLines } from '../kernel/protocol';
import { ManipulatorWidget, type ManipulatorHandlers } from './ManipulatorWidget';
import { VIEW_DIRECTIONS, ViewCube, type StandardView } from './ViewCube';
import { DrawPlane, type DrawOverlay } from './DrawPlane';
import type { PlaneFrame } from '../document/planes';

/** Eventos del dibujo directo en 3D: coordenadas (u, v) en el plano y posición en pantalla. */
export interface DrawHandlers {
  move: (uv: [number, number], screen: [number, number], ev: PointerEvent) => void;
  click: (uv: [number, number], screen: [number, number], ev: PointerEvent) => void;
}

export type { StandardView };
export type Projection = 'perspective' | 'orthographic';

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
  /** Clic sobre un sketch o un plano de construcción visibles (id de la feature). */
  onFeaturePick?: (featureId: string) => void;
  /** Clic en el vacío (sin modelo, sketch ni plano debajo). */
  onEmptyClick?: () => void;
}

const COLOR_HOVER = new THREE.Color(0x7fb8ff);
const COLOR_SELECTED = new THREE.Color(0xff9a3c);
const COLOR_EDGE = new THREE.Color(0x15181c);
/** Aristas entre caras tangentes: se ven, pero más suaves (como en Fusion/FreeCAD). */
const COLOR_TANGENT_EDGE = new THREE.Color(0x6f7a86);
const EDGE_TANGENT = 1;
const EDGE_SEAM = 2;
/** Movimiento máximo del puntero (px) para considerar un clic y no un arrastre de órbita. */
const CLICK_TOLERANCE_PX = 4;
/** Distancia en px a la que una arista se puede elegir. */
const EDGE_PICK_PX = 6;

export class Viewport {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly perspCamera: THREE.PerspectiveCamera;
  private readonly orthoCamera: THREE.OrthographicCamera;
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  private readonly viewCube: ViewCube;
  private readonly manipulator: ManipulatorWidget;
  private readonly drawPlane: DrawPlane;
  /** Medición: línea punteada entre los puntos más cercanos y etiqueta con la distancia. */
  private measureLine: THREE.Line | null = null;
  private measureAt: THREE.Vector3 | null = null;
  private readonly measureLabel: HTMLDivElement;
  private readonly measureMat = new THREE.LineDashedMaterial({ color: 0x9fe08a, dashSize: 1.5, gapSize: 1, depthTest: false });
  private drawHandlers: DrawHandlers | null = null;
  private readonly planeGroup = new THREE.Group();
  /** Animación de cámara hacia una vista estándar. */
  private anim: { from: THREE.Vector3; to: THREE.Vector3; upFrom: THREE.Vector3; upTo: THREE.Vector3; t0: number } | null = null;
  private readonly controls: OrbitControls;
  private readonly raycaster = new THREE.Raycaster();
  private readonly resizeObserver: ResizeObserver;
  private readonly constructionGroup = new THREE.Group();
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
  private animDistance = 0;
  private projectionButton: HTMLButtonElement | null = null;
  private shadingButton: HTMLButtonElement | null = null;
  private shadingMenu: HTMLDivElement | null = null;
  /** Sombreado de las caras (estándar o modos de análisis); se recuerda en este navegador. */
  private shading: ShadingMode = loadShading();

  constructor(private readonly container: HTMLElement, private readonly events: ViewportEvents = {}) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0x1e2228);
    container.appendChild(this.renderer.domElement);

    // Convención CAD: Z hacia arriba.
    this.perspCamera = new THREE.PerspectiveCamera(40, 1, 0.1, 100_000);
    this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -100_000, 100_000);
    for (const cam of [this.perspCamera, this.orthoCamera]) {
      cam.up.set(0, 0, 1);
      cam.position.set(80, -100, 70);
      const key = new THREE.DirectionalLight(0xffffff, 1.4);
      key.position.set(0.5, 0.3, 1); // relativa a la cámara
      cam.add(key);
      this.scene.add(cam);
    }
    this.camera = this.perspCamera;

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.15;
    this.controls.addEventListener('change', () => (this.needsRender = true));

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));

    this.grid = new THREE.GridHelper(200, 20, 0x556070, 0x343a44);
    this.grid.rotation.x = Math.PI / 2; // al plano XY
    this.scene.add(this.grid);
    this.scene.add(new THREE.AxesHelper(20));
    this.scene.add(this.modelGroup);
    this.scene.add(this.sketchGroup);
    this.scene.add(this.planeGroup);
    this.scene.add(this.constructionGroup);

    this.manipulator = new ManipulatorWidget(container, () => (this.needsRender = true));
    this.scene.add(this.manipulator.group);
    this.drawPlane = new DrawPlane(container);
    this.scene.add(this.drawPlane.group);
    this.measureLabel = document.createElement('div');
    this.measureLabel.className = 'measure-label';
    this.measureLabel.style.display = 'none';
    container.appendChild(this.measureLabel);

    this.viewCube = new ViewCube((v) => this.setStandardView(v));
    container.appendChild(this.viewCube.element);
    container.appendChild(this.buildViewControls());

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
    // Líneas visibles: sin costuras (no son bordes reales); las tangentes se dibujan tenues.
    const linePos: number[] = [];
    const lineCol: number[] = [];
    const segEdge: number[] = [];
    for (let e = 0; e < data.edgeRanges.length / 2; e++) {
      const kind = data.edgeKinds[e];
      if (kind === EDGE_SEAM) continue;
      const c = kind === EDGE_TANGENT ? COLOR_TANGENT_EDGE : COLOR_EDGE;
      const start = data.edgeRanges[2 * e];
      const count = data.edgeRanges[2 * e + 1];
      for (let p = start; p < start + count; p++) {
        linePos.push(data.edgePositions[3 * p], data.edgePositions[3 * p + 1], data.edgePositions[3 * p + 2]);
        lineCol.push(c.r, c.g, c.b);
      }
      for (let k = 0; k < count / 2; k++) segEdge.push(e);
    }
    this.segmentEdge = Int32Array.from(segEdge);

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(data.positions.length), 3));
    geom.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geom.computeBoundingSphere();

    this.mesh = new THREE.Mesh(geom, createFaceMaterial(this.shading));
    this.modelGroup.add(this.mesh);

    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(linePos), 3));
    eg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(lineCol), 3));
    this.edges = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ vertexColors: true }));
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
        lines.userData.featureId = sk.id;
        this.sketchGroup.add(lines);
      }
    }
    this.needsRender = true;
  }

  /** Encuadra el modelo completo. */
  fitView(direction?: THREE.Vector3) {
    if (!this.mesh) return;
    const sphere = this.mesh.geometry.boundingSphere!;
    const fov = THREE.MathUtils.degToRad(this.perspCamera.fov);
    const dist = (sphere.radius / Math.sin(fov / 2)) * 1.15;
    const dir = direction ?? this.camera.position.clone().sub(this.controls.target).normalize();
    if (!direction && dir.lengthSq() < 0.5) dir.set(0.55, -0.7, 0.45).normalize();
    this.controls.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(dir, dist);
    this.perspCamera.near = Math.max(dist / 1000, 0.01);
    this.perspCamera.far = dist * 100;
    this.perspCamera.updateProjectionMatrix();
    this.orthoCamera.zoom = 1;
    this.updateOrthoFrustum();
    this.controls.update();
    this.needsRender = true;
  }

  /** Gira la cámara (animada) a una vista estándar, manteniendo objetivo y distancia. */
  setStandardView(view: StandardView) {
    const { dir, up } = VIEW_DIRECTIONS[view];
    const dist = this.camera.position.distanceTo(this.controls.target);
    this.anim = {
      from: this.camera.position.clone().sub(this.controls.target).normalize(),
      to: dir.clone(),
      upFrom: this.camera.up.clone(),
      upTo: up.clone(),
      t0: performance.now(),
    };
    this.animDistance = dist;
    this.needsRender = true;
  }

  get projection(): Projection {
    return this.camera === this.orthoCamera ? 'orthographic' : 'perspective';
  }

  setProjection(p: Projection) {
    const next = p === 'orthographic' ? this.orthoCamera : this.perspCamera;
    if (next === this.camera) return;
    next.position.copy(this.camera.position);
    next.up.copy(this.camera.up);
    next.lookAt(this.controls.target);
    this.camera = next;
    this.controls.object = next;
    if (p === 'orthographic') {
      this.orthoCamera.zoom = 1;
      this.updateOrthoFrustum();
    }
    this.controls.update();
    this.updateProjectionButton();
    this.needsRender = true;
  }

  /** Acerca (factor < 1) o aleja (factor > 1) respecto del objetivo. */
  zoomBy(factor: number) {
    if (this.camera === this.orthoCamera) {
      this.orthoCamera.zoom /= factor;
      this.orthoCamera.updateProjectionMatrix();
    } else {
      const t = this.controls.target;
      this.camera.position.sub(t).multiplyScalar(factor).add(t);
    }
    this.controls.update();
    this.needsRender = true;
  }

  /** Manipulador 3D de la feature seleccionada (null para ocultarlo). */
  setManipulator(spec: Manipulator | null, handlers: ManipulatorHandlers | null) {
    this.manipulator.set(spec, handlers);
    this.needsRender = true;
  }

  /**
   * Modo dibujo directo: el cursor se proyecta sobre el plano `frame` y los clics se envían a
   * `handlers` en lugar de seleccionar. null lo apaga.
   */
  setDrawMode(frame: PlaneFrame | null, handlers: DrawHandlers | null, center?: [number, number], extent?: number, step?: number) {
    this.drawPlane.setPlane(frame, center, extent, step);
    this.drawHandlers = frame ? handlers : null;
    if (frame) {
      this.setHovered(null);
      this.manipulator.set(null, null);
    }
    this.renderer.domElement.style.cursor = frame ? 'crosshair' : '';
    this.needsRender = true;
  }

  setDrawOverlay(o: DrawOverlay) {
    this.drawPlane.setOverlay(o);
    this.needsRender = true;
  }

  /** Muestra (o quita con null) la medición entre dos puntos. */
  setMeasure(m: { p1: readonly number[]; p2: readonly number[]; text: string } | null) {
    if (this.measureLine) {
      this.measureLine.geometry.dispose();
      this.scene.remove(this.measureLine);
      this.measureLine = null;
    }
    this.measureAt = null;
    this.measureLabel.style.display = 'none';
    if (m) {
      const a = new THREE.Vector3(m.p1[0], m.p1[1], m.p1[2]);
      const b = new THREE.Vector3(m.p2[0], m.p2[1], m.p2[2]);
      this.measureLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), this.measureMat);
      this.measureLine.computeLineDistances();
      this.measureLine.renderOrder = 25;
      this.scene.add(this.measureLine);
      this.measureAt = a.clone().add(b).multiplyScalar(0.5);
      this.measureLabel.textContent = m.text;
    }
    this.needsRender = true;
  }

  private updateMeasureLabel() {
    if (!this.measureAt) return;
    const p = this.measureAt.clone().project(this.camera);
    const { w, h } = this.size();
    this.measureLabel.style.display = p.z > 1 ? 'none' : '';
    this.measureLabel.style.left = `${((p.x + 1) / 2) * w + 10}px`;
    this.measureLabel.style.top = `${((1 - p.y) / 2) * h - 10}px`;
  }

  /** Posición en pantalla (px dentro del viewport) de un punto 3D. */
  project(p: readonly number[]): [number, number] {
    const v = new THREE.Vector3(p[0], p[1], p[2]).project(this.camera);
    const { w, h } = this.size();
    return [((v.x + 1) / 2) * w, ((1 - v.y) / 2) * h];
  }

  /** mm por píxel en un punto 3D (para grillas y tolerancias de enganche). */
  mmPerPixelAt(p: readonly number[]): number {
    return this.worldPerPixel(new THREE.Vector3(p[0], p[1], p[2]));
  }

  /** Radio de la esfera que envuelve el modelo (o 0 si no hay). */
  get modelRadius(): number {
    return this.mesh?.geometry.boundingSphere?.radius ?? 0;
  }

  /**
   * Planos de construcción: rectángulos naranja translúcidos (más marcado el seleccionado),
   * centrados en la proyección del centro del modelo sobre cada plano.
   */
  setConstructionPlanes(planes: { id: string; frame: { origin: number[]; xDir: number[]; yDir: number[]; normal: number[] }; selected: boolean }[]) {
    for (const child of [...this.constructionGroup.children]) {
      const m = child as THREE.Mesh | THREE.LineLoop;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      this.constructionGroup.remove(m);
    }
    const sphere = this.mesh?.geometry.boundingSphere;
    const c = sphere?.center ?? new THREE.Vector3();
    const half = Math.max(15, (sphere?.radius ?? 0) * 0.75);
    for (const p of planes) {
      const { origin, xDir, yDir, normal } = p.frame;
      // Centro: el del modelo proyectado sobre el plano.
      const d = (c.x - origin[0]) * normal[0] + (c.y - origin[1]) * normal[1] + (c.z - origin[2]) * normal[2];
      const center = new THREE.Vector3(c.x - normal[0] * d, c.y - normal[1] * d, c.z - normal[2] * d);
      const P = (u: number, v: number) => center.clone().add(new THREE.Vector3(
        xDir[0] * u + yDir[0] * v, xDir[1] * u + yDir[1] * v, xDir[2] * u + yDir[2] * v,
      ));
      const corners = [P(-half, -half), P(half, -half), P(half, half), P(-half, half)];
      const g = new THREE.BufferGeometry().setFromPoints([corners[0], corners[1], corners[2], corners[0], corners[2], corners[3]]);
      const quad = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
        color: 0xf0a040, transparent: true, opacity: p.selected ? 0.22 : 0.09, side: THREE.DoubleSide, depthWrite: false,
      }));
      const border = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(corners), new THREE.LineBasicMaterial({
        color: 0xf0a040, transparent: true, opacity: p.selected ? 1 : 0.55,
      }));
      quad.renderOrder = border.renderOrder = 5;
      quad.userData.featureId = border.userData.featureId = p.id;
      this.constructionGroup.add(quad, border);
    }
    this.needsRender = true;
  }

  /** Planos translúcidos de los sketches indicados (vista previa del plano de trabajo). */
  setSketchPlanes(sketches: SketchLines[], visible: ReadonlySet<string>) {
    for (const child of [...this.planeGroup.children]) {
      const m = child as THREE.Mesh | THREE.LineLoop;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      this.planeGroup.remove(m);
    }
    for (const sk of sketches) {
      if (!visible.has(sk.id)) continue;
      const { origin, xDir, yDir } = sk.plane;
      const [u0, v0, u1, v1] = sk.bounds;
      const P = (u: number, v: number) => new THREE.Vector3(
        origin[0] + xDir[0] * u + yDir[0] * v,
        origin[1] + xDir[1] * u + yDir[1] * v,
        origin[2] + xDir[2] * u + yDir[2] * v,
      );
      const corners = [P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)];
      const g = new THREE.BufferGeometry().setFromPoints([corners[0], corners[1], corners[2], corners[0], corners[2], corners[3]]);
      g.computeVertexNormals();
      const quad = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
        color: 0x4a90d9, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false,
      }));
      const border = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(corners), new THREE.LineBasicMaterial({
        color: 0x4a90d9, transparent: true, opacity: 0.6,
      }));
      this.planeGroup.add(quad, border);
    }
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
    this.viewCube.dispose();
    this.manipulator.dispose();
    this.drawPlane.dispose();
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.clearModel();
    this.highlightMaterial.dispose();
    disposeShadingTextures();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private tick = () => {
    this.stepAnimation();
    this.controls.update();
    if (!this.needsRender) return;
    this.needsRender = false;
    this.manipulator.update(this.camera, (p) => this.worldPerPixel(p), this.size());
    this.drawPlane.update(this.camera, (p) => this.worldPerPixel(p), this.size());
    this.updateMeasureLabel();
    this.renderer.render(this.scene, this.camera);
    this.viewCube.sync(this.camera, this.controls.target);
  };

  private resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.highlightMaterial.resolution.set(w, h);
    this.perspCamera.aspect = w / h;
    this.perspCamera.updateProjectionMatrix();
    this.updateOrthoFrustum();
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
      const base = baseFaceColor(this.shading);
      const sel = highlightColor(this.shading, COLOR_SELECTED);
      const hover = highlightColor(this.shading, COLOR_HOVER);
      for (let v = 0; v < this.vertexFace.length; v++) {
        const f = this.vertexFace[v];
        const c = selected.has(f) ? sel : f === hov ? hover : base;
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

  private size() {
    return { w: Math.max(1, this.container.clientWidth), h: Math.max(1, this.container.clientHeight) };
  }

  /** Tamaño en unidades del mundo de un píxel de pantalla en el punto `p`. */
  private worldPerPixel(p: THREE.Vector3): number {
    const h = this.size().h;
    if (this.camera === this.orthoCamera) {
      return (this.orthoCamera.top - this.orthoCamera.bottom) / this.orthoCamera.zoom / h;
    }
    const depth = p.clone().sub(this.camera.position).dot(this.camera.getWorldDirection(new THREE.Vector3()));
    return (2 * Math.max(depth, 1e-3) * Math.tan(THREE.MathUtils.degToRad(this.perspCamera.fov / 2))) / h;
  }

  /** El frustum ortográfico abarca lo mismo que la perspectiva a la distancia del objetivo. */
  private updateOrthoFrustum() {
    const { w, h } = this.size();
    const dist = this.camera.position.distanceTo(this.controls.target) || 100;
    const halfH = dist * Math.tan(THREE.MathUtils.degToRad(this.perspCamera.fov / 2));
    this.orthoCamera.top = halfH;
    this.orthoCamera.bottom = -halfH;
    this.orthoCamera.left = (-halfH * w) / h;
    this.orthoCamera.right = (halfH * w) / h;
    this.orthoCamera.updateProjectionMatrix();
  }

  private stepAnimation() {
    const a = this.anim;
    if (!a) return;
    const t = Math.min(1, (performance.now() - a.t0) / 350);
    const k = t * t * (3 - 2 * t); // suavizado
    const dir = a.from.clone().lerp(a.to, k);
    if (dir.lengthSq() < 1e-6) dir.copy(a.to); // vistas opuestas: salto directo
    dir.normalize();
    this.camera.position.copy(this.controls.target).addScaledVector(dir, this.animDistance);
    this.camera.up.copy(a.upFrom.clone().lerp(a.upTo, k).normalize());
    this.camera.lookAt(this.controls.target);
    if (t >= 1) {
      this.anim = null;
      for (const cam of [this.perspCamera, this.orthoCamera]) cam.up.copy(a.upTo);
    }
    this.needsRender = true;
  }

  private buildViewControls(): HTMLDivElement {
    const bar = document.createElement('div');
    bar.className = 'view-controls';
    const button = (icon: IconName | null, label: string, key: string | null, onClick: () => void) => {
      const b = document.createElement('button');
      if (icon) b.innerHTML = iconMarkup(icon, 16);
      b.dataset.tip = label;
      b.setAttribute('aria-label', label);
      if (key) b.dataset.key = key;
      b.addEventListener('click', onClick);
      bar.appendChild(b);
      return b;
    };
    button('iso', 'Vista isométrica', null, () => this.setStandardView('iso'));
    button('fit', 'Encuadrar todo', 'F', () => this.fitView());
    button('zoomIn', 'Acercar', 'Rueda', () => this.zoomBy(0.8));
    button('zoomOut', 'Alejar', 'Rueda', () => this.zoomBy(1.25));
    this.projectionButton = button(null, '', null, () =>
      this.setProjection(this.projection === 'perspective' ? 'orthographic' : 'perspective'),
    );
    this.updateProjectionButton();

    // Sombreado: botón con el modo actual y lista desplegable.
    this.shadingButton = button(null, '', 'Z', () => this.toggleShadingMenu());
    this.shadingButton.classList.add('shading-btn');
    const menu = document.createElement('div');
    menu.className = 'shading-menu';
    menu.hidden = true;
    for (const m of SHADING_MODES) {
      const item = document.createElement('button');
      item.dataset.mode = m.id;
      item.dataset.tip = m.label;
      item.dataset.desc = m.desc;
      item.textContent = m.label;
      item.addEventListener('click', () => {
        this.setShading(m.id);
        this.toggleShadingMenu(false);
      });
      menu.appendChild(item);
    }
    bar.appendChild(menu);
    this.shadingMenu = menu;
    this.updateShadingButton();
    return bar;
  }

  get shadingMode(): ShadingMode {
    return this.shading;
  }

  /** Cambia el sombreado de las caras (matcap, cebra, normales…). */
  setShading(mode: ShadingMode) {
    if (mode === this.shading) return;
    this.shading = mode;
    try {
      localStorage.setItem(SHADING_KEY, mode);
    } catch {
      // Sin almacenamiento (ventana privada): solo dura esta sesión.
    }
    if (this.mesh) {
      (this.mesh.material as THREE.Material).dispose();
      this.mesh.material = createFaceMaterial(mode);
      this.repaint();
    }
    this.updateShadingButton();
    this.needsRender = true;
  }

  /** Pasa al siguiente modo de sombreado (atajo Z). */
  cycleShading() {
    this.setShading(nextShading(this.shading));
  }

  private toggleShadingMenu(open = this.shadingMenu?.hidden === true) {
    if (!this.shadingMenu) return;
    this.shadingMenu.hidden = !open;
    this.shadingButton?.classList.toggle('active', open);
  }

  private updateShadingButton() {
    const m = SHADING_MODES.find((x) => x.id === this.shading)!;
    if (this.shadingButton) {
      this.shadingButton.innerHTML = `${iconMarkup('shading', 14)}<span>${m.label}</span>`;
      this.shadingButton.dataset.tip = `Sombreado: ${m.label}`;
      this.shadingButton.dataset.desc = 'Clic: elegir modo. Z: pasar al siguiente';
      this.shadingButton.setAttribute('aria-label', this.shadingButton.dataset.tip);
    }
    for (const item of this.shadingMenu?.children ?? []) {
      (item as HTMLElement).classList.toggle('active', (item as HTMLElement).dataset.mode === this.shading);
    }
  }

  private updateProjectionButton() {
    if (!this.projectionButton) return;
    const ortho = this.projection === 'orthographic';
    this.projectionButton.textContent = ortho ? 'Orto' : 'Persp';
    this.projectionButton.dataset.tip = ortho ? 'Proyección ortográfica' : 'Proyección en perspectiva';
    this.projectionButton.dataset.desc = ortho ? 'Clic: pasar a perspectiva' : 'Clic: pasar a ortográfica (sin deformación, para medir a ojo)';
    this.projectionButton.setAttribute('aria-label', this.projectionButton.dataset.tip);
  }

  private screenOf(ev: PointerEvent): [number, number] {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return [ev.clientX - rect.left, ev.clientY - rect.top];
  }

  private rayFrom(ev: PointerEvent): THREE.Raycaster {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster;
  }

  /**
   * Sketch o plano de construcción bajo el cursor. Las líneas de sketch y los bordes de los planos
   * ganan si no están detrás del modelo; el área de un plano, solo donde no hay modelo.
   */
  private pickFeature(ev: PointerEvent): string | null {
    this.rayFrom(ev);
    const faceHit = this.mesh ? this.raycaster.intersectObject(this.mesh, false)[0] : undefined;
    const worldPerPx = this.worldPerPixel(faceHit?.point ?? this.controls.target);
    this.raycaster.params.Line = { threshold: worldPerPx * EDGE_PICK_PX };
    const lines = [
      ...this.sketchGroup.children,
      ...this.constructionGroup.children.filter((c) => (c as THREE.Object3D).type === 'LineLoop'),
    ];
    const lineHit = this.raycaster.intersectObjects(lines, false)[0];
    if (lineHit && (!faceHit || lineHit.distance <= faceHit.distance + worldPerPx * 4)) {
      return (lineHit.object.userData.featureId as string | undefined) ?? null;
    }
    if (!faceHit) {
      const quads = this.constructionGroup.children.filter((c) => (c as THREE.Object3D).type === 'Mesh');
      const quadHit = this.raycaster.intersectObjects(quads, false)[0];
      if (quadHit) return (quadHit.object.userData.featureId as string | undefined) ?? null;
    }
    return null;
  }

  private pick(ev: PointerEvent): PickItem | null {
    if (!this.mesh) return null;
    this.rayFrom(ev);
    const faceHit = this.raycaster.intersectObject(this.mesh, false)[0];

    // Umbral de aristas en unidades del mundo, equivalente a EDGE_PICK_PX en pantalla.
    const worldPerPx = this.worldPerPixel(faceHit?.point ?? this.controls.target);
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
    if (ev.button !== 0) return;
    // El asa del manipulador tiene prioridad sobre la órbita y la selección.
    if (!this.drawHandlers && this.manipulator.active && this.manipulator.hitTest(this.rayFrom(ev))) {
      this.manipulator.beginDrag();
      this.controls.enabled = false;
      this.renderer.domElement.setPointerCapture(ev.pointerId);
      return;
    }
    this.pointerDown = { x: ev.clientX, y: ev.clientY };
  };

  private onPointerUp = (ev: PointerEvent) => {
    if (this.manipulator.isDragging) {
      this.manipulator.endDrag();
      this.controls.enabled = true;
      this.renderer.domElement.releasePointerCapture(ev.pointerId);
      return;
    }
    const down = this.pointerDown;
    this.pointerDown = null;
    if (ev.button !== 0 || !down) return;
    if (Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > CLICK_TOLERANCE_PX) return; // fue órbita
    if (this.drawHandlers) {
      const uv = this.drawPlane.intersect(this.rayFrom(ev).ray);
      if (uv) this.drawHandlers.click(uv, this.screenOf(ev), ev);
      return;
    }
    const multi = ev.shiftKey || ev.ctrlKey || ev.metaKey;
    const feature = this.pickable.face && this.pickable.edge && !multi ? this.pickFeature(ev) : null;
    if (feature) {
      this.setSelection({ faces: [], edges: [] });
      this.events.onFeaturePick?.(feature);
      return;
    }
    const item = this.pick(ev);
    if (!item) {
      if (!multi) {
        this.setSelection({ faces: [], edges: [] });
        this.events.onEmptyClick?.();
      }
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
    if (this.manipulator.isDragging) {
      this.manipulator.drag(this.rayFrom(ev), ev.shiftKey);
      return;
    }
    if (ev.buttons !== 0) return; // no resaltar mientras se orbita
    if (this.drawHandlers) {
      const uv = this.drawPlane.intersect(this.rayFrom(ev).ray);
      if (uv) this.drawHandlers.move(uv, this.screenOf(ev), ev);
      return;
    }
    if (this.manipulator.active) {
      const over = this.manipulator.hitTest(this.rayFrom(ev));
      this.manipulator.setHover(over);
      this.renderer.domElement.style.cursor = over ? 'grab' : '';
      if (over) return this.setHovered(null);
    }
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

function loadShading(): ShadingMode {
  try {
    const v = localStorage.getItem(SHADING_KEY);
    if (isShadingMode(v)) return v;
  } catch {
    // Sin almacenamiento: se usa el estándar.
  }
  return 'standard';
}
