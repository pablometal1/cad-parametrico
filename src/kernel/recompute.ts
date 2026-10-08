// Motor de recálculo: recorre el documento y regenera el sólido, reutilizando resultados en cache.
import { activeCount } from '../document/ops';
import type { CadDocument, CopyFeature, Feature, FeatureId, ProfileFeature, ShellFeature } from '../document/types';
import type { PlaneFrame } from '../document/planes';
import { describePlane, evaluatePlane } from './features/plane';
import { describeError, FeatureError, hashString } from './occtUtils';
import type { NamedShape } from './naming';
import { runExtrude } from './features/extrude';
import { runRevolve } from './features/revolve';
import { runEdgeFeature, runShell, runShellOver } from './features/dressup';
import { runMirror, runPattern } from './features/copy';
import { runLoft, runSweep } from './features/sweep';
import { runHole } from './features/hole';
import { runThread } from './features/thread';
import { runImport } from './features/import';
import { describeSketch, evaluateSketch, type EvaluatedSketch } from './features/sketch';
import type { FeatureResult, FeatureStatus } from './protocol';

interface CacheEntry {
  /** Hash de (clave de la entrada + parámetros de la feature + estado de dependencias). */
  key: string;
  /** Sólido nombrado después de la feature. Si `owned` es false, es el mismo objeto que la entrada. */
  output: NamedShape | null;
  owned: boolean;
  /** Para features de sketch: el sketch resuelto, que consumen las features posteriores. */
  sketch?: EvaluatedSketch;
  /** Para planos de construcción: su sistema de coordenadas. */
  plane?: PlaneFrame;
  /** Importación como referencia: el cuerpo que se muestra aparte (propiedad de la entrada). */
  reference?: NamedShape;
  status: Extract<FeatureStatus, 'ok' | 'error'>;
  error?: string;
  info?: string;
  timeMs: number;
}

export interface RecomputeOutput {
  results: FeatureResult[];
  /** Sólido final con nombres (propiedad del motor: válido hasta la próxima llamada a run o dispose). */
  shape: NamedShape | null;
  /** Sketches evaluados en este recálculo. */
  sketches: Map<FeatureId, EvaluatedSketch>;
  /** Planos de construcción evaluados en este recálculo. */
  planes: Map<FeatureId, PlaneFrame>;
  /** Piezas importadas como referencia (se muestran, no se exportan). */
  references: { id: FeatureId; shape: NamedShape }[];
}

const ROOT_KEY = 'root';
/** Versiones que se guardan por feature. */
const CACHE_VERSIONS = 3;
/** Features borradas cuyas versiones se conservan (para deshacer el borrado sin recalcular). */
const REMOVED_KEPT = 20;

/**
 * Base de la clave de una feature que no depende del sólido: sketches sobre planos base o de
 * construcción, y planos que parten de otro plano (sin cara ni arista del modelo). null si depende.
 */
function solidIndependentBase(feature: Feature, planeKeys: Map<FeatureId, string>): string | null {
  if (feature.type === 'sketch') {
    if (feature.plane.kind === 'base') return 'base';
    if (feature.plane.kind === 'plane') return planeKeys.get(feature.plane.plane) ?? 'sin-plano';
    return null;
  }
  if (feature.type === 'plane' && feature.axis !== 'edge') {
    if (feature.reference.kind === 'base') return 'base';
    if (feature.reference.kind === 'plane') return planeKeys.get(feature.reference.plane) ?? 'sin-plano';
  }
  return null;
}

interface Context {
  input: NamedShape | null;
  sketches: Map<FeatureId, EvaluatedSketch>;
  planes: Map<FeatureId, PlaneFrame>;
  doc: CadDocument;
  index: number;
}

export class RecomputeEngine {
  /**
   * Últimas versiones calculadas de cada feature (la más reciente primero). Guardar más de una
   * hace que deshacer/rehacer, o volver un valor atrás, no recalcule nada.
   */
  private cache = new Map<FeatureId, CacheEntry[]>();
  /** Versiones de features borradas hace poco: deshacer el borrado no recalcula. */
  private removed = new Map<FeatureId, CacheEntry[]>();
  /** Sólido de entrada de cada feature evaluada en el último recálculo (propiedad de la cache). */
  private lastInputs = new Map<FeatureId, NamedShape | null>();
  private lastSketches = new Map<FeatureId, EvaluatedSketch>();
  private lastPlanes = new Map<FeatureId, PlaneFrame>();
  private lastDoc: CadDocument | null = null;

