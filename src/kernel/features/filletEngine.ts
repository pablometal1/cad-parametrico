// Motor multi-etapa de redondeo y chaflán para aristas arbitrarias.
//
// Cascada de resolución cuando el constructor directo de OpenCascade falla:
// 1. Variantes de forma de ChFi3d (Rational, QuasiAngular, Polynomial) y radios por arista.
// 2. Propagación automática de cadenas tangentes G1 (aristas conectadas con transición suave < 6°).
// 3. Unificación previa de caras coplanares / mismo dominio (ShapeUpgrade_UnifySameDomain) para
//    eliminar aristas residuales de booleanas o particiones que bloquean la bola rodante.
// 4. Descomposición secuencial multi-pasada (convexas → cóncavas, cóncavas → convexas, por cadenas
//    conectadas y arista por arista) re-resolviendo topológica y geométricamente en cada paso.
// 5. Cuña geométrica barrida (rolling-ball swept wedge con ThruSections + Cut/Fuse) para bordes
//    NURBS / solevaciones / parches abombados.
// 6. Ajuste adaptativo inteligente de radio (por arista y grupal) cuando el radio pedido supera el
//    ancho de una cara vecina (p. ej. 8.9 mm en cara de 4 mm) o el espesor total de la pieza.
import { assembleWire, cast, getOC, makeLine, makeThreePointArc, type AnyShape, type Edge, type Face, type Wire } from 'replicad';
import { add, cross, dist3, dot, normalize, scale, sub, type Vec3 } from '../../document/planes';
import type { EdgeRef } from '../../document/types';
import {
  EDGE_NORMAL, edgeAdjacency, edgeKinds, edgeNames, edgeRefOf, historyOf, NameBuilder, resolveEdge, ShapeTable,
  type NamedShape,
} from '../naming';
import { isValidShape } from '../occtUtils';
import { volume } from './measure';

type Deletable = { delete(): void };

/** Con más caras que esto no se intenta unificar antes de redondear (mallas importadas). */
const UNIFY_MAX_FACES = 600;

/**
 * Lo que ya se sabe de un grupo de aristas de un sólido: hasta qué medida entra y desde cuál no.
 * Al arrastrar el manejador el sólido de entrada y las aristas son los mismos en cada paso, así
 * que la búsqueda del máximo se hace una sola vez y los pasos siguientes no repiten construcciones
 * de OCCT que ya se sabe cómo terminan. (Supone que si una medida entra, las menores también.)
 */
interface FitMemo {
  /** Mayor medida que se comprobó que entra. */
  works: number;
  /** Menor medida que se comprobó que no entra. */
  fails: number;
  /** Menor medida con la que falló el constructor directo (con todas sus variantes y cadenas). */
  directFails: number;
  /** Unificar caras no ayudó con estas aristas. */
  unifyUseless: boolean;
}

const fitMemos = new WeakMap<NamedShape, Map<string, FitMemo>>();

function memoFor(input: NamedShape, indices: number[], isFillet: boolean): FitMemo {
  let byKey = fitMemos.get(input);
  if (!byKey) fitMemos.set(input, (byKey = new Map()));
  const key = `${isFillet ? 'f' : 'c'}|${indices.slice().sort((a, b) => a - b).join(',')}`;
  let m = byKey.get(key);
  if (!m) byKey.set(key, (m = { works: 0, fails: Infinity, directFails: Infinity, unifyUseless: false }));
  return m;
}

/**
 * Qué se aplicó cuando la medida pedida no entraba (para avisarlo en el historial):
 * - 'local': radio reducido solo en los tramos angostos de cada arista; el resto conserva el pedido.
 * - 'edges': radio reducido en las aristas enteras donde no entraba.
 * - 'all': una misma medida menor para toda la selección.
 */
export interface EdgeFeatureReport {
  kind?: 'local' | 'edges' | 'all';
  /** Menor medida aplicada (mm). */
  min?: number;
}

export interface EdgeFeatureSpec {
  featureId: string;
  isFillet: boolean;
  size: number;
  size2?: number;
  variable: boolean;
  /** Si se pasa, el motor anota acá cuando aplicó una medida menor que la pedida. */
  report?: EdgeFeatureReport;
}

/** Objetivo de redondeo/chaflán para una arista, con huella geométrica para re-ubicarla tras pasos intermedios. */
interface EdgeTarget {
  index: number;
  ref: EdgeRef;
  originalName: string;
  samples: Vec3[];
  midTangent: Vec3;
  /** -1 = convexa (quita material), +1 = cóncava (agrega material), 0 = indeterminada. */
  convexity: -1 | 0 | 1;
  radius: number;
}

/**
 * Ejecuta el motor completo de redondeo/chaflán sobre `indices` en `input`.
 * Devuelve el nuevo `NamedShape` si alguna etapa tiene éxito, o `null` si ninguna medida entra.
 */
