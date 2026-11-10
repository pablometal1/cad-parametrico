import { describe, it, expect } from 'vitest';
import { emptyDocument, addFeature, makeSketch, makeExtrude, setDocumentUnits, scaleDocument } from '../src/document/ops';
import { parseDocument, serializeDocument, DocumentFormatError } from '../src/document/serialize';
import type { ExtrudeFeature, SketchFeature } from '../src/document/types';
import { profileData, rect } from './helpers';

describe('Unidades y Escalas del Proyecto', () => {
  it('permite cambiar la unidad de mm a pulgadas convirtiendo las dimensiones geométricas', () => {
    let doc = emptyDocument();
    // Rectángulo de 25.4 mm x 50.8 mm (centrado en el origen: x de -12.7 a +12.7)
    const sk = makeSketch(doc, profileData(rect(25.4, 50.8)));
    doc = addFeature(doc, sk);
    const ext = makeExtrude(doc, sk.id);
    (ext as ExtrudeFeature).distance = 25.4;
    doc = addFeature(doc, ext);

    expect(doc.units).toBe('mm');
    expect((doc.features[1] as ExtrudeFeature).distance).toBe(25.4);

    // Cambiar a pulgadas (in)
    const inDoc = setDocumentUnits(doc, 'in', true);
    expect(inDoc.units).toBe('in');
    expect((inDoc.features[1] as ExtrudeFeature).distance).toBeCloseTo(1.0, 5);

    // Los puntos del sketch se escalaron por 1 / 25.4
    const skPoints = (inDoc.features[0] as SketchFeature).entities.filter((e) => e.type === 'point');
    const xs = skPoints.map((p) => (p as any).x);
    const ys = skPoints.map((p) => (p as any).y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    expect(width).toBeCloseTo(1.0, 5);
    expect(height).toBeCloseTo(2.0, 5);

    // Volver a milímetros (mm)
    const mmDoc = setDocumentUnits(inDoc, 'mm', true);
    expect(mmDoc.units).toBe('mm');
    expect((mmDoc.features[1] as ExtrudeFeature).distance).toBeCloseTo(25.4, 5);
  });

  it('permite cambiar la unidad de mm a cm y m convirtiendo las dimensiones', () => {
    let doc = emptyDocument();
    const sk = makeSketch(doc, profileData(rect(10, 20)));
    doc = addFeature(doc, sk);
    const ext = makeExtrude(doc, sk.id);
    (ext as ExtrudeFeature).distance = 30;
    doc = addFeature(doc, ext);

    // A centímetros (cm): 10 mm = 1 cm, 30 mm = 3 cm
    const cmDoc = setDocumentUnits(doc, 'cm', true);
    expect(cmDoc.units).toBe('cm');
    expect((cmDoc.features[1] as ExtrudeFeature).distance).toBeCloseTo(3.0, 5);

    // A metros (m): 3 cm = 0.03 m
    const mDoc = setDocumentUnits(cmDoc, 'm', true);
    expect(mDoc.units).toBe('m');
    expect((mDoc.features[1] as ExtrudeFeature).distance).toBeCloseTo(0.03, 5);
  });

  it('permite cambiar la unidad sin convertir dimensiones (solo reinterpretar)', () => {
    let doc = emptyDocument();
    const sk = makeSketch(doc, profileData(rect(10, 10)));
    doc = addFeature(doc, sk);
    const ext = makeExtrude(doc, sk.id);
    (ext as ExtrudeFeature).distance = 5;
    doc = addFeature(doc, ext);

    const inDoc = setDocumentUnits(doc, 'in', false);
    expect(inDoc.units).toBe('in');
    // Las dimensiones se conservan exactamente iguales
    expect((inDoc.features[1] as ExtrudeFeature).distance).toBe(5);
  });

  it('scaleDocument multiplica las dimensiones por el factor indicado', () => {
    let doc = emptyDocument();
    const sk = makeSketch(doc, profileData(rect(10, 20)));
    doc = addFeature(doc, sk);
    const ext = makeExtrude(doc, sk.id);
    (ext as ExtrudeFeature).distance = 15;
    doc = addFeature(doc, ext);

    const scaled = scaleDocument(doc, 2.5);
    expect((scaled.features[1] as ExtrudeFeature).distance).toBeCloseTo(37.5, 5);

    const pts = (scaled.features[0] as SketchFeature).entities.filter((e) => e.type === 'point');
    const xs = pts.map((p) => (p as any).x);
    const width = Math.max(...xs) - Math.min(...xs);
    expect(width).toBeCloseTo(25, 5);
  });

  it('serializa y lee documentos en pulgadas, cm, m y mm', () => {
    let doc = emptyDocument();
    doc = setDocumentUnits(doc, 'in', false);
    const json = serializeDocument(doc);
    const parsed = parseDocument(json);
    expect(parsed.units).toBe('in');

    const cmParsed = parseDocument(JSON.stringify({ ...doc, units: 'cm' }));
    expect(cmParsed.units).toBe('cm');

    const mParsed = parseDocument(JSON.stringify({ ...doc, units: 'm' }));
    expect(mParsed.units).toBe('m');

    // Unidad inválida se rechaza con error
    expect(() => parseDocument(JSON.stringify({ ...doc, units: 'yardas' }))).toThrow(DocumentFormatError);
  });
});
