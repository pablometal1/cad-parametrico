// Viewport 3D: muestra la teselación del kernel, órbita/zoom/pan y selección de caras.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { MeshPayload } from '../kernel/protocol';

export interface ViewportEvents {
  /** Caras seleccionadas (índices en shape.faces), en orden de selección. */
  onSelectionChange?: (faces: number[]) => void;
  onHoverChange?: (face: number | null) => void;
}

const COLOR_BASE = new THREE.Color(0xb8c4d0);
const COLOR_HOVER = new THREE.Color(0x7fb8ff);
const COLOR_SELECTED = new THREE.Color(0xff9a3c);
/** Movimiento máximo del puntero (px) para considerar un clic y no un arrastre de órbita. */
const CLICK_TOLERANCE_PX = 4;

export class Viewport {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly raycaster = new THREE.Raycaster();
  private readonly resizeObserver: ResizeObserver;
  private readonly modelGroup = new THREE.Group();
  private readonly grid: THREE.GridHelper;

  private mesh: THREE.Mesh | null = null;
  private edges: THREE.LineSegments | null = null;
  /** Para cada triángulo, la cara B-rep a la que pertenece. */
  private triangleFace = new Int32Array(0);
  /** Para cada vértice, la cara B-rep a la que pertenece (replicad no comparte vértices entre caras). */
  private vertexFace = new Int32Array(0);
  private hovered: number | null = null;
  private selected: number[] = [];
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
    this.setSelection([]);
    this.repaintColors();
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

  setSelection(faces: number[]) {
    this.selected = faces;
    this.repaintColors();
    this.events.onSelectionChange?.([...faces]);
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.clearModel();
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
    this.mesh = null;
    this.edges = null;
  }

  private repaintColors() {
    if (!this.mesh) return;
    const attr = this.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const selected = new Set(this.selected);
    for (let v = 0; v < this.vertexFace.length; v++) {
      const f = this.vertexFace[v];
      const c = selected.has(f) ? COLOR_SELECTED : f === this.hovered ? COLOR_HOVER : COLOR_BASE;
      arr[3 * v] = c.r;
      arr[3 * v + 1] = c.g;
      arr[3 * v + 2] = c.b;
    }
    attr.needsUpdate = true;
    this.needsRender = true;
  }

  private pickFace(ev: PointerEvent): number | null {
    if (!this.mesh) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.mesh, false)[0];
    if (!hit || hit.faceIndex == null) return null;
    const f = this.triangleFace[hit.faceIndex];
    return f >= 0 ? f : null;
  }

  private onPointerDown = (ev: PointerEvent) => {
    if (ev.button === 0) this.pointerDown = { x: ev.clientX, y: ev.clientY };
  };

  private onPointerUp = (ev: PointerEvent) => {
    const down = this.pointerDown;
    this.pointerDown = null;
    if (ev.button !== 0 || !down) return;
    if (Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > CLICK_TOLERANCE_PX) return; // fue órbita
    const face = this.pickFace(ev);
    const multi = ev.shiftKey || ev.ctrlKey || ev.metaKey;
    if (face === null) {
      if (!multi) this.setSelection([]);
    } else if (multi) {
      this.setSelection(
        this.selected.includes(face) ? this.selected.filter((f) => f !== face) : [...this.selected, face],
      );
    } else {
      this.setSelection([face]);
    }
  };

  private onPointerMove = (ev: PointerEvent) => {
    if (ev.buttons !== 0) return; // no resaltar mientras se orbita
    this.setHovered(this.pickFace(ev));
  };

  private onPointerLeave = () => this.setHovered(null);

  private setHovered(face: number | null) {
    if (face === this.hovered) return;
    this.hovered = face;
    this.repaintColors();
    this.events.onHoverChange?.(face);
  }
}