export function executeFilletEngine(
  input: NamedShape,
  indices: number[],
  spec: EdgeFeatureSpec,
  allowAdaptive = true,
): NamedShape | null {
  try {
    const { names } = edgeNames(input);
    const targetNames = indices.map((i) => names[i]);
    const radii = indices.map(() => spec.size);
    const memo = memoFor(input, indices, spec.isFillet);

    // Las etapas 1 y 2 se saltean si ya fallaron con una medida igual o menor (arrastre del manejador).
    if (spec.variable || spec.size < memo.directFails) {
      // Etapa 1: Intento directo con las 3 formas de superficie de ChFi3d (Rational, QuasiAngular, Polynomial).
      const direct = tryDirectEdgeFeature(input, indices, radii, spec, targetNames);
      if (direct) return direct;

      // Etapa 2: Propagación automática de cadenas tangentes G1.
      const expanded = expandTangentChains(input, indices, targetNames);
      if (expanded.indices.length > indices.length) {
        const expRadii = expanded.indices.map(() => spec.size);
        const g1Result = tryDirectEdgeFeature(input, expanded.indices, expRadii, spec, expanded.names);
        if (g1Result) return g1Result;
      }
      if (!spec.variable) memo.directFails = Math.min(memo.directFails, spec.size);
    }

    // Etapa 3: Limpieza: unificación de caras del mismo dominio (coplanares / cilíndricas partidas por
    // booleanas o curvas). Va ANTES de reducir el radio: si alcanza con limpiar, se conserva la medida
    // pedida. En piezas enormes (mallas importadas) se saltea: unificar miles de caras es lento.
    if (!spec.variable && !memo.unifyUseless && input.shape.faces.length <= UNIFY_MAX_FACES) {
      const unified = unifySameDomainNamed(input);
      // Si no hay nada que unificar, no lo habrá en el próximo paso del arrastre tampoco.
      if (!unified) memo.unifyUseless = true;
      if (unified) {
        try {
          const mapped = mapEdgesToUnified(input, indices, names, unified);
          if (mapped && mapped.indices.length > 0) {
            const uniRadii = mapped.indices.map(() => spec.size);
            const uDirect = tryDirectEdgeFeature(unified, mapped.indices, uniRadii, spec, mapped.names);
            if (uDirect) return uDirect;

            const uExpanded = expandTangentChains(unified, mapped.indices, mapped.names);
            if (uExpanded.indices.length > mapped.indices.length) {
              const uExpRadii = uExpanded.indices.map(() => spec.size);
              const uG1 = tryDirectEdgeFeature(unified, uExpanded.indices, uExpRadii, spec, uExpanded.names);
              if (uG1) return uG1;
            }
          }
        } finally {
          unified.shape.delete();
        }
      }
    }

    // Etapa 6: la medida pedida no entra ni limpiando. Primero se reduce el radio solo en los tramos
    // angostos de cada arista; si no alcanza, por arista entera o toda la selección. Todo queda
    // anotado en `spec.report` para avisarlo.
    if (allowAdaptive && !spec.variable) {
      if (spec.isFillet) {
        const local = tryLocalRadiusLaw(input, indices, names, spec);
        if (local) return local;
      }
      const adaptive = tryAdaptiveClamping(input, indices, names, spec);
      if (adaptive) return adaptive;
    }

    // Etapa 4: Descomposición secuencial multi-pasada (cuando hay varias aristas seleccionadas).
    if (indices.length > 1 && !spec.variable) {
      const targets = buildEdgeTargets(input, indices, names, radii);
      const seq = trySequentialPasses(input, targets, spec);
      if (seq) return seq;
    }

    // Etapa 5: Cuña geométrica barrida acotada a las caras para superficies NURBS / complejos.
    if (!spec.variable) {
      const targets = buildEdgeTargets(input, indices, names, radii);
      const swept = trySweptWedgeSequence(input, targets, spec);
      if (swept) return swept;
    }

    // Pedido apenas por encima del máximo y ninguna etapa lo resolvió: reducir igual (y avisar).
    if (allowAdaptive && !spec.variable) {
      const forced = tryAdaptiveClamping(input, indices, names, spec, true);
      if (forced) return forced;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Prueba ultrarrápida, de bajo consumo de memoria y libre de fugas para saber si `size` entra en `indices`.
 * Se usa en la bisección de `largestThatWorks` y en el ajuste adaptativo.
 */
export function engineEdgeFeatureWorks(input: NamedShape, indices: number[], isFillet: boolean, size: number): boolean {
  if (!(size > 0)) return false;
  const memo = memoFor(input, indices, isFillet);
  if (size <= memo.works) return true;
  if (size >= memo.fails) return false;
  const ok = probeEdgeFeature(input, indices, isFillet, size);
  if (ok) memo.works = Math.max(memo.works, size);
  else memo.fails = Math.min(memo.fails, size);
  return ok;
}

function probeEdgeFeature(input: NamedShape, indices: number[], isFillet: boolean, size: number): boolean {
  if (directFastProbe(input, indices, isFillet, size)) return true;

  // Si falló directo, probar con propagación de aristas tangentes G1:
  try {
    const exp = expandTangentChains(input, indices);
    if (exp.indices.length > indices.length) {
      if (directFastProbe(input, exp.indices, isFillet, size)) return true;
    }
  } catch {
    // Ignorar si expandTangentChains falla
  }

  // Si es una sola arista sobre una superficie curva compleja (abombado/loft), probar cuña barrida:
  if (indices.length === 1 && isFillet) {
    try {
      const spec: EdgeFeatureSpec = { featureId: 'probe', isFillet: true, size, variable: false };
      const swept = sweepFilletSingleEdge(input, indices[0], size, spec, 'probe');
      if (swept) {
        swept.shape.delete();
        return true;
      }
    } catch {
      return false;
    }
  }

  return false;
}

function directFastProbe(input: NamedShape, indices: number[], isFillet: boolean, size: number): boolean {
  try {
    const oc = getOC();
    const table = ShapeTable.edges(input.shape);
    const builder = isFillet
      ? new oc.BRepFilletAPI_MakeFillet(input.shape.wrapped)
      : new oc.BRepFilletAPI_MakeChamfer(input.shape.wrapped);
    const range = new oc.Message_ProgressRange();
    try {
      for (const i of indices) {
        if (!table.items[i]) return false;
        builder.Add(size, table.items[i].wrapped);
      }
      builder.Build(range);
      if (!builder.IsDone()) return false;
      const res = cast(builder.Shape());
      const ok = isValidShape(res);
      res.delete();
      return ok;
    } finally {
      builder.delete();
      range.delete();
    }
  } catch {
    return false;
  }
}

// ============================================================================
// Etapa 1: Constructor directo ChFi3d con variantes de forma y radios por arista
// ============================================================================

function tryDirectEdgeFeature(
  base: NamedShape,
  indices: number[],
  radii: number[],
  spec: EdgeFeatureSpec,
  customEdgeNames?: string[],
): NamedShape | null {
  const oc = getOC();
  const shapes = spec.isFillet
    ? [
        oc.ChFi3d_FilletShape.ChFi3d_Rational,
        oc.ChFi3d_FilletShape.ChFi3d_QuasiAngular,
        oc.ChFi3d_FilletShape.ChFi3d_Polynomial,
      ]
    : [null];

  const maxR = Math.max(...radii, spec.size2 ?? 0);
  for (const filletShape of shapes) {
    const res = runSingleBuilder(base, indices, radii, spec, filletShape, maxR, customEdgeNames);
    if (res) return res;
  }
  return null;
}

function runSingleBuilder(
  base: NamedShape,
  indices: number[],
  radii: number[],
  spec: EdgeFeatureSpec,
  filletShape: unknown,
  maxR: number,
  customEdgeNames?: string[],
): NamedShape | null {
  const oc = getOC();
  const table = ShapeTable.edges(base.shape);
  const builder = spec.isFillet
    ? new oc.BRepFilletAPI_MakeFillet(
        base.shape.wrapped,
        (filletShape ?? oc.ChFi3d_FilletShape.ChFi3d_Rational) as (typeof oc.ChFi3d_FilletShape)[keyof typeof oc.ChFi3d_FilletShape],
      )
    : new oc.BRepFilletAPI_MakeChamfer(base.shape.wrapped);
  const range = new oc.Message_ProgressRange();
  try {
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      const r = radii[k] ?? spec.size;
      const edge = oc.TopoDS.Edge(table.items[i].wrapped);
      if (spec.variable && spec.size2 !== undefined) {
        (builder as InstanceType<typeof oc.BRepFilletAPI_MakeFillet>).Add(r, spec.size2, edge);
      } else {
        builder.Add(r, edge);
      }
    }
    builder.Build(range);
    if (!builder.IsDone()) return null;
    const result = cast(builder.Shape());
    if (!plausibleFilletResult(result, base.shape, maxR)) {
      result.delete();
      return null;
    }
    const history = historyOf(builder);
    const nb = new NameBuilder(result);
    nb.carry(base, history);
    const fallbackNames = customEdgeNames ? null : edgeNames(base).names;
    const kind = spec.isFillet ? 'fillet' : 'chamfer';
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      const eName = customEdgeNames?.[k] ?? fallbackNames![i];
      nb.generated(history, table.items[i].wrapped, `${spec.featureId}:${kind}:${eName}`);
    }
    return nb.finish(spec.featureId);
  } catch {
    return null;
  } finally {
    builder.delete();
    range.delete();
  }
}

function plausibleFilletResult(result: AnyShape, original: AnyShape, maxR: number): boolean {
  if (result.solids.length === 0 || !isValidShape(result)) return false;
  const vr = volume(result);
  if (!(vr > 0)) return false;
  const [a0, a1] = result.boundingBox.bounds;
  const [b0, b1] = original.boundingBox.bounds;
  const tol = Math.max(1e-2, maxR * 0.25);
  return [0, 1, 2].every((i) => a0[i] >= b0[i] - tol && a1[i] <= b1[i] + tol);
}

// ============================================================================
// Etapa 2: Propagación automática de cadenas de aristas tangentes (G1)
// ============================================================================

/** Coseno de 6°: umbral para considerar que dos aristas continúan con tangencia G1 en un vértice. */
const G1_CHAIN_COS = Math.cos((6 * Math.PI) / 180);

interface EdgeEndInfo {
  p0: Vec3;
  p1: Vec3;
  /** Tangente unitaria apuntando hacia afuera de la arista en p0 (t=0). */
  out0: Vec3;
  /** Tangente unitaria apuntando hacia afuera de la arista en p1 (t=1). */
  out1: Vec3;
}

function expandTangentChains(
  base: NamedShape,
  indices: number[],
  initialNames?: string[],
): { indices: number[]; names: string[] } {
  const { table, adjacent } = edgeAdjacency(base);
  const allNames = edgeNames(base).names;
  const kinds = edgeKinds(base);
  const nEdges = table.items.length;

  const ends: (EdgeEndInfo | null)[] = table.items.map((e, i) => {
    if (kinds[i] !== EDGE_NORMAL) return null;
    try {
      const p0 = e.pointAt(0).toTuple() as Vec3;
      const p1 = e.pointAt(1).toTuple() as Vec3;
      if (dist3(p0, p1) < 1e-6) return null; // arista cerrada sobre sí misma
      const t0 = normalize(e.tangentAt(0).toTuple() as Vec3);
      const t1 = normalize(e.tangentAt(1).toTuple() as Vec3);
      return { p0, p1, out0: scale(t0, -1), out1: t1 };
    } catch {
      return null;
    }
  });

  const selected = new Set<number>(indices);
  const outIndices = indices.slice();
  const outNames = initialNames ? initialNames.slice() : indices.map((i) => allNames[i]);
  const queue = indices.slice();

  while (queue.length > 0) {
    const curr = queue.shift()!;
    const infoA = ends[curr];
    if (!infoA) continue;

    for (const [ptA, outA] of [
      [infoA.p0, infoA.out0],
      [infoA.p1, infoA.out1],
    ] as const) {
      // Buscar aristas normales que se encuentren en `ptA` con tangente opuesta (continuación suave).
      for (let j = 0; j < nEdges; j++) {
        if (selected.has(j)) continue;
        const infoB = ends[j];
        if (!infoB) continue;
        let outB: Vec3 | null = null;
        if (dist3(ptA, infoB.p0) < 1e-4) outB = infoB.out0;
        else if (dist3(ptA, infoB.p1) < 1e-4) outB = infoB.out1;
        if (!outB) continue;

        // Para ser continuación G1, las tangentes salientes en el vértice compartido deben ser opuestas.
        if (dot(outA, outB) > -G1_CHAIN_COS) continue;

        // Además, las caras adyacentes en el vértice deben ser compatibles (compartir cara o normales suaves).
        if (!compatibleChainFaces(base, adjacent[curr], adjacent[j], ptA)) continue;

        selected.add(j);
        outIndices.push(j);
        outNames.push(allNames[j]);
        queue.push(j);
      }
    }
  }

  return { indices: outIndices, names: outNames };
}

function compatibleChainFaces(base: NamedShape, adjA: number[], adjB: number[], vertexPt: Vec3): boolean {
  if (adjA.length !== 2 || adjB.length !== 2) return false;
  if (adjA.some((fa) => adjB.includes(fa))) return true;
  const oc = getOC();
  const pv = new oc.gp_Pnt(vertexPt[0], vertexPt[1], vertexPt[2]);
  try {
    const faces = base.shape.faces;
    const normalsA = adjA.map((fi) => normalize(faces[fi].normalAt(pv).toTuple() as Vec3));
    const normalsB = adjB.map((fi) => normalize(faces[fi].normalAt(pv).toTuple() as Vec3));
    return normalsA.every((na) => normalsB.some((nb) => dot(na, nb) > G1_CHAIN_COS));
  } catch {
    return false;
  } finally {
    pv.delete();
  }
}

// ============================================================================
// Etapa 3: Unificación de caras coplanares / mismo dominio (UnifySameDomain)
// ============================================================================

function unifySameDomainNamed(input: NamedShape): NamedShape | null {
  const oc = getOC();
  const unify = new oc.ShapeUpgrade_UnifySameDomain(input.shape.wrapped, true, true, false);
  try {
    unify.Build();
    const unifiedShape = cast(unify.Shape());
    const inFaces = input.shape.faces;
    const inEdges = input.shape.edges;
    const outFaces = unifiedShape.faces;
    const outEdges = unifiedShape.edges;
    // Solo vale la pena si redujo caras o aristas y conserva un sólido válido.
    if (
      unifiedShape.solids.length !== input.shape.solids.length ||
      (outFaces.length >= inFaces.length && outEdges.length >= inEdges.length) ||
      !isValidShape(unifiedShape)
    ) {
      unifiedShape.delete();
      return null;
    }

    const nb = new NameBuilder(unifiedShape);
    // 1. Caras intactas por identidad topológica.
    const matchedInput = new Set<number>();
    inFaces.forEach((f, i) => {
      const idx = nb.table.indexOf(f.wrapped, f.hashCode);
      if (idx >= 0) {
        matchedInput.add(i);
        for (const n of input.names[i]) nb.add(f.wrapped, n);
      }
    });

    // 2. Caras fusionadas: asignar los nombres de cada cara original a la cara unificada que contiene su centro.
    inFaces.forEach((f, i) => {
      if (matchedInput.has(i)) return;
      const c = f.center.toTuple() as Vec3;
      const nIn = normalize(f.normalAt(f.center).toTuple() as Vec3);
      let bestIdx = -1;
      let bestDist = 1e-2;
      for (let u = 0; u < outFaces.length; u++) {
        const d = distPointToFace(c, outFaces[u]);
        if (d < bestDist) {
          const pv = new oc.gp_Pnt(c[0], c[1], c[2]);
          try {
            const nOut = normalize(outFaces[u].normalAt(pv).toTuple() as Vec3);
            if (Math.abs(dot(nIn, nOut)) > 0.98) {
              bestDist = d;
              bestIdx = u;
            }
          } catch {
            // Ignorar si normalAt falla en la cara candidata.
          } finally {
            pv.delete();
          }
        }
      }
      if (bestIdx >= 0) {
        for (const name of input.names[i]) {
          if (!nb.names[bestIdx].includes(name)) nb.names[bestIdx].push(name);
        }
      }
    });

    return nb.finish('unify');
  } catch {
    return null;
  } finally {
    unify.delete();
  }
}

function mapEdgesToUnified(
  input: NamedShape,
  indices: number[],
  names: string[],
  unified: NamedShape,
): { indices: number[]; names: string[] } | null {
  const inEdges = input.shape.edges;
  const uEdges = unified.shape.edges;
  const uKinds = edgeKinds(unified);
  const outIndices: number[] = [];
  const outNames: string[] = [];

  for (const i of indices) {
    const e = inEdges[i];
    if (!e) return null;
    const mid = e.pointAt(0.5).toTuple() as Vec3;
    const tan = normalize(e.tangentAt(0.5).toTuple() as Vec3);

    let best = -1;
    let bestD = 1e-2;
    for (let u = 0; u < uEdges.length; u++) {
      if (uKinds[u] !== EDGE_NORMAL) continue;
      const d = distPointToEdge(mid, uEdges[u]);
      if (d < bestD) {
        const uTan = edgeTangentNear(uEdges[u], mid);
        if (!uTan || Math.abs(dot(tan, uTan)) > 0.95) {
          bestD = d;
          best = u;
        }
      }
    }
    if (best < 0) return null;
    if (!outIndices.includes(best)) {
      outIndices.push(best);
      outNames.push(names[i]);
    }
  }
  return { indices: outIndices, names: outNames };
}

// ============================================================================
// Etapa 4: Descomposición secuencial multi-pasada
// ============================================================================

function buildEdgeTargets(
  input: NamedShape,
  indices: number[],
  names: string[],
  radii: number[],
): EdgeTarget[] {
  const { table, adjacent } = edgeAdjacency(input);
  return indices.map((index, k) => {
    const edge = table.items[index];
    const samples: Vec3[] = [0.2, 0.35, 0.5, 0.65, 0.8].map((t) => edge.pointAt(t).toTuple() as Vec3);
    let midTangent: Vec3 = [1, 0, 0];
    try {
      midTangent = normalize(edge.tangentAt(0.5).toTuple() as Vec3);
    } catch {
      midTangent = normalize(sub(edge.endPoint.toTuple() as Vec3, edge.startPoint.toTuple() as Vec3));
    }
    return {
      index,
      ref: edgeRefOf(input, index),
      originalName: names[index],
      samples,
      midTangent,
      convexity: classifyEdgeConvexity(input, edge, adjacent[index] ?? []),
      radius: radii[k] ?? radii[0],
    };
  });
}

function trySequentialPasses(
  input: NamedShape,
  targets: EdgeTarget[],
  spec: EdgeFeatureSpec,
): NamedShape | null {
  const convex = targets.filter((t) => t.convexity <= 0);
  const concave = targets.filter((t) => t.convexity > 0);

  // 4a. Si hay mezcla de aristas convexas y cóncavas, probar convexas primero y luego cóncavas (y viceversa).
  if (convex.length > 0 && concave.length > 0) {
    const r1 = runTargetPassSequence(input, [convex, concave], spec);
    if (r1) return r1;
    const r2 = runTargetPassSequence(input, [concave, convex], spec);
    if (r2) return r2;
  }

  // 4b. Agrupar por cadenas conectadas y aplicar cadena por cadena.
  const chains = groupTargetsByConnectivity(input, targets);
  if (chains.length > 1 && chains.length < targets.length) {
    const rChains = runTargetPassSequence(input, chains, spec);
    if (rChains) return rChains;
  }

  // 4c. Aplicar arista por arista secuencialmente (y en orden inverso si el directo falla).
  const singleGroups = targets.map((t) => [t]);
  const rSeq = runTargetPassSequence(input, singleGroups, spec);
  if (rSeq) return rSeq;

  if (targets.length <= 6) {
    const revGroups = singleGroups.slice().reverse();
    const rRev = runTargetPassSequence(input, revGroups, spec);
    if (rRev) return rRev;
  }

  return null;
}

function groupTargetsByConnectivity(input: NamedShape, targets: EdgeTarget[]): EdgeTarget[][] {
  const edges = input.shape.edges;
  const ends = targets.map((t) => {
    const e = edges[t.index];
    return [e.startPoint.toTuple() as Vec3, e.endPoint.toTuple() as Vec3];
  });
  const touch = (a: number, b: number) => ends[a].some((p) => ends[b].some((q) => dist3(p, q) < 1e-4));
  const parent = targets.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let a = 0; a < targets.length; a++) {
    for (let b = a + 1; b < targets.length; b++) {
      if (touch(a, b)) parent[find(a)] = find(b);
    }
  }
  const groups = new Map<number, EdgeTarget[]>();
  targets.forEach((t, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), t]);
  });
  return [...groups.values()];
}

