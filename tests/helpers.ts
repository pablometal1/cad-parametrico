// Ayudas para armar documentos de prueba con sketches y extrusiones.
import { addFeature, emptyDocument, makeExtrude, makeSketch } from '../src/document/ops';
import type { BasePlane, CadDocument, ExtrudeFeature, SketchData } from '../src/document/types';
import { SketchBuilder } from '../src/sketch/builders';

export type ProfileSpec =
  | { kind: 'rect'; w: number; h: number; center?: [number, number] }
  | { kind: 'circle'; r: number; center?: [number, number] };

export interface PlaneSpec {
  plane?: BasePlane;
  offset?: number;
}

export const rect = (w: number, h: number, center?: [number, number]): ProfileSpec => ({ kind: 'rect', w, h, center });
export const circle = (r: number, center?: [number, number]): ProfileSpec => ({ kind: 'circle', r, center });

/** Geometría (sin restricciones de cota) de uno o varios perfiles. */
export function profileData(...profiles: ProfileSpec[]): SketchData {
  const b = new SketchBuilder({ entities: [], constraints: [] });
  for (const p of profiles) {
    const [cx, cy] = p.center ?? [0, 0];
    if (p.kind === 'rect') b.rectangle([cx - p.w / 2, cy - p.h / 2], [cx + p.w / 2, cy + p.h / 2]);
    else b.circle([cx, cy], p.r);
  }
  return b.data;
}

export interface ExtrudeSpec extends PlaneSpec, Partial<Pick<ExtrudeFeature, 'distance' | 'direction' | 'operation'>> {
  profile: ProfileSpec | ProfileSpec[];
}

/** Agrega un sketch con el perfil y una extrusión que lo usa. */
export function addSketchExtrude(doc: CadDocument, spec: ExtrudeSpec): CadDocument {
  const profiles = Array.isArray(spec.profile) ? spec.profile : [spec.profile];
  const sketch = makeSketch(doc, {
    plane: { kind: 'base', plane: spec.plane ?? 'XY', offset: spec.offset ?? 0 },
    ...profileData(...profiles),
  });
  let d = addFeature(doc, sketch);
  const { profile: _p, plane: _pl, offset: _o, ...extrudeOpts } = spec;
  d = addFeature(d, makeExtrude(d, sketch.id, extrudeOpts));
  return d;
}

export function build(...specs: ExtrudeSpec[]): CadDocument {
  return specs.reduce(addSketchExtrude, emptyDocument());
}

/** Índices de las extrusiones dentro de doc.features (las de sketch quedan entre medio). */
export function extrudeIds(doc: CadDocument) {
  return doc.features.filter((f) => f.type === 'extrude').map((f) => f.id);
}
