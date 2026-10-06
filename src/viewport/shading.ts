// Modos de sombreado para analizar superficies: matcaps (color según la normal vista desde la
// cámara), franjas de cebra (continuidad entre caras) y normales (orientación en el mundo).
import * as THREE from 'three';

export type ShadingMode = 'standard' | 'clay' | 'chrome' | 'zebra' | 'normals';

export const SHADING_MODES: { id: ShadingMode; label: string; desc: string }[] = [
  { id: 'standard', label: 'Estándar', desc: 'Iluminación normal' },
  { id: 'clay', label: 'Arcilla', desc: 'Matcap suave: forma general sin reflejos que distraigan' },
  { id: 'chrome', label: 'Cromo', desc: 'Matcap de horizonte: los quiebres de la normal cortan el reflejo' },
  { id: 'zebra', label: 'Cebra', desc: 'Franjas: cortadas = arista viva, quebradas = solo tangente, suaves = curvatura continua' },
  { id: 'normals', label: 'Normales', desc: 'Color según hacia dónde apunta la cara (X rojo, Y verde, Z azul); cara trasera en rojo' },
];

export function nextShading(mode: ShadingMode): ShadingMode {
  const i = SHADING_MODES.findIndex((m) => m.id === mode);
  return SHADING_MODES[(i + 1) % SHADING_MODES.length].id;
}

export function isShadingMode(v: unknown): v is ShadingMode {
  return SHADING_MODES.some((m) => m.id === v);
}

/**
 * Imagen RGBA de un matcap: una esfera vista de frente, iluminada. La fila 0 es la de abajo
 * (como espera DataTexture). Cada píxel corresponde a una normal n = (x, y, √(1−x²−y²)).
 */
export function matcapPixels(kind: 'clay' | 'chrome', size = 256): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = ((i + 0.5) / size) * 2 - 1;
      const y = ((j + 0.5) / size) * 2 - 1;
      const r2 = x * x + y * y;
      // Fuera del disco se repite el borde (la textura se muestrea apenas adentro).
      const k = r2 > 1 ? 1 / Math.sqrt(r2) : 1;
      const nx = x * k;
      const ny = y * k;
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      const c = kind === 'clay' ? clay(nx, ny, nz) : chrome(nx, ny, nz);
      const o = 4 * (j * size + i);
      out[o] = to8(c[0]);
      out[o + 1] = to8(c[1]);
      out[o + 2] = to8(c[2]);
      out[o + 3] = 255;
    }
  }
  return out;
}

function to8(v: number) {
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
}

/** Arcilla: luz principal arriba a la izquierda, relleno suave y un borde claro. */
function clay(nx: number, ny: number, nz: number): [number, number, number] {
  const key = Math.max(0, dot3(nx, ny, nz, -0.45, 0.55, 0.7));
  const fill = Math.max(0, dot3(nx, ny, nz, 0.6, -0.2, 0.75));
  const rim = Math.pow(1 - nz, 3);
  const spec = Math.pow(Math.max(0, dot3(nx, ny, nz, -0.3, 0.4, 0.87)), 40) * 0.25;
  const v = 0.16 + 0.62 * key + 0.18 * fill + 0.22 * rim + spec;
  return [v * 0.93, v * 0.88, v * 0.82];
}

/**
 * Cromo: refleja un entorno con cielo claro arriba, suelo oscuro abajo y un horizonte nítido.
 * Cualquier cambio brusco de normal corta ese horizonte en el modelo.
 */
function chrome(_nx: number, ny: number, nz: number): [number, number, number] {
  // Reflejo de la dirección de vista (0,0,1) sobre la normal.
  const ry = 2 * nz * ny;
  const rz = 2 * nz * nz - 1;
  // Horizonte un poco por debajo de la vista: una cara de frente refleja cielo, no la banda.
  const elev = Math.asin(Math.max(-1, Math.min(1, ry))) + 0.35;
  const sky = 0.55 + 0.45 * Math.pow(Math.min(1, Math.max(0, elev) / 1.2), 0.6);
  const ground = 0.05 + 0.18 * Math.min(1, Math.max(0, -elev) / 1.2);
  // Transición corta (no un escalón, que se vería dentado) y una banda oscura en el horizonte.
  let v = ground + (sky - ground) * smoothstep(-0.05, 0.05, elev);
  v -= 0.3 * Math.exp(-Math.pow(elev / 0.07, 2));
  v += 0.5 * Math.pow(Math.max(0, ry * 0.8 + rz * 0.2), 60);
  return [v * 0.95, v * 0.98, v * 1.02];
}