/**
 * Ejecuta una lista de grupos de aristas en serie. Cada paso re-resuelve las aristas del grupo
 * sobre el `NamedShape` intermedio y propaga todos los nombres topológicos.
 */
function runTargetPassSequence(
  input: NamedShape,
  groups: EdgeTarget[][],
  spec: EdgeFeatureSpec,
): NamedShape | null {
  let current = input;
  const ownsCurrent = () => current !== input;

  for (const group of groups) {
    const resolvedIndices: number[] = [];
    const resolvedRadii: number[] = [];
    const resolvedNames: string[] = [];

    for (const target of group) {
      const matches = resolveTargetOnShape(current, target);
      if (matches.length === 0) {
        if (ownsCurrent()) current.shape.delete();
        return null;
      }
      for (const idx of matches) {
        if (!resolvedIndices.includes(idx)) {
          resolvedIndices.push(idx);
          resolvedRadii.push(target.radius);
          resolvedNames.push(target.originalName);
        }
      }
    }

    // Intentar directo sobre el grupo; si no, con propagación G1; si es una sola arista, también con cuña barrida.
    let next = tryDirectEdgeFeature(current, resolvedIndices, resolvedRadii, spec, resolvedNames);
    if (!next) {
      const exp = expandTangentChains(current, resolvedIndices, resolvedNames);
      if (exp.indices.length > resolvedIndices.length) {
        const expRadii = exp.indices.map((_, k) => resolvedRadii[Math.min(k, resolvedRadii.length - 1)]);
        next = tryDirectEdgeFeature(current, exp.indices, expRadii, spec, exp.names);
      }
    }
    if (!next && resolvedIndices.length === 1) {
      next = sweepFilletSingleEdge(current, resolvedIndices[0], resolvedRadii[0], spec, resolvedNames[0]);
    }

    if (!next) {
      if (ownsCurrent()) current.shape.delete();
      return null;
    }
    if (ownsCurrent()) current.shape.delete();
    current = next;
  }

  return current;
}

