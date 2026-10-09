// Ubicación de los manipuladores 3D de cada feature (asas para arrastrar parámetros).
import { holeCenters } from '../document/holes';
import type { PlaneFrame } from '../document/planes';
import { dot, normalize, sub, toWorld, type Vec3 } from '../document/planes';
import type { Feature, FeatureId } from '../document/types';
import { revolveAxis } from './features/revolve';
import type { EvaluatedSketch } from './features/sketch';
import { edgeAdjacency, resolveEdge, resolveFace, type NamedShape } from './naming';
import type { Manipulator } from './protocol';

interface Ctx {
  input: NamedShape | null;
  sketches: Map<FeatureId, EvaluatedSketch>;
  planes?: Map<FeatureId, PlaneFrame>;
}

export function manipulatorFor(feature: Feature, ctx: Ctx): Manipulator | Manipulator[] | null {
  try {
    switch (feature.type) {
      case 'extrude': {
        const s = ctx.sketches.get(feature.sketch);
        if (!s || s.regions.length === 0) return null;
        const n = s.frame.normal;
        const sym = feature.direction === 'symmetric';
        return {
          kind: 'linear', featureId: feature.id, param: 'distance', label: 'Distancia',
          origin: profileCentroid(s),
          dir: feature.direction === 'reversed' ? scale(n, -1) : n,
          // En simétrica la extrusión va de -d/2 a +d/2: el asa queda en la cara final.
          factor: sym ? 0.5 : 1,
          value: feature.distance,
          min: 0.01,
        };
      }
      case 'revolve': {
        const s = ctx.sketches.get(feature.sketch);
        if (!s || s.regions.length === 0) return null;
        const [p0, d0] = revolveAxis(feature, s);
        const axis = normalize(d0);
        const c = profileCentroid(s);
        // Punto del eje más cercano al centro del perfil.
        const center = add(p0, scale(axis, dot(sub(c, p0), axis)));
        const radial = sub(c, center);
        const radius = Math.hypot(...radial);
        if (radius < 1e-6) return null;
        return {
          kind: 'angular', featureId: feature.id, param: 'angle', label: 'Ángulo',
          center, axis, startDir: normalize(radial), radius, value: feature.angle,
          axisLength: Math.max(sketchSize(s), radius) * 2.5,
        };
      }
      case 'fillet':
      case 'chamfer': {
        const input = ctx.input;
        if (!input || feature.edges.length === 0) return null;
        const ei = resolveEdge(input, feature.edges[0]);
        const { table, adjacent } = edgeAdjacency(input);
        const mid = table.items[ei].pointAt(0.5);
        const faces = input.shape.faces;
        const normals = adjacent[ei].map((fi) => unit(faces[fi].normalAt(mid).toTuple()));
        if (normals.length !== 2) return null;
        // Hacia adentro del material: opuesto a la bisectriz de las normales exteriores.
        const inward = normalize(scale(add(normals[0], normals[1]), -1));
        const isFillet = feature.type === 'fillet';
        return {
          kind: 'linear', featureId: feature.id,
          param: isFillet ? 'radius' : 'distance', label: isFillet ? 'Radio' : 'Distancia',
          origin: mid.toTuple(), dir: inward, factor: 1,
          value: isFillet ? feature.radius : feature.distance, min: 0.01,
        };
      }
      case 'shell': {
        const input = ctx.input;
        if (!input || feature.faces.length === 0) return null;
        const face = input.shape.faces[resolveFace(input, feature.faces[0])];
        // En caras curvas, un punto sobre la superficie (el centro de masa puede caer en el eje).
        const c = face.geomType === 'PLANE' ? face.center : face.pointOnSurface(0.5, 0.5);
        const n = unit(face.normalAt(c).toTuple());
        return {
          kind: 'linear', featureId: feature.id, param: 'thickness', label: 'Espesor',
          origin: c.toTuple(), dir: scale(n, -1), factor: 1, value: feature.thickness, min: 0.01,
        };
      }
      case 'pushpull': {
        // Asa sobre la cara (en el sólido antes de empujar/tirar), a lo largo de su normal.
        const input = ctx.input;
        if (!input || feature.faces.length === 0) return null;
        const face = input.shape.faces[resolveFace(input, feature.faces[0])];
        const c = face.center;
        return {
          kind: 'linear', featureId: feature.id, param: 'distance', label: 'Distancia',
          origin: c.toTuple(), dir: unit(face.normalAt(c).toTuple()), factor: 1, value: feature.distance, min: -1e6,
        };
      }
      case 'plane': {
        const f = ctx.planes?.get(feature.id);
        if (!f) return null;
        // El asa sale del plano sin desplazar y mide la distancia sobre su normal.
        return {
          kind: 'linear', featureId: feature.id, param: 'distance', label: 'Distancia',
          origin: [0, 1, 2].map((i) => f.origin[i] - f.normal[i] * feature.distance) as [number, number, number],
          dir: f.normal, factor: 1, value: feature.distance, min: -1e6,
        };
      }
      case 'hole': {
        // Asa de profundidad en el primer centro, hacia adentro del material.
        const s = ctx.sketches.get(feature.sketch);
        const c = s ? holeCenters(s.data)[0] : undefined;
        if (!s || !c || feature.extent !== 'distance') return null;
        const n = s.frame.normal;
        return {
          kind: 'linear', featureId: feature.id, param: 'depth', label: 'Profundidad',
          origin: toWorld(s.frame, c.pos[0], c.pos[1]), dir: feature.reversed ? n : scale(n, -1), factor: 1,
          value: feature.depth, min: 0.01,
        };
      }
      case 'move': {
        // Flechas X/Y/Z desde el centro de los cuerpos que se mueven, y un aro para el giro.
        const input = ctx.input;
        if (!input) return null;
        const faces = input.shape.faces;
        const solids = input.shape.solids;
        const chosen = feature.bodies.length
          ? solids.filter((sol) => feature.bodies.some((ref) => {
            const f = faces[resolveFace(input, ref)];
            return sol.faces.some((x) => x.wrapped.IsSame(f.wrapped));
          }))
          : solids;
        if (!chosen.length) return null;
        let lo = [Infinity, Infinity, Infinity];
        let hi = [-Infinity, -Infinity, -Infinity];
        for (const sol of chosen) {
          const [a, b] = sol.boundingBox.bounds;
          lo = lo.map((v, i) => Math.min(v, a[i]));
          hi = hi.map((v, i) => Math.max(v, b[i]));
        }
        const center = lo.map((v, i) => (v + hi[i]) / 2) as Vec3;
        const size = Math.max(1, ...hi.map((v, i) => v - lo[i]));
        const axes: [string, Vec3, number][] = [['dx', [1, 0, 0], 0xe05050], ['dy', [0, 1, 0], 0x50c060], ['dz', [0, 0, 1], 0x5090ff]];
        const out: Manipulator[] = axes.map(([param, dir, color]) => ({
          kind: 'linear', featureId: feature.id, param, label: param.toUpperCase().replace('D', 'Δ'),
          origin: center, dir, factor: 1, value: feature[param as 'dx' | 'dy' | 'dz'], min: -1e6, color, offset: size * 0.6,
        }));
        // Giro alrededor del eje global por el origen: el aro pasa por el centro de los cuerpos.
        const axis: Vec3 = feature.axis === 'X' ? [1, 0, 0] : feature.axis === 'Y' ? [0, 1, 0] : [0, 0, 1];
        const along = dot(center, axis);
        const hub = scale(axis, along);
        let radial = sub(center, hub);
        let radius = Math.hypot(...radial);
        if (radius < size * 0.1) {
          // Cuerpo sobre el eje: un aro de tamaño visible igual.
          radial = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
          radius = size * 0.75;
        }
        out.push({
          kind: 'angular', featureId: feature.id, param: 'angle', label: `Giro ${feature.axis}`,
          center: hub, axis, startDir: normalize(radial), radius, value: feature.angle,
          axisLength: size * 2, min: 0, color: 0xc070ff,
        });
        return out;
      }
      case 'dome': {
        // Asa en el centro de la cara, sobre su normal: la altura del abombado.
        const input = ctx.input;
        if (!input) return null;
        const face = input.shape.faces[resolveFace(input, feature.face)];
        const c = face.center;
        return {
          kind: 'linear', featureId: feature.id, param: 'height', label: 'Altura',
          origin: c.toTuple(), dir: unit(face.normalAt(c).toTuple()), factor: 1, value: feature.height, min: -1e6,
        };
      }
      case 'patch':
      case 'curve3d':
      case 'thread':
      case 'draft':
      case 'combine':
      case 'split':
      case 'import':
      case 'sketch':
      case 'pattern':
      case 'mirror':
      case 'sweep':
      case 'loft':
        return null;
    }
  } catch {
    // Referencia perdida u otro error: la feature ya muestra su error en el historial.
    return null;
  }
}

/** Centro de las regiones del sketch (promedio ponderado por área), en 3D. */
function profileCentroid(s: EvaluatedSketch): Vec3 {
  let ax = 0, ay = 0, at = 0;
  for (const r of s.regions) {
    const poly = r.outer.polygon;
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < poly.length; i++) {
      const [x0, y0] = poly[i];
      const [x1, y1] = poly[(i + 1) % poly.length];
      const k = x0 * y1 - x1 * y0;
      a += k;
      cx += (x0 + x1) * k;
      cy += (y0 + y1) * k;
    }
    a /= 2;
    if (Math.abs(a) < 1e-12) continue;
    ax += (cx / (6 * a)) * Math.abs(a);
    ay += (cy / (6 * a)) * Math.abs(a);
    at += Math.abs(a);
  }
  return at > 0 ? toWorld(s.frame, ax / at, ay / at) : s.frame.origin;
}

function sketchSize(s: EvaluatedSketch): number {
  let m = 0;
  for (const r of s.regions) for (const [x, y] of r.outer.polygon) m = Math.max(m, Math.hypot(x, y));
  return m;
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
function unit(v: number[]): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
