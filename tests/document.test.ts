import { describe, it, expect } from 'vitest';
import {
  activeCount, addFeature, deleteFeature, emptyDocument, isRolledBack, makeExtrude,
  nextFeatureName, rollbackAfter, setRollback, setSuppressed, updateFeature,
} from '../src/document/ops';
import { DocumentFormatError, parseDocument, serializeDocument } from '../src/document/serialize';
import type { CadDocument, ExtrudeFeature } from '../src/document/types';

function docWith(n: number): CadDocument {
  let doc = emptyDocument();
  for (let i = 0; i < n; i++) doc = addFeature(doc, makeExtrude(doc));
  return doc;
}
const ids = (d: CadDocument) => d.features.map((f) => f.id);
const names = (d: CadDocument) => d.features.map((f) => f.name);

describe('operaciones del documento', () => {
  it('agrega features al final con nombres incrementales y operación por defecto', () => {
    const doc = docWith(3);
    expect(names(doc)).toEqual(['Extrusión1', 'Extrusión2', 'Extrusión3']);
    expect((doc.features[0] as ExtrudeFeature).operation).toBe('new');
    expect((doc.features[1] as ExtrudeFeature).operation).toBe('join');
    expect(doc.rollback).toBeNull();
    expect(new Set(ids(doc)).size).toBe(3);
  });

  it('no muta el documento original', () => {
    const doc = docWith(2);
    const snapshot = JSON.stringify(doc);
    updateFeature<ExtrudeFeature>(doc, doc.features[0].id, { distance: 99 });
    deleteFeature(doc, doc.features[1].id);
    setRollback(doc, 1);
    addFeature(doc, makeExtrude(doc));
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('actualiza parámetros sin permitir cambiar id ni tipo', () => {
    const doc = docWith(1);
    const id = doc.features[0].id;
    const next = updateFeature(doc, id, { distance: 5, id: 'otro', type: 'x' } as never);
    expect(next.features[0].id).toBe(id);
    expect(next.features[0].type).toBe('extrude');
    expect((next.features[0] as ExtrudeFeature).distance).toBe(5);
    expect(() => updateFeature(doc, 'inexistente', {})).toThrow(/No existe/);
  });

  it('una actualización sin cambios devuelve el mismo documento', () => {
    const doc = docWith(1);
    const f = doc.features[0] as ExtrudeFeature;
    expect(updateFeature<ExtrudeFeature>(doc, f.id, { distance: f.distance })).toBe(doc);
    expect(updateFeature<ExtrudeFeature>(doc, f.id, { profile: { ...f.profile } })).toBe(doc);
    expect(updateFeature<ExtrudeFeature>(doc, f.id, { distance: f.distance + 1 })).not.toBe(doc);
  });

  it('rechaza IDs duplicados', () => {
    const doc = docWith(1);
    expect(() => addFeature(doc, { ...doc.features[0] })).toThrow(/duplicado/);
  });

  it('suprime y reactiva', () => {
    const doc = docWith(2);
    const s = setSuppressed(doc, doc.features[1].id, true);
    expect(s.features[1].suppressed).toBe(true);
    expect(setSuppressed(s, doc.features[1].id, false).features[1].suppressed).toBe(false);
  });

  it('el marcador de retroceso desactiva las features posteriores', () => {
    const doc = docWith(4);
    const r = rollbackAfter(doc, doc.features[1].id);
    expect(r.rollback).toBe(2);
    expect(activeCount(r)).toBe(2);
    expect([0, 1, 2, 3].map((i) => isRolledBack(r, i))).toEqual([false, false, true, true]);
    expect(setRollback(r, null).rollback).toBeNull();
    expect(setRollback(r, 4).rollback).toBeNull(); // al final se normaliza a null
    expect(setRollback(r, 0).rollback).toBe(0);
    expect(() => setRollback(r, -1)).toThrow();
    expect(() => setRollback(r, 1.5)).toThrow();
  });

  it('con retroceso, las features nuevas se insertan en el marcador y lo hacen avanzar', () => {
    const doc = docWith(3);
    const r = setRollback(doc, 1);
    const f = makeExtrude(r);
    const next = addFeature(r, f);
    expect(ids(next)).toEqual([doc.features[0].id, f.id, doc.features[1].id, doc.features[2].id]);
    expect(next.rollback).toBe(2);
  });

  it('borrar antes del marcador lo corre; borrar después no', () => {
    const doc = setRollback(docWith(4), 2);
    expect(deleteFeature(doc, doc.features[0].id).rollback).toBe(1);
    expect(deleteFeature(doc, doc.features[3].id).rollback).toBe(2);
    // Si el marcador queda al final, se normaliza a null.
    const atEnd = setRollback(docWith(2), 1);
    expect(deleteFeature(atEnd, atEnd.features[1].id).rollback).toBeNull();
  });

  it('nextFeatureName reutiliza huecos de numeración', () => {
    const doc = docWith(3);
    const d = deleteFeature(doc, doc.features[1].id);
    expect(nextFeatureName(d, 'extrude')).toBe('Extrusión2');
  });
});

describe('serialización', () => {
  it('ida y vuelta conserva el documento', () => {
    let doc = docWith(3);
    doc = updateFeature<ExtrudeFeature>(doc, doc.features[2].id, {
      profile: { kind: 'circle', plane: 'XZ', offset: 2.5, center: [1, -3], radius: 4 },
      operation: 'cut',
      direction: 'symmetric',
    });
    doc = setSuppressed(doc, doc.features[1].id, true);
    doc = setRollback(doc, 2);
    expect(parseDocument(serializeDocument(doc))).toEqual(doc);
  });

  it('informa el campo inválido', () => {
    const good = JSON.parse(serializeDocument(docWith(1)));
    const bad = (mutate: (d: any) => void) => {
      const d = structuredClone(good);
      mutate(d);
      return () => parseDocument(JSON.stringify(d));
    };
    expect(() => parseDocument('{')).toThrow(DocumentFormatError);
    expect(bad((d) => (d.format = 'otro'))).toThrow(/\$\.format/);
    expect(bad((d) => (d.version = 2))).toThrow(/versión no soportada/);
    expect(bad((d) => (d.features[0].distance = 'diez'))).toThrow(/\$\.features\[0\]\.distance/);
    expect(bad((d) => (d.features[0].profile.kind = 'hexágono'))).toThrow(/perfil desconocido/);
    expect(bad((d) => (d.features[0].type = 'loft'))).toThrow(/feature desconocido/);
    expect(bad((d) => (d.features[0].operation = 'intersect'))).toThrow(/operation/);
    expect(bad((d) => (d.rollback = 5))).toThrow(/rollback/);
    expect(bad((d) => d.features.push(structuredClone(d.features[0])))).toThrow(/duplicado/);
  });

  it('acepta parámetros geométricamente imposibles (son errores del modelo, no del archivo)', () => {
    const d = JSON.parse(serializeDocument(docWith(1)));
    d.features[0].distance = 0;
    expect(() => parseDocument(JSON.stringify(d))).not.toThrow();
  });
});