/**
 * Re-ubica una arista objetivo en un `NamedShape` intermedio (después de haber redondeado otras aristas).
 * Primero intenta por nombre topológico (`resolveEdge`), verificando que siga cerca de las muestras;
 * si la arista fue recortada en un extremo o cambió el nombre de una cara vecina, busca por proximidad
 * geométrica a los puntos de muestra y paralelismo de tangente.
 */
function resolveTargetOnShape(current: NamedShape, target: EdgeTarget): number[] {
  const edges = current.shape.edges;
  const kinds = edgeKinds(current);

  try {
    const byName = resolveEdge(current, target.ref);
    if (kinds[byName] === EDGE_NORMAL) {
      const mid = edges[byName].pointAt(0.5).toTuple() as Vec3;
      if (target.samples.some((s) => distPointToEdge(s, edges[byName]) < Math.max(0.5, target.radius * 1.5)) || dist3(mid, target.ref.center) < Math.max(1, target.radius * 2)) {
        return [byName];
      }
    }
  } catch {
    // Si cambió el nombre de una cara vecina tras el paso previo, seguimos con búsqueda geométrica.
  }

  const matches: number[] = [];
  for (let i = 0; i < edges.length; i++) {
    if (kinds[i] !== EDGE_NORMAL) continue;
    const hitSamples = target.samples.filter((s) => distPointToEdge(s, edges[i]) < 1e-2);
    if (hitSamples.length === 0) continue;
    const tan = edgeTangentNear(edges[i], hitSamples[0]);
    if (tan && Math.abs(dot(tan, target.midTangent)) > 0.92) {
      matches.push(i);
    }
  }
  return matches;
}

// ============================================================================
// Etapa 5a: Cuña geométrica barrida acotada a las caras (Rolling-Ball Swept Wedge)
// ============================================================================

function trySweptWedgeSequence(
  input: NamedShape,
  targets: EdgeTarget[],
  spec: EdgeFeatureSpec,
): NamedShape | null {
  let current = input;
  const ownsCurrent = () => current !== input;

  for (const target of targets) {
    const matches = resolveTargetOnShape(current, target);
    if (matches.length === 0) {
      if (ownsCurrent()) current.shape.delete();
      return null;
    }
    for (const edgeIdx of matches) {
      const next =
        tryDirectEdgeFeature(current, [edgeIdx], [target.radius], spec, [target.originalName]) ??
        sweepFilletSingleEdge(current, edgeIdx, target.radius, spec, target.originalName);
      if (!next) {
        if (ownsCurrent()) current.shape.delete();
        return null;
      }
      if (ownsCurrent()) current.shape.delete();
      current = next;
    }
  }
  return current;
}

interface WedgeStation {
  pCorner: Vec3;
  pExt: Vec3;
  aContact: Vec3;
  bContact: Vec3;
  arcMid: Vec3;
}

/**
 * Construye el redondeo o chaflán de una arista mediante barrido geométrico de una cuña de bola
 * rodante (`BRepOffsetAPI_ThruSections`) seguido de corte booleano (arista convexa) o unión
 * booleana (arista cóncava).
 * Valida estrictamente que el radio quepa dentro del ancho de ambas caras vecinas y del espesor
 * del sólido antes de construir la cuña.
 */