  /** Contexto de la feature en el último recálculo, o null si no se evaluó (retrocedida/suprimida). */
  contextOf(id: FeatureId): {
    input: NamedShape | null; sketches: Map<FeatureId, EvaluatedSketch>; planes: Map<FeatureId, PlaneFrame>; doc: CadDocument;
  } | null {
    if (!this.lastDoc || !this.lastInputs.has(id)) return null;
    return { input: this.lastInputs.get(id)!, sketches: this.lastSketches, planes: this.lastPlanes, doc: this.lastDoc };
  }

  /**
   * @param exprErrors Features cuyas expresiones no se pudieron evaluar: quedan en error sin calcularse.
   */
  run(doc: CadDocument, exprErrors: ReadonlyMap<FeatureId, string> = new Map()): RecomputeOutput {
    const active = activeCount(doc);
    const results: FeatureResult[] = [];
    const sketches = new Map<FeatureId, EvaluatedSketch>();
    const planes = new Map<FeatureId, PlaneFrame>();
    const references: RecomputeOutput['references'] = [];
    /** Clave de cada plano de construcción calculado (para sketches/planos que dependen de él). */
    const planeKeys = new Map<FeatureId, string>();
    let current: NamedShape | null = null;
    let currentKey = ROOT_KEY;
    this.lastInputs = new Map();
    this.lastSketches = sketches;
    this.lastPlanes = planes;
    this.lastDoc = doc;

    doc.features.forEach((feature, index) => {
      if (index >= active) {
        results.push({ id: feature.id, status: 'rolledBack', timeMs: 0, cached: false });
        return;
      }
      if (feature.suppressed) {
        // Una feature suprimida es transparente: no cambia ni el sólido ni la clave.
        results.push({ id: feature.id, status: 'suppressed', timeMs: 0, cached: false });
        return;
      }

      const ctx: Context = { input: current, sketches, planes, doc, index };
      this.lastInputs.set(feature.id, current);
      const exprError = exprErrors.get(feature.id);
      if (exprError) {
        // Error de expresión: la feature no se calcula; el sólido y la clave siguen como estaban.
        results.push({ id: feature.id, status: 'error', error: exprError, timeMs: 0, cached: false });
        return;
      }
      // La clave incluye el estado de las dependencias (p. ej. un sketch borrado vs. suprimido).
      // Sketches y planos que no se apoyan en el sólido no dependen de lo que pasó antes con él:
      // cambiar una extrusión no obliga a volver a resolver los sketches que vienen después.
      const base = solidIndependentBase(feature, planeKeys) ?? currentKey;
      const key = hashString(base + '\u0000' + featureFingerprint(feature) + '\u0000' + dependencyState(feature, ctx));
      let versions = this.cache.get(feature.id);
      if (!versions) {
        // ¿Volvió una feature borrada (deshacer)? Se recuperan sus versiones.
        versions = this.removed.get(feature.id) ?? [];
        this.removed.delete(feature.id);
      }
      let e = versions.find((v) => v.key === key);
      const cached = !!e;
      if (e) {
        versions.splice(versions.indexOf(e), 1);
      } else {
        e = this.compute(feature, ctx, key);
      }
      versions.unshift(e);
      for (const old of versions.splice(CACHE_VERSIONS)) this.release(old);
      this.cache.set(feature.id, versions);
      if (e.sketch) sketches.set(feature.id, e.sketch);
      if (e.plane) {
        planes.set(feature.id, e.plane);
        planeKeys.set(feature.id, key);
      }
      if (e.reference) references.push({ id: feature.id, shape: e.reference });
      results.push({ id: feature.id, status: e.status, error: e.error, info: e.info, timeMs: e.timeMs, cached });
      // Las features que no cambian el sólido (sketch, plano, referencia, error) lo dejan pasar tal
      // como llegó: su `output` guardado puede ser de otro recálculo.
      current = e.owned ? e.output : current;
      // La cadena de claves incluye todo lo anterior (también sketches): una extrusión se entera si
      // cambió su sketch. Si la feature falló, la clave sigue igual.
      currentKey = e.status === 'ok' ? hashString(currentKey + '\u0000' + key) : currentKey;
    });

    this.evictMissing(doc);
    return { results, shape: current, sketches, planes, references };
  }

  dispose() {
    for (const versions of [...this.cache.values(), ...this.removed.values()]) versions.forEach((v) => this.release(v));
    this.removed.clear();
    this.cache.clear();
    this.lastInputs.clear();
    this.lastDoc = null;
  }

  /** Cantidad de entradas en cache (para tests y diagnóstico). */
  get cacheSize() {
    return this.cache.size;
  }

