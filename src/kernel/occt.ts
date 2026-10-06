// Inicialización de OpenCascade (WASM) compartida entre el worker y los tests en Node.
import opencascade from 'replicad-opencascadejs';
import { Edge, Face, HASH_CODE_MAX, Shape, Solid, setOC } from 'replicad';

type OCInstance = Awaited<ReturnType<typeof opencascade>>;

let instance: Promise<OCInstance> | null = null;

/**
 * Carga OCCT una sola vez y lo registra en replicad.
 * @param wasmUrl URL del .wasm (navegador). En Node se omite y emscripten lo busca junto al .js.
 */
export function initOCCT(wasmUrl?: string): Promise<OCInstance> {
  if (!instance) {
    instance = opencascade(
      wasmUrl ? { locateFile: () => wasmUrl } : undefined,
    ).then((oc) => {
      setOC(oc);
      patchTopology(oc);
      return oc;
    });
  }
  return instance;
}

/**
 * replicad recorre caras/aristas/sólidos descartando repetidos con una comparación contra todos los
 * anteriores: cuadrático. Con piezas importadas (miles de triángulos) `shape.faces` tardaba minutos.
 * Se reemplaza por una versión que agrupa por hash: mismo resultado, mismo orden, lineal.
 */
function patchTopology(oc: OCInstance) {
  type Kind = 'face' | 'edge' | 'solid';
  const enumOf: Record<Kind, unknown> = {
    face: oc.TopAbs_ShapeEnum.TopAbs_FACE,
    edge: oc.TopAbs_ShapeEnum.TopAbs_EDGE,
    solid: oc.TopAbs_ShapeEnum.TopAbs_SOLID,
  };
  const down: Record<Kind, (s: never) => unknown> = {
    face: (s) => oc.TopoDS.Face(s),
    edge: (s) => oc.TopoDS.Edge(s),
    solid: (s) => oc.TopoDS.Solid(s),
  };
  const wrap: Record<Kind, new (s: never) => unknown> = { face: Face as never, edge: Edge as never, solid: Solid as never };
  const collect = (shape: { wrapped: unknown }, kind: Kind) => {
    const explorer = new oc.TopExp_Explorer(shape.wrapped as never, enumOf[kind] as never, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    const buckets = new Map<number, { IsSame(o: unknown): boolean }[]>();
    const out: unknown[] = [];
    try {
      for (; explorer.More(); explorer.Next()) {
        const item = explorer.Current();
        const h = oc.ReplicadShapeHasher.HashCode(item, HASH_CODE_MAX);
        const bucket = buckets.get(h);
        if (bucket?.some((b) => b.IsSame(item))) continue;
        if (bucket) bucket.push(item);
        else buckets.set(h, [item]);
        out.push(new wrap[kind](down[kind](item as never) as never));
      }
    } finally {
      explorer.delete();
    }
    return out;
  };
  for (const kind of ['face', 'edge', 'solid'] as const) {
    Object.defineProperty(Shape.prototype, `${kind}s`, {
      configurable: true,
      get(this: { wrapped: unknown }) {
        return collect(this, kind);
      },
    });
  }
}
