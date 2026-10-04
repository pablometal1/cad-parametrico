// Cubo de navegación: muestra la orientación de la cámara y permite elegir vistas estándar con un clic.
import * as THREE from 'three';

export type StandardView = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso';

/** Dirección desde el objetivo hacia la cámara y vector "arriba" de cada vista (Z arriba). */
export const VIEW_DIRECTIONS: Record<StandardView, { dir: THREE.Vector3; up: THREE.Vector3 }> = {
  front: { dir: new THREE.Vector3(0, -1, 0), up: new THREE.Vector3(0, 0, 1) },
  back: { dir: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 0, 1) },
  right: { dir: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 0, 1) },
  left: { dir: new THREE.Vector3(-1, 0, 0), up: new THREE.Vector3(0, 0, 1) },
  top: { dir: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0) },
  bottom: { dir: new THREE.Vector3(0, 0, -1), up: new THREE.Vector3(0, -1, 0) },
  iso: { dir: new THREE.Vector3(1, -1, 0.8).normalize(), up: new THREE.Vector3(0, 0, 1) },
};

// BoxGeometry está pensado con Y arriba: el cubo se gira +90° alrededor de X para que Z quede
// arriba con los textos derechos. Orden de materiales (antes de girar): +X, -X, +Y, -Y, +Z, -Z,
// que después del giro son: derecha, izquierda, arriba, abajo, frente (-Y), atrás (+Y).
const FACES: { view: StandardView; label: string; flip?: boolean }[] = [
  { view: 'right', label: 'DER' },
  { view: 'left', label: 'IZQ' },
  { view: 'top', label: 'ARRIBA', flip: true },
  { view: 'bottom', label: 'ABAJO', flip: true },
  { view: 'front', label: 'FRENTE' },
  { view: 'back', label: 'ATRÁS' },
];

const SIZE_PX = 96;

export class ViewCube {
  readonly element: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10);
  private readonly cube: THREE.Mesh;
  private readonly materials: THREE.MeshBasicMaterial[];
  private readonly raycaster = new THREE.Raycaster();
  private hovered = -1;

  constructor(private readonly onPick: (view: StandardView) => void) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(SIZE_PX, SIZE_PX);
    this.element = this.renderer.domElement;
    this.element.className = 'view-cube';
    this.element.title = 'Clic en una cara para ver desde ese lado';

    this.materials = FACES.map((f) => new THREE.MeshBasicMaterial({ map: labelTexture(f.label, f.flip) }));
    const box = new THREE.BoxGeometry(2, 2, 2);
    box.rotateX(Math.PI / 2);
    this.cube = new THREE.Mesh(box, this.materials);
    this.scene.add(this.cube);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(this.cube.geometry),
      new THREE.LineBasicMaterial({ color: 0x5d6b7a }),
    );
    this.scene.add(edges);
    this.camera.up.set(0, 0, 1);

    this.element.addEventListener('pointermove', this.onMove);
    this.element.addEventListener('pointerleave', () => this.setHover(-1));
    this.element.addEventListener('click', this.onClick);
  }

  /** Copia la orientación de la cámara principal (dirección objetivo→cámara y "arriba"). */
  sync(camera: THREE.Camera, target: THREE.Vector3) {
    const dir = camera.position.clone().sub(target).normalize();
    this.camera.position.copy(dir.multiplyScalar(4));
    this.camera.up.copy(camera.up);
    this.camera.lookAt(0, 0, 0);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.renderer.dispose();
    this.materials.forEach((m) => {
      m.map?.dispose();
      m.dispose();
    });
    this.element.remove();
  }

  private faceAt(ev: PointerEvent | MouseEvent): number {
    const r = this.element.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.cube)[0];
    return hit?.face ? hit.face.materialIndex : -1;
  }

  private onMove = (ev: PointerEvent) => this.setHover(this.faceAt(ev));

  private onClick = (ev: MouseEvent) => {
    const i = this.faceAt(ev);
    if (i >= 0) this.onPick(FACES[i].view);
  };

  private setHover(i: number) {
    if (i === this.hovered) return;
    if (this.hovered >= 0) this.materials[this.hovered].color.set(0xffffff);
    if (i >= 0) this.materials[i].color.set(0xffc58a);
    this.hovered = i;
    this.element.style.cursor = i >= 0 ? 'pointer' : 'default';
    this.renderer.render(this.scene, this.camera);
  }
}

function labelTexture(text: string, flip = false): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#3a424d';
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = '#5d6b7a';
  g.lineWidth = 6;
  g.strokeRect(3, 3, 122, 122);
  g.fillStyle = '#e6eaee';
  g.font = `bold ${text.length > 5 ? 22 : 28}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 64, 64);
  const t = new THREE.CanvasTexture(c);
  if (flip) {
    // Arriba/abajo: legibles mirando desde el frente (el giro del cubo los deja invertidos).
    t.center.set(0.5, 0.5);
    t.rotation = Math.PI;
  }
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