function smoothstep(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function dot3(ax: number, ay: number, az: number, bx: number, by: number, bz: number) {
  const l = Math.hypot(bx, by, bz);
  return (ax * bx + ay * by + az * bz) / l;
}

let textures: Partial<Record<'clay' | 'chrome', THREE.DataTexture>> = {};

function matcapTexture(kind: 'clay' | 'chrome') {
  let t = textures[kind];
  if (!t) {
    const size = 512;
    t = new THREE.DataTexture(matcapPixels(kind, size), size, size, THREE.RGBAFormat);
    t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    textures[kind] = t;
  }
  return t;
}

export function disposeShadingTextures() {
  for (const t of Object.values(textures)) t?.dispose();
  textures = {};
}

/** Las caras empujadas hacia atrás para que las aristas se vean nítidas encima. */
const OFFSET = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide } as const;

/** Franjas de cebra en el espacio de la cámara, según la elevación del reflejo. */
const ZEBRA_VERTEX = /* glsl */ `
  varying vec3 vNormalV;
  varying vec3 vViewDir;
  varying vec3 vTint;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormalV = normalize(normalMatrix * normal);
    vViewDir = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(-mv.xyz);
    vTint = color;
    gl_Position = projectionMatrix * mv;
  }
`;
const ZEBRA_FRAGMENT = /* glsl */ `
  uniform float uStripes;
  varying vec3 vNormalV;
  varying vec3 vViewDir;
  varying vec3 vTint;
  void main() {
    vec3 n = normalize(vNormalV);
    if (!gl_FrontFacing) n = -n;
    vec3 r = reflect(-normalize(vViewDir), n);
    float t = asin(clamp(r.y, -1.0, 1.0)) / 3.14159265 * uStripes;
    float w = max(fwidth(t), 1e-4);
    float d = abs(fract(t) - 0.5);
    float s = smoothstep(0.25 - w, 0.25 + w, d);
    // Valores lineales: la salida los pasa a sRGB (0.003 queda casi negro, 0.9 casi blanco).
    vec3 c = mix(vec3(0.003), vec3(0.9), s) * vTint;
    gl_FragColor = vec4(c, 1.0);
    #include <colorspace_fragment>
  }
`;

/** Normales en coordenadas del mundo como color; la cara trasera (normal invertida) en rojo. */
const NORMALS_VERTEX = /* glsl */ `
  varying vec3 vNormalW;
  varying vec3 vTint;
  void main() {
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vTint = color;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const NORMALS_FRAGMENT = /* glsl */ `
  varying vec3 vNormalW;
  varying vec3 vTint;
  void main() {
    vec3 c = gl_FrontFacing ? normalize(vNormalW) * 0.5 + 0.5 : vec3(0.85, 0.08, 0.08);
    // Se muestra el valor crudo n·0.5+0.5: se pasa a lineal porque la salida lo convierte a sRGB.
    gl_FragColor = vec4(pow(c, vec3(2.2)) * vTint, 1.0);
    #include <colorspace_fragment>
  }
`;

/** Material de caras para un modo. Usa el color por vértice (resaltado de selección y hover). */
export function createFaceMaterial(mode: ShadingMode): THREE.Material {
  switch (mode) {
    case 'clay':
    case 'chrome':
      return new THREE.MeshMatcapMaterial({ matcap: matcapTexture(mode), vertexColors: true, ...OFFSET });
    case 'zebra':
      return new THREE.ShaderMaterial({
        vertexShader: ZEBRA_VERTEX,
        fragmentShader: ZEBRA_FRAGMENT,
        uniforms: { uStripes: { value: 14 } },
        vertexColors: true,
        ...OFFSET,
      });
    case 'normals':
      return new THREE.ShaderMaterial({ vertexShader: NORMALS_VERTEX, fragmentShader: NORMALS_FRAGMENT, vertexColors: true, ...OFFSET });
    default:
      return new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.05, roughness: 0.65, ...OFFSET });
  }
}

/**
 * Color por vértice de una cara sin resaltar. En los modos de análisis es blanco (no altera el
 * matcap ni las franjas); la selección y el hover tiñen encima.
 */
export function baseFaceColor(mode: ShadingMode): THREE.Color {
  return mode === 'standard' ? new THREE.Color(0xb8c4d0) : new THREE.Color(0xffffff);
}

/** Tinte de resaltado: en modos de análisis se mezcla con blanco para no tapar el patrón. */
export function highlightColor(mode: ShadingMode, color: THREE.Color): THREE.Color {
  return mode === 'standard' ? color : new THREE.Color(1, 1, 1).lerp(color, 0.65);
}