export function sweepFilletSingleEdge(
  base: NamedShape,
  edgeIdx: number,
  radius: number,
  spec: EdgeFeatureSpec,
  edgeName: string,
): NamedShape | null {
  const { table, adjacent } = edgeAdjacency(base);
  const adj = adjacent[edgeIdx];
  if (!adj || adj.length !== 2) return null;

  const edge = table.items[edgeIdx];
  const f1 = base.shape.faces[adj[0]];
  const f2 = base.shape.faces[adj[1]];
  const len = edge.length;
  if (!(len > 1e-4) || !(radius > 0)) return null;

  const convexity = classifyEdgeConvexity(base, edge, adj);
  if (convexity === 0) return null;

  // Verificar que el radio quepa geométricamente dentro de ambas caras y no atraviese una pared fina.
  const numStations = edge.geomType === 'LINE' ? 4 : 12;
  const stations: WedgeStation[] = [];

  for (let k = 0; k <= numStations; k++) {
    const t = k / numStations;
    const st = computeWedgeStation(base, edge, f1, f2, t, radius, convexity, k === 0 || k === numStations);
    if (!st) return null;
    stations.push(st);
  }

  // Extender levemente los dos extremos de la cuña a lo largo de la arista (si es abierta y convexa)
  // para que la operación booleana corte limpiamente las tapas sin caras coincidentes degeneradas.
  const pStart = edge.pointAt(0).toTuple() as Vec3;
  const pEnd = edge.pointAt(1).toTuple() as Vec3;
  const isClosed = dist3(pStart, pEnd) < 1e-5;
  if (!isClosed && convexity < 0 && stations.length >= 2) {
    const extLen = Math.min(radius * 0.08, len * 0.05);
    stations[0] = shiftStation(stations[0], stations[1], extLen);
    const last = stations.length - 1;
    stations[last] = shiftStation(stations[last], stations[last - 1], extLen);
  }

  const oc = getOC();
  const keep: Deletable[] = [];
  try {
    const wires: Wire[] = [];
    for (const st of stations) {
      const e1 = makeLine(st.pExt, st.aContact);
      const e2 = spec.isFillet
        ? makeThreePointArc(st.aContact, st.arcMid, st.bContact)
        : makeLine(st.aContact, st.bContact);
      const e3 = makeLine(st.bContact, st.pExt);
      try {
        const w = assembleWire([e1, e2, e3]);
        keep.push(w);
        wires.push(w);
      } finally {
        e1.delete();
        e2.delete();
        e3.delete();
      }
    }

    const loft = new oc.BRepOffsetAPI_ThruSections(true, edge.geomType === 'LINE', 1e-5);
    const loftRange = new oc.Message_ProgressRange();
    keep.push(loft, loftRange);
    for (const w of wires) loft.AddWire(w.wrapped);
    if (isClosed) loft.AddWire(wires[0].wrapped);
    loft.CheckCompatibility(true);
    loft.Build(loftRange);
    if (!loft.IsDone()) return null;

    const wedge = cast(loft.Shape());
    keep.push(wedge);
    if (wedge.solids.length === 0 || !isValidShape(wedge)) return null;

    // Identificar la cara del arco/chaflán en la cuña para nombrarla luego de la booleana.
    const midSt = stations[stations.length >> 1];
    let filletFaceInWedge: Face | null = null;
    let bestArcDist = Infinity;
    for (const wf of wedge.faces) {
      const d = distPointToFace(midSt.arcMid, wf);
      if (d < bestArcDist) {
        bestArcDist = d;
        filletFaceInWedge = wf;
      }
    }

    const boolRange = new oc.Message_ProgressRange();
    const algo =
      convexity < 0
        ? new oc.BRepAlgoAPI_Cut(base.shape.wrapped, wedge.wrapped, boolRange)
        : new oc.BRepAlgoAPI_Fuse(base.shape.wrapped, wedge.wrapped, boolRange);
    keep.push(boolRange, algo);
    if (!algo.IsDone() || algo.HasErrors()) return null;

    const result = cast(algo.Shape());
    if (result.solids.length !== base.shape.solids.length || !plausibleFilletResult(result, base.shape, radius)) {
      result.delete();
      return null;
    }

    // Verificar que el volumen cambió en el sentido esperado (corte reduce volumen; unión lo aumenta).
    const vBase = volume(base.shape);
    const vRes = volume(result);
    if (convexity < 0 && !(vRes < vBase - 1e-6)) {
      result.delete();
      return null;
    }
    if (convexity > 0 && !(vRes > vBase + 1e-6)) {
      result.delete();
      return null;
    }

    const history = historyOf(algo);
    // En la versión acotada ninguna de las dos caras adyacentes debe desaparecer por completo, ni
    // debe tocarse una cara ajena que no comparta al menos un vértice con la arista redondeada.
    if (history.isDeleted(f1.wrapped) || history.isDeleted(f2.wrapped)) {
      result.delete();
      return null;
    }
    for (const face of base.shape.faces) {
      if (face.isSame(f1) || face.isSame(f2)) continue;
      const touchesEdgeVertex = face.edges.some((fe) => {
        const a = fe.startPoint.toTuple() as Vec3;
        const b = fe.endPoint.toTuple() as Vec3;
        return dist3(a, pStart) < 1e-4 || dist3(a, pEnd) < 1e-4 || dist3(b, pStart) < 1e-4 || dist3(b, pEnd) < 1e-4;
      });
      if (!touchesEdgeVertex && (history.isDeleted(face.wrapped) || history.modified(face.wrapped).length > 0)) {
        result.delete();
        return null;
      }
    }

    const nb = new NameBuilder(result);
    nb.carry(base, history);
    const kind = spec.isFillet ? 'fillet' : 'chamfer';
    const tagName = `${spec.featureId}:${kind}:${edgeName}`;
    if (filletFaceInWedge) {
      const mods = history.modified(filletFaceInWedge.wrapped);
      const targets = mods.length > 0 ? mods : [filletFaceInWedge.wrapped];
      for (const tf of targets) nb.add(tf, tagName);
    }
    return nb.finish(spec.featureId);
  } catch {
    return null;
  } finally {
    keep.forEach((k) => k.delete());
  }
}

function shiftStation(st: WedgeStation, neighbor: WedgeStation, dist: number): WedgeStation {
  const dir = normalize(sub(st.pCorner, neighbor.pCorner));
  const delta = scale(dir, dist);
  return {
    pCorner: add(st.pCorner, delta),
    pExt: add(st.pExt, delta),
    aContact: add(st.aContact, delta),
    bContact: add(st.bContact, delta),
    arcMid: add(st.arcMid, delta),
  };
}

function computeWedgeStation(
  base: NamedShape,
  edge: Edge,
  f1: Face,
  f2: Face,
  t: number,
  radius: number,
  convexity: -1 | 1,
  isEndpoint: boolean,
): WedgeStation | null {
  const oc = getOC();
  const tClamped = Math.max(0.02, Math.min(0.98, t));
  const pCorner = edge.pointAt(t).toTuple() as Vec3;
  const pSample = edge.pointAt(tClamped).toTuple() as Vec3;
  const tan = normalize(edge.tangentAt(tClamped).toTuple() as Vec3);

  const pv = new oc.gp_Pnt(pSample[0], pSample[1], pSample[2]);
  let n1: Vec3;
  let n2: Vec3;
  try {
    n1 = normalize(f1.normalAt(pv).toTuple() as Vec3);
    n2 = normalize(f2.normalAt(pv).toTuple() as Vec3);
  } catch {
    return null;
  } finally {
    pv.delete();
  }

  const u1 = inwardFaceTangent(f1, pSample, tan, n1);
  const u2 = inwardFaceTangent(f2, pSample, tan, n2);
  if (!u1 || !u2) return null;

  // Ángulo entre normales (0 < alpha < pi): para caras perpendiculares alpha = 90° y d = r * tan(45°) = r.
  const cosAlpha = Math.max(-0.98, Math.min(0.98, dot(n1, n2)));
  const alpha = Math.acos(cosAlpha);
  if (alpha < (5 * Math.PI) / 180 || alpha > (175 * Math.PI) / 180) return null;

  const halfAlpha = alpha / 2;
  const offsetDist = radius * Math.tan(halfAlpha);
  const reachA = add(pCorner, scale(u1, offsetDist));
  const reachB = add(pCorner, scale(u2, offsetDist));

  // Verificar que los puntos de tangencia caigan realmente sobre f1 y f2 y no se salgan de la cara.
  const projA = projectPointToFace(reachA, f1);
  const projB = projectPointToFace(reachB, f2);
  if (!projA || !projB) return null;
  if (dist3(projA.point, reachA) > offsetDist * 0.22 || dist3(projB.point, reachB) > offsetDist * 0.22) {
    return null;
  }

  // En puntos interiores, verificar que el punto de contacto no cruce otra arista del contorno de la cara.
  if (!isEndpoint) {
    if (!fitsInsideFaceEdges(f1, edge, projA.point, offsetDist * 0.12)) return null;
    if (!fitsInsideFaceEdges(f2, edge, projB.point, offsetDist * 0.12)) return null;
  }

  // Centro de la bola rodante y punto medio del arco circular.
  const bisector = normalize(add(u1, u2));
  if (Math.hypot(...bisector) < 1e-6) return null;
  const centerDist = radius / Math.cos(halfAlpha);
  const ballCenter = add(pCorner, scale(bisector, centerDist));
  const toCorner = normalize(sub(pCorner, ballCenter));
  const arcMid = add(ballCenter, scale(toCorner, radius));
  const cutDepth = dist3(pCorner, arcMid);

  // Verificar que la cuña no atraviese una pared delgada (otra cara no adyacente del sólido).
  if (!isEndpoint && convexity < 0) {
    for (let fi = 0; fi < base.shape.faces.length; fi++) {
      const other = base.shape.faces[fi];
      if (other.isSame(f1) || other.isSame(f2)) continue;
      if (other.edges.some((oe) => oe.isSame(edge))) continue;
      const dCorner = distPointToFace(pCorner, other);
      if (dCorner < cutDepth * 1.08 || distPointToFace(arcMid, other) < radius * 0.15) {
        return null;
      }
    }
  }

  const pExt = add(pCorner, scale(toCorner, offsetDist * (convexity < 0 ? 0.4 : 0.01)));
  return {
    pCorner,
    pExt,
    aContact: projA.point,
    bContact: projB.point,
    arcMid,
  };
}