  /**
   * Vaciado. El hueco se calcula sobre una versión "maciza" de la pieza y se resta de la real:
   * - sin los vaciados previos, para no volver a ahuecar las paredes que ya existen;
   * - sin los redondeos y chaflanes que el desplazamiento hace desaparecer. Hacia adentro, un
   *   redondeo convexo de radio r desplazado t ≥ r se reduce a una arista viva (un chaflán de
   *   distancia d en una arista a 90°, con t ≥ d·(1 + 1/√2)), y OCCT no sabe quitar esa cara
   *   degenerada: por eso el vaciado fallaba con espesor ≥ radio. El hueco correcto en ese caso
   *   es exactamente el de la pieza sin el redondeo; en los cóncavos la pared solo queda más
   *   gruesa en el rincón.
   */
  private shell(feature: ShellFeature, ctx: Context): NamedShape {
    const input = ctx.input;
    const inPart = (f: Feature) => !f.suppressed && !!input?.names.some((ns) => ns.some((n) => n.startsWith(`${f.id}:`)));
    const before = ctx.doc.features.slice(0, ctx.index);
    const prior = before.filter((f) => f.type === 'shell' && inPart(f));
    // Margen relativo: con radio = espesor la cara también degenera.
    const vanishes = (f: Feature) =>
      (f.type === 'fillet' && f.radius <= feature.thickness * (1 + 1e-6)) ||
      (f.type === 'chamfer' && f.distance * (1 + Math.SQRT1_2) <= feature.thickness * (1 + 1e-6));
    const small = before.filter((f) => vanishes(f) && inPart(f));
    if (prior.length === 0 && small.length === 0) return runShell(feature, input);

    const ids = new Set([...prior, ...small].map((f) => f.id));
    const sub = new RecomputeEngine();
    try {
      const solidDoc: CadDocument = {
        ...ctx.doc,
        rollback: null,
        features: before.map((f) => (ids.has(f.id) ? { ...f, suppressed: true } : f)),
      };
      const out = sub.run(solidDoc);
      const usable = out.shape && out.results.every((r) => r.status === 'ok' || r.status === 'suppressed');
      if (usable) {
        try {
          return runShellOver(feature, input, out.shape!);
        } catch (overErr) {
          // Si tampoco sale el vaciado común, el error útil es el de este intento.
          try {
            return runShell(feature, input);
          } catch {
            throw overErr;
          }
        }
      }
      return runShell(feature, input);
    } finally {
      sub.dispose();
    }
  }

  private compute(feature: Feature, ctx: Context, key: string): CacheEntry {
    const t0 = performance.now();
    const ok = (output: NamedShape): CacheEntry => ({ key, output, owned: true, status: 'ok', timeMs: elapsed(t0) });
    try {
      switch (feature.type) {
        case 'sketch': {
          const sketch = evaluateSketch(feature, ctx.input, ctx.planes);
          // Un sketch no modifica el sólido.
          return { key, output: ctx.input, owned: false, sketch, status: 'ok', info: describeSketch(sketch), timeMs: elapsed(t0) };
        }
        case 'plane': {
          // Un plano no modifica el sólido.
          const plane = evaluatePlane(feature, ctx.input, ctx.planes);
          return { key, output: ctx.input, owned: false, plane, status: 'ok', info: describePlane(feature), timeMs: elapsed(t0) };
        }
        case 'extrude':
          return ok(runExtrude(feature, resolveSketch(feature, ctx), ctx.input));
        case 'revolve':
          return ok(runRevolve(feature, resolveSketch(feature, ctx), ctx.input));
        case 'fillet':
        case 'chamfer':
          return ok(runEdgeFeature(feature, ctx.input));
        case 'shell':
          return ok(this.shell(feature, ctx));
        case 'pattern': {
          const { source, sketch } = resolveSource(feature, ctx);
          return ok(runPattern(feature, source, sketch, ctx.input));
        }
        case 'mirror': {
          const { source, sketch } = resolveSource(feature, ctx);
          return ok(runMirror(feature, source, sketch, ctx.input));
        }
        case 'sweep':
          return ok(runSweep(
            feature,
            resolveSketchById(feature.profile, 'el perfil de este barrido', ctx),
            resolveSketchById(feature.path, 'la trayectoria de este barrido', ctx),
            ctx.input,
          ));
        case 'thread':
          return ok(runThread(feature, ctx.input));
        case 'import': {
          const r = runImport(feature, ctx.input);
          return r.reference
            ? { key, output: ctx.input, owned: false, reference: r.reference, status: 'ok', info: feature.fileName, timeMs: elapsed(t0) }
            : { ...ok(r.output!), info: feature.fileName };
        }
        case 'hole':
          return ok(runHole(feature, resolveSketchById(feature.sketch, 'el sketch de este agujero', ctx), ctx.input));
        case 'loft':
          return ok(runLoft(
            feature,
            feature.sections.map((id, i) => resolveSketchById(id, `la sección ${i + 1} de esta solevación`, ctx)),
            ctx.input,
          ));
      }
    } catch (err) {
      return { key, output: ctx.input, owned: false, status: 'error', error: describeError(err), timeMs: elapsed(t0) };
    }
  }