function fitsInsideFaceEdges(face: Face, currentEdge: Edge, contactPt: Vec3, minMargin: number): boolean {
  for (const e of face.edges) {
    if (e.isSame(currentEdge)) continue;
    if (distPointToEdge(contactPt, e) < minMargin) return false;
  }
  return true;
}

// ============================================================================
// Etapa 6: Ajuste adaptativo inteligente de radio (por arista y grupal)
// ============================================================================

function tryAdaptiveClamping(
  input: NamedShape,
  indices: number[],
  names: string[],
  spec: EdgeFeatureSpec,
  force = false,
): NamedShape | null {
  try {
    // En una sola arista, conservar el error explicativo cuando el radio supera la caja entera del sólido.
    if (indices.length === 1 && spec.size > maxBBoxSpan(input.shape)) return null;

    // 6a. En selecciones múltiples, intentar adaptando individualmente el radio de las aristas más angostas.
    if (indices.length > 1) {
      const adaptiveRadii: number[] = [];
      let allHaveMax = true;
      let anyClamped = false;

      for (let k = 0; k < indices.length; k++) {
        const idx = indices[k];
        if (engineEdgeFeatureWorks(input, [idx], spec.isFillet, spec.size)) {
          adaptiveRadii.push(spec.size);
          continue;
        }
        const maxR = bisectSingleEdgeMax(input, idx, spec, spec.size);
        if (maxR === null) {
          allHaveMax = false;
          break;
        }
        const safeR = roundDownSafe(maxR * 0.95);
        if (!(safeR > 0)) {
          allHaveMax = false;
          break;
        }
        adaptiveRadii.push(safeR);
        anyClamped = true;
      }

      // Si hasta el menor de esos radios supera el máximo que entra con todas las aristas a la vez,
      // la combinación tampoco entra (las aristas compiten en las esquinas): no vale la pena probarla.
      const together = bisectGroupMax(input, indices, spec);
      const hopeless = together !== null && Math.min(...adaptiveRadii) > together * 1.02;
      if (allHaveMax && anyClamped && !hopeless) {
        const note = () => noteReduction(spec, 'edges', Math.min(...adaptiveRadii));
        const direct = tryDirectEdgeFeature(input, indices, adaptiveRadii, spec, indices.map((i) => names[i]));
        if (direct) return note(), direct;

        const targets = buildEdgeTargets(input, indices, names, adaptiveRadii);
        const seq = trySequentialPasses(input, targets, spec);
        if (seq) return note(), seq;
      }
    }

    // 6b. Si las aristas compiten entre sí o la arista toca una cara de menor ancho (como 8.9 mm en
    // cara de 4 mm), calcular por bisección rápida el mayor radio admisible y aplicarlo.
    const groupMax = bisectGroupMax(input, indices, spec);
    if (groupMax === null) return null;
    // Si el radio sí entra geométricamente (groupMax >= spec.size * 0.99), no requiere clamping;
    // se permite que las siguientes etapas (UnifySameDomain, pasadas secuenciales, etc.) lo resuelvan.
    if (groupMax >= spec.size * 0.99 && !force) return null;

    for (const factor of [0.98, 0.95, 0.9, 0.85]) {
      const safeR = roundDownSafe(groupMax * factor);
      if (!(safeR > 0)) continue;
      const clampedSpec: EdgeFeatureSpec = { ...spec, size: safeR, variable: false };
      const res = executeFilletEngine(input, indices, clampedSpec, false);
      if (res) return noteReduction(spec, 'all', safeR), res;
    }

    return null;
  } catch {
    return null;
  }
}

/** Anota en el informe la reducción aplicada (queda la más fuerte si hubo varias). */
function noteReduction(spec: EdgeFeatureSpec, kind: NonNullable<EdgeFeatureReport['kind']>, min: number) {
  if (!spec.report) return;
  spec.report.kind = kind;
  spec.report.min = spec.report.min === undefined ? min : Math.min(spec.report.min, min);
}

// ----------------------------------------------------------------------------
// Etapa 6L: radio reducido solo en los tramos angostos (ley de radio a lo largo de la arista)
// ----------------------------------------------------------------------------

/** Puntos de muestreo de la ley por arista. */
const LAW_SAMPLES = 33;
/** Cuánto puede cambiar el radio por mm de arista (transición suave, sin escalones). */
const LAW_SLOPE = 0.5;
/** No se hace una ley local si el radio no llega al menos a esta fracción del pedido en algún tramo. */
const LAW_MIN_GAIN = 1.05;

/**
 * Radio que entra en cada punto de una arista según el ancho de las dos caras que toca: el arco
 * se apoya en cada cara a una distancia r / tan(α/2) de la arista (α = ángulo entre las caras por
 * dentro del material), que no puede pasar del ancho de la cara ahí. null si no se puede medir.
 */
function localRadiusLimits(input: NamedShape, edgeIndex: number, edge: Edge, adj: number[], requested: number): { u: number; s: number; limit: number }[] | null {
  // El límite por ancho de cara no depende del radio pedido: se mide una vez por sólido y arista
  // (al arrastrar el manejador se reutiliza) y acá solo se recorta al pedido.
  let byEdge = rawLimitMemos.get(input);
  if (!byEdge) rawLimitMemos.set(input, (byEdge = new Map()));
  let raw = byEdge.get(edgeIndex);
  if (raw === undefined) {
    raw = measureRadiusLimits(input, edge, adj);
    byEdge.set(edgeIndex, raw);
  }
  return raw ? raw.map((q) => ({ u: q.u, s: q.s, limit: Math.min(requested, q.limit) })) : null;
}

const rawLimitMemos = new WeakMap<NamedShape, Map<number, { u: number; s: number; limit: number }[] | null>>();

/** Mide el radio máximo por ancho de cara en cada punto de la arista (Infinity si no hay tope). */
function measureRadiusLimits(input: NamedShape, edge: Edge, adj: number[]): { u: number; s: number; limit: number }[] | null {
  const requested = Infinity;
  if (adj.length !== 2) return null;
  const oc = getOC();
  const faces = adj.map((i) => input.shape.faces[i]);
  // Borde de cada cara como polilíneas (sin la arista misma), para medir su ancho por rayos.
  const borders = faces.map((f) =>
    f.edges.filter((e) => !e.isSame(edge)).map((e) => {
      const pts: Vec3[] = [];
      for (let k = 0; k <= 16; k++) pts.push(e.pointAt(k / 16).toTuple() as Vec3);
      return pts;
    }));
  const out: { u: number; s: number; limit: number }[] = [];
  let s = 0;
  let prev: Vec3 | null = null;
  for (let k = 0; k < LAW_SAMPLES; k++) {
    const u = k / (LAW_SAMPLES - 1);
    // En los extremos se mide apenas adentro: justo en el vértice las caras vecinas confunden el rayo.
    const um = Math.min(1 - 1e-3, Math.max(1e-3, u));
    const p = edge.pointAt(um).toTuple() as Vec3;
    if (prev) s += dist3(prev, p);
    prev = p;
    const tan = normalize(edge.tangentAt(um).toTuple() as Vec3);
    const pv = new oc.gp_Pnt(p[0], p[1], p[2]);
    let normals: Vec3[];
    try {
      normals = faces.map((f) => normalize(f.normalAt(pv).toTuple() as Vec3));
    } finally {
      pv.delete();
    }
    // Ángulo entre las normales φ: el apoyo del arco en cada cara es r·tan(φ/2).
    const cosPhi = Math.max(-1, Math.min(1, dot(normals[0], normals[1])));
    const reach = Math.tan(Math.acos(cosPhi) / 2);
    if (!(reach > 1e-6)) return null; // caras tangentes: no hay nada que redondear
    let limit = requested;
    for (let f = 0; f < 2; f++) {
      const w = inwardFaceTangent(faces[f], p, tan, normals[f]);
      if (!w) return null;
      const width = rayWidth(p, w, tan, borders[f]);
      if (width !== null) limit = Math.min(limit, (0.9 * width) / reach);
    }
    out.push({ u, s, limit });
  }
  return out;
}

/**
 * Distancia desde `p` hasta el borde de la cara yendo por `w` (hacia adentro, perpendicular a la
 * arista): primer cruce del rayo con las polilíneas del borde, medido en el plano (w, t). null si
 * el rayo no cruza ningún borde (cara cerrada sobre sí misma, p. ej. un cilindro).
 */
function rayWidth(p: Vec3, w: Vec3, t: Vec3, borders: Vec3[][]): number | null {
  let best: number | null = null;
  for (const line of borders) {
    let a = sub(line[0], p);
    let [ax, ay] = [dot(a, w), dot(a, t)];
    for (let k = 1; k < line.length; k++) {
      const b = sub(line[k], p);
      const [bx, by] = [dot(b, w), dot(b, t)];
      if ((ay <= 0 && by >= 0) || (ay >= 0 && by <= 0)) {
        const den = ay - by;
        const x = Math.abs(den) < 1e-12 ? Math.min(ax, bx) : ax + ((bx - ax) * ay) / den;
        if (x > 1e-6 && (best === null || x < best)) best = x;
      }
      a = b;
      [ax, ay] = [bx, by];
    }
  }
  return best;
}

/**
 * Redondeo con el radio pedido donde entra y reducido, con transición suave, solo en los tramos
 * donde una cara vecina es más angosta. null si ninguna arista tiene un límite local (el problema
 * es otro) o si OCCT no puede construirlo.
 */