  private evictMissing(doc: CadDocument) {
    const ids = new Set(doc.features.map((f) => f.id));
    for (const [id, versions] of this.cache) {
      if (!ids.has(id)) {
        this.cache.delete(id);
        this.removed.set(id, versions);
      }
    }
    // Se guardan las últimas REMOVED_KEPT borradas; las más viejas se liberan.
    for (const [id, versions] of this.removed) {
      if (this.removed.size <= REMOVED_KEPT) break;
      versions.forEach((v) => this.release(v));
      this.removed.delete(id);
    }
  }

  private release(entry: CacheEntry) {
    if (entry.owned && entry.output) entry.output.shape.delete();
    entry.reference?.shape.delete();
    entry.reference = undefined;
    entry.output = null;
    entry.owned = false;
  }
}

function dependencyState(feature: Feature, ctx: Context): string {
  try {
    if (feature.type === 'extrude' || feature.type === 'revolve') {
      resolveSketch(feature, ctx);
      return 'ok';
    }
    if (feature.type === 'hole') {
      resolveSketchById(feature.sketch, 'un sketch', ctx);
      return 'ok';
    }
    if (feature.type === 'sweep' || feature.type === 'loft') {
      for (const id of feature.type === 'sweep' ? [feature.profile, feature.path] : feature.sections) {
        resolveSketchById(id, 'un sketch', ctx);
      }
      return 'ok';
    }
    if (feature.type === 'pattern' || feature.type === 'mirror') {
      // Incluye los parámetros de la feature de origen: si cambian, la copia se recalcula.
      const { source } = resolveSource(feature, ctx);
      return 'ok' + featureFingerprint(source);
    }
    return '';
  } catch (err) {
    return (err as Error).message;
  }
}

/** Feature de origen de un patrón o simetría (y su sketch), con errores claros si no sirve. */
function resolveSource(feature: CopyFeature, ctx: Context): { source: ProfileFeature; sketch: EvaluatedSketch } {
  const i = ctx.doc.features.findIndex((f) => f.id === feature.source);
  if (i < 0) throw new FeatureError('La feature de origen fue borrada');
  const source = ctx.doc.features[i];
  if (i > ctx.index) throw new FeatureError(`"${source.name}" está después en el historial`);
  if (source.type !== 'extrude' && source.type !== 'revolve') {
    throw new FeatureError(`Solo se pueden repetir o reflejar extrusiones y revoluciones ("${source.name}" no lo es)`);
  }
  if (source.suppressed) throw new FeatureError(`"${source.name}" está suprimida`);
  return { source, sketch: resolveSketch(source, ctx) };
}

/** Busca el sketch que usa una feature y explica por qué no está disponible si falta. */
function resolveSketch(feature: ProfileFeature, ctx: Context): EvaluatedSketch {
  return resolveSketchById(feature.sketch, `el sketch de ${feature.type === 'extrude' ? 'esta extrusión' : 'esta revolución'}`, ctx);
}

/** `what` describe el sketch en los mensajes ("el perfil de este barrido"…). */
function resolveSketchById(id: FeatureId, what: string, ctx: Context): EvaluatedSketch {
  const evaluated = ctx.sketches.get(id);
  if (evaluated) return evaluated;
  const i = ctx.doc.features.findIndex((f) => f.id === id);
  if (i < 0) throw new FeatureError(`${what[0].toUpperCase()}${what.slice(1)} fue borrado`);
  const target = ctx.doc.features[i];
  if (target.type !== 'sketch') throw new FeatureError(`"${target.name}" no es un sketch`);
  if (i > ctx.index) throw new FeatureError(`El sketch "${target.name}" está después en el historial`);
  if (target.suppressed) throw new FeatureError(`El sketch "${target.name}" está suprimido`);
  throw new FeatureError(`El sketch "${target.name}" tiene errores`);
}

/** Parámetros que afectan la geometría (excluye nombre y supresión). */
function featureFingerprint(feature: Feature): string {
  // Las expresiones no cuentan: lo que importa es el valor ya evaluado.
  const { name: _name, suppressed: _suppressed, exprs: _exprs, ...geometric } = feature;
  return stableStringify(geometric);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function elapsed(t0: number) {
  return Math.round((performance.now() - t0) * 10) / 10;
}