function tryLocalRadiusLaw(input: NamedShape, indices: number[], names: string[], spec: EdgeFeatureSpec): NamedShape | null {
  try {
    const { table, adjacent } = edgeAdjacency(input);
    const laws: ({ u: number; r: number }[] | null)[] = [];
    let anyLocal = false;
    let lowest = spec.size;
    for (const i of indices) {
      const limits = localRadiusLimits(input, i, table.items[i], adjacent[i] ?? [], spec.size);
      if (!limits) return null;
      const min = Math.min(...limits.map((l) => l.limit));
      if (min >= spec.size * (1 - 1e-9)) {
        laws.push(null); // en esta arista entra el radio completo
        continue;
      }
      // El tramo angosto puede empezar entre dos muestras: cada límite vale también para sus vecinas.
      const safe = limits.map((_, k) => Math.min(limits[Math.max(0, k - 1)].limit, limits[k].limit, limits[Math.min(limits.length - 1, k + 1)].limit));
      // Transición suave: el radio no cambia más rápido que LAW_SLOPE mm por mm de arista.
      const r = limits.map((a) => Math.min(...limits.map((b, j) => safe[j] + LAW_SLOPE * Math.abs(a.s - b.s))));
      // Si toda la arista queda prácticamente en el mínimo, no hay nada local: eso es un radio menor
      // para la arista entera y lo resuelve el ajuste por arista.
      if (Math.max(...r) < min * LAW_MIN_GAIN) return null;
      anyLocal = true;
      lowest = Math.min(lowest, min);
      laws.push(limits.map((l, k) => ({ u: l.u, r: r[k] })));
    }
    if (!anyLocal) return null;

    // Si la estimación quedó optimista (caras curvas), se achica la parte reducida y se reintenta.
    for (const shrink of [1, 0.85, 0.7]) {
      const scaled = laws.map((law) => law?.map((q) => ({ u: q.u, r: q.r >= spec.size * (1 - 1e-9) ? spec.size : q.r * shrink })) ?? null);
      const res = buildWithLaws(input, indices, scaled, spec, indices.map((i) => names[i]));
      if (res) {
        noteReduction(spec, 'local', roundDownSafe(lowest * shrink));
        return res;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Constructor de OCCT con una ley de radio (u ∈ [0, 1] → r) por arista; null = radio constante pedido. */
function buildWithLaws(
  base: NamedShape,
  indices: number[],
  laws: ({ u: number; r: number }[] | null)[],
  spec: EdgeFeatureSpec,
  edgeNamesFor: string[],
): NamedShape | null {
  const oc = getOC();
  const table = ShapeTable.edges(base.shape);
  const builder = new oc.BRepFilletAPI_MakeFillet(base.shape.wrapped, oc.ChFi3d_FilletShape.ChFi3d_Rational);
  const range = new oc.Message_ProgressRange();
  const keep: Deletable[] = [builder, range];
  try {
    indices.forEach((i, k) => {
      const edge = oc.TopoDS.Edge(table.items[i].wrapped);
      const law = laws[k];
      if (!law) {
        builder.Add(spec.size, edge);
        return;
      }
      const arr = new oc.NCollection_Array1_gp_Pnt2d(1, law.length);
      keep.push(arr);
      law.forEach((q, n) => {
        const pt = new oc.gp_Pnt2d(q.u, q.r);
        keep.push(pt);
        arr.SetValue(n + 1, pt);
      });
      builder.Add(arr, edge);
    });
    builder.Build(range);
    if (!builder.IsDone()) return null;
    const result = cast(builder.Shape());
    if (!plausibleFilletResult(result, base.shape, spec.size)) {
      result.delete();
      return null;
    }
    const history = historyOf(builder);
    const nb = new NameBuilder(result);
    nb.carry(base, history);
    indices.forEach((i, k) => nb.generated(history, table.items[i].wrapped, `${spec.featureId}:fillet:${edgeNamesFor[k]}`));
    return nb.finish(spec.featureId);
  } catch {
    return null;
  } finally {
    keep.forEach((d) => d.delete());
  }
}

/** Precisión con la que alcanza conocer el máximo que entra (después se aplica con margen). */
const BISECT_TOL = (v: number) => Math.max(0.01, v * 0.005);

/** Máximo ya conocido de un arrastre anterior (intervalo fino y pedido por encima de él), o null. */
function knownMax(input: NamedShape, indices: number[], isFillet: boolean, size: number): number | null {
  const m = memoFor(input, indices, isFillet);
  return m.works > 0 && size >= m.fails && m.fails - m.works < BISECT_TOL(m.works) ? m.works : null;
}

function bisectSingleEdgeMax(
  input: NamedShape,
  edgeIdx: number,
  spec: EdgeFeatureSpec,
  failed: number,
): number | null {
  try {
    const known = knownMax(input, [edgeIdx], spec.isFillet, failed);
    if (known !== null) return known;
    let lo = failed * 0.02;
    if (!engineEdgeFeatureWorks(input, [edgeIdx], spec.isFillet, lo)) return null;
    let hi = failed;
    for (let k = 0; k < 8; k++) {
      if (hi - lo < BISECT_TOL(lo)) break;
      const mid = (lo + hi) / 2;
      if (engineEdgeFeatureWorks(input, [edgeIdx], spec.isFillet, mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  } catch {
    return null;
  }
}

function bisectGroupMax(
  input: NamedShape,
  indices: number[],
  spec: EdgeFeatureSpec,
): number | null {
  try {
    const known = knownMax(input, indices, spec.isFillet, spec.size);
    if (known !== null) return known;
    let lo = spec.size * 0.01;
    if (!engineEdgeFeatureWorks(input, indices, spec.isFillet, lo)) return null;
    let hi = spec.size;
    for (let k = 0; k < 9; k++) {
      if (hi - lo < BISECT_TOL(lo)) break;
      const mid = (lo + hi) / 2;
      if (engineEdgeFeatureWorks(input, indices, spec.isFillet, mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  } catch {
    return null;
  }
}

function roundDownSafe(v: number): number {
  const r2 = Math.floor(v * 100) / 100;
  if (r2 > 0) return r2;
  return Math.floor(v * 1000) / 1000;
}

function maxBBoxSpan(shape: AnyShape): number {
  const [b0, b1] = shape.boundingBox.bounds;
  return Math.max(b1[0] - b0[0], b1[1] - b0[1], b1[2] - b0[2]);
}


// ============================================================================
// Utilidades geométricas sobre caras y aristas de OpenCascade
// ============================================================================

/**
 * Clasifica si una arista es convexa (-1, quita material al redondear) o cóncava (+1, agrega material).
 */
function classifyEdgeConvexity(base: NamedShape, edge: Edge, adj: number[]): -1 | 0 | 1 {
  if (adj.length !== 2) return 0;
  const oc = getOC();
  const f1 = base.shape.faces[adj[0]];
  const f2 = base.shape.faces[adj[1]];
  try {
    const p = edge.pointAt(0.5).toTuple() as Vec3;
    const tan = normalize(edge.tangentAt(0.5).toTuple() as Vec3);
    const pv = new oc.gp_Pnt(p[0], p[1], p[2]);
    let n1: Vec3;
    let n2: Vec3;
    try {
      n1 = normalize(f1.normalAt(pv).toTuple() as Vec3);
      n2 = normalize(f2.normalAt(pv).toTuple() as Vec3);
    } finally {
      pv.delete();
    }
    const u1 = inwardFaceTangent(f1, p, tan, n1);
    const u2 = inwardFaceTangent(f2, p, tan, n2);
    if (!u1 || !u2) return 0;
    const d = dot(add(u1, u2), add(n1, n2));
    if (Math.abs(d) < 1e-4) return 0;
    return d < 0 ? -1 : 1;
  } catch {
    return 0;
  }
}

/**
 * Vector unitario tangente a `face`, perpendicular a la arista (`edgeTan`) en `edgePt`, que apunta
 * hacia el interior de `face`.
 */
function inwardFaceTangent(face: Face, edgePt: Vec3, edgeTan: Vec3, faceNormal: Vec3): Vec3 | null {
  const cand = normalize(cross(faceNormal, edgeTan));
  if (Math.hypot(...cand) < 1e-6) return null;

  // En la gran mayoría de geometrías el vector hacia el centro de la cara es inequívoco y no requiere extrema.
  const toCenter = sub(face.center.toTuple() as Vec3, edgePt);
  if (Math.hypot(...toCenter) > 1e-4) {
    const d = dot(cand, toCenter);
    if (Math.abs(d) > 1e-3) return d > 0 ? cand : scale(cand, -1);
  }

  const step = 0.05;
  const pPlus = add(edgePt, scale(cand, step));
  const pMinus = sub(edgePt, scale(cand, step));
  const dPlus = distPointToFace(pPlus, face);
  const dMinus = distPointToFace(pMinus, face);
  return dPlus <= dMinus ? cand : scale(cand, -1);
}

/**
 * Proyecta de manera segura un punto 3D sobre una cara:
 * - En caras planas: 100 % matemáticas vectoriales puras en TypeScript (0 asignaciones OCCT).
 * - En superficies curvas (abombado/loft): extrema seguro sin doble liberación de punteros C++.
 */
function projectPointToFace(pt: Vec3, face: Face): { point: Vec3; distance: number } | null {
  if (face.geomType === 'PLANE') {
    try {
      const c = face.center.toTuple() as Vec3;
      const n = normalize(face.normalAt(face.center).toTuple() as Vec3);
      const d = dot(sub(pt, c), n);
      const point = sub(pt, scale(n, d));
      return { point, distance: Math.abs(d) };
    } catch {
      return null;
    }
  }

  const oc = getOC();
  let p: any = null;
  let v: any = null;
  let range: any = null;
  let ext: any = null;
  let sol: any = null;
  try {
    p = new oc.gp_Pnt(pt[0], pt[1], pt[2]);
    v = new oc.BRepBuilderAPI_MakeVertex(p);
    range = new oc.Message_ProgressRange();
    // v.Shape() es propiedad de v; no se debe llamar a .delete() sobre ella por separado.
    ext = new oc.BRepExtrema_DistShapeShape(v.Shape(), face.wrapped, undefined, undefined, range);
    if (!ext.IsDone() || ext.NbSolution() < 1) return null;
    sol = ext.PointOnShape2(1);
    const out: Vec3 = [sol.X(), sol.Y(), sol.Z()];
    const d = ext.Value();
    return { point: out, distance: d };
  } catch {
    return null;
  } finally {
    if (sol) sol.delete();
    if (ext) ext.delete();
    if (range) range.delete();
    if (v) v.delete();
    if (p) p.delete();
  }
}

/** Distancia euclidiana mínima de un punto `pt` a un segmento [a, b]. */
function distPointToSegment(pt: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 < 1e-12) return dist3(pt, a);
  const t = Math.max(0, Math.min(1, dot(sub(pt, a), ab) / l2));
  const proj = add(a, scale(ab, t));
  return dist3(pt, proj);
}

/** Distancia aproximada rápida y 100 % libre de asignaciones OCCT de un punto a una arista. */
function distPointToEdge(pt: Vec3, edge: Edge): number {
  try {
    const p0 = edge.startPoint.toTuple() as Vec3;
    const p1 = edge.endPoint.toTuple() as Vec3;
    if (edge.geomType === 'LINE') {
      return distPointToSegment(pt, p0, p1);
    }
    let minD = Math.min(dist3(pt, p0), dist3(pt, p1));
    for (const t of [0.25, 0.5, 0.75]) {
      const p = edge.pointAt(t).toTuple() as Vec3;
      minD = Math.min(minD, dist3(pt, p));
    }
    return minD;
  } catch {
    return Infinity;
  }
}

/** Distancia aproximada de un punto a una cara usando proyección en caras planas o centro en curvas. */
function distPointToFace(pt: Vec3, face: Face): number {
  try {
    if (face.geomType === 'PLANE') {
      const c = face.center.toTuple() as Vec3;
      const n = normalize(face.normalAt(face.center).toTuple() as Vec3);
      return Math.abs(dot(sub(pt, c), n));
    }
    const proj = projectPointToFace(pt, face);
    return proj?.distance ?? dist3(pt, face.center.toTuple() as Vec3);
  } catch {
    return Infinity;
  }
}

function edgeTangentNear(edge: Edge, pt: Vec3): Vec3 | null {
  try {
    if (edge.geomType === 'LINE') {
      return normalize(edge.tangentAt(0.5).toTuple() as Vec3);
    }
    let bestT = 0.5;
    let bestD = Infinity;
    for (let k = 0; k <= 8; k++) {
      const t = k / 8;
      const p = edge.pointAt(t).toTuple() as Vec3;
      const d = dist3(p, pt);
      if (d < bestD) {
        bestD = d;
        bestT = t;
      }
    }
    return normalize(edge.tangentAt(bestT).toTuple() as Vec3);
  } catch {
    return null;
  }
}
