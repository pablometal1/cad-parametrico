// Caja transportadora estilo hard surface: cuerpo octogonal con biseles, junta de tapa con labios,
// paneles marcados con ranuras, asas superiores y laterales y trabas. Todo sale de los parámetros.
import type { EdgeInfo } from '../kernel/protocol';
import { circle, octagon, rectC, type TemplateBuilder } from './builder';

export function buildCaja(t: TemplateBuilder) {
  // ---- parámetros (tabla fx)
  t.param('largo', 600, 'Largo total (X)');
  t.param('ancho', 330, 'Ancho total (Y)');
  t.param('alto', 290, 'Alto total (Z)');
  t.param('esquina', 35, 'Chaflán de las esquinas verticales');
  t.param('bisel', 14, 'Bisel de los bordes de tapa y base');
  t.param('tapa', 95, 'Alto de la tapa');
  t.param('junta', 3, 'Profundidad de la junta entre tapa y base');
  t.param('labio', 4, 'Cuánto sobresalen los labios de la junta');
  t.param('labio_alto', 14, 'Alto de cada labio');
  t.param('borde', 28, 'Margen de los paneles');
  t.param('ranura', 3, 'Ancho de las ranuras de los paneles');
  t.param('relieve', 3, 'Profundidad de paneles y ranuras');
  t.param('asa_d', 18, 'Diámetro de las barras de las asas');
  t.param('asa_largo', 140, 'Largo de las asas superiores');
  t.param('asa_alto', 26, 'Altura de las asas sobre la superficie');
  t.param('traba_ancho', 44, 'Ancho de las trabas');
  t.param('traba_alto', 70, 'Alto de las trabas');

  const seam = 'alto - tapa';
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-3;
  const atZ = (z: () => number) => (e: EdgeInfo) => e.curveType === 'LINE' && near(e.midpoint[2], z());

  // ---- cuerpo
  t.feature('Cuerpo', 'XY', 0, [octagon('largo', 'ancho', 'esquina')], { distance: 'alto', operation: 'new' });
  t.chamfer('Bisel superior', atZ(() => t.value('alto')), 'bisel');
  t.chamfer('Bisel inferior', atZ(() => 0), 'bisel');

  // ---- junta de la tapa: ranura alrededor y un labio de cada lado
  t.feature('Junta', 'XY', seam, [octagon('largo', 'ancho', 'esquina')], {
    distance: 'junta * 2', direction: 'symmetric', operation: 'cut', thin: 'junta * 2',
  });
  t.feature('Labio base', 'XY', `${seam} - junta - labio_alto`, [octagon('largo', 'ancho', 'esquina')], {
    distance: 'labio_alto', thin: 'labio * 2',
  });
  t.feature('Labio tapa', 'XY', `${seam} + junta`, [octagon('largo', 'ancho', 'esquina')], {
    distance: 'labio_alto', thin: 'labio * 2',
  });

  // ---- tapa: panel rebajado con dos refuerzos
  t.feature('Panel tapa', 'XY', 'alto', [octagon('largo - 2 * borde', 'ancho - 2 * borde', 'esquina')], {
    distance: 'relieve', direction: 'reversed', operation: 'cut',
  });
  t.feature('Refuerzos tapa', 'XY', 'alto - relieve', [
    rectC(0, 'ancho / 4', 'largo - 2 * borde - 2 * asa_largo', 'borde'),
    rectC(0, '-ancho / 4', 'largo - 2 * borde - 2 * asa_largo', 'borde'),
  ], { distance: 'relieve * 2' });

  // ---- ranuras de los paneles laterales (frente; la de atrás es su simetría)
  const panelFront = [
    rectC(0, `(bisel + ${seam} - junta - labio_alto) / 2`, 'largo - 2 * esquina - 2 * borde', `${seam} - junta - labio_alto - bisel - 2 * borde`),
    rectC(0, `(${seam} + junta + labio_alto + alto - bisel) / 2`, 'largo - 2 * esquina - 2 * borde', `tapa - junta - labio_alto - bisel - borde`),
  ];
  const frente = t.feature('Ranuras frente', 'XZ', 'ancho / 2', panelFront, {
    distance: 'relieve', direction: 'reversed', operation: 'cut', thin: 'ranura',
  });
  t.mirror('Ranuras atrás', frente, 'XZ');

  const panelEnd = [
    rectC(0, `(bisel + ${seam} - junta - labio_alto) / 2`, 'ancho - 2 * esquina - 2 * borde', `${seam} - junta - labio_alto - bisel - 2 * borde`),
  ];
  const lado = t.feature('Ranuras lado', 'YZ', 'largo / 2', panelEnd, {
    distance: 'relieve', direction: 'reversed', operation: 'cut', thin: 'ranura',
  });
  t.mirror('Ranuras lado opuesto', lado, 'YZ');

  // ---- asas superiores: dos soportes por asa y una barra a lo largo (frente y atrás)
  const yAsa = 'ancho / 2 - borde / 2';
  const soporte = 'asa_d * 1.6';
  const soportes = ['1', '-1'].flatMap((sy) => ['1', '-1'].map((sx) =>
    rectC(`${sx} * (asa_largo / 2)`, `${sy} * (${yAsa})`, soporte, soporte)));
  t.feature('Soportes asas', 'XY', 'alto - bisel', soportes, { distance: 'bisel + asa_alto + asa_d / 2' });
  t.feature('Barras asas', 'YZ', 'asa_largo / 2', [
    circle(yAsa, 'alto + asa_alto', 'asa_d / 2'),
    circle(`-(${yAsa})`, 'alto + asa_alto', 'asa_d / 2'),
  ], { distance: 'asa_largo', direction: 'reversed' });

  // ---- asas de los costados: soportes sobre la cara lateral y barra horizontal
  const zLado = `${seam} - junta - labio_alto - borde - asa_d`;
  const soporteLado = t.feature('Soportes asa lateral', 'YZ', 'largo / 2 - relieve', [
    rectC('asa_largo * 0.4', zLado, soporte, soporte),
    rectC('-asa_largo * 0.4', zLado, soporte, soporte),
  ], { distance: 'relieve + asa_alto' });
  t.mirror('Soportes asa lateral opuesta', soporteLado, 'YZ');
  t.feature('Barras asas laterales', 'XZ', 0, [
    circle('largo / 2 + asa_alto - asa_d / 2', zLado, 'asa_d / 2'),
    circle('-(largo / 2 + asa_alto - asa_d / 2)', zLado, 'asa_d / 2'),
  ], { distance: `asa_largo * 0.8 + ${soporte}`, direction: 'symmetric' });

  // ---- trabas sobre la junta (frente y atrás)
  const trabas = t.feature('Trabas', 'XZ', 'ancho / 2 - 1', [
    rectC('largo / 4', seam, 'traba_ancho', 'traba_alto'),
    rectC('-largo / 4', seam, 'traba_ancho', 'traba_alto'),
  ], { distance: 'labio + 1 + 4' });
  t.mirror('Trabas atrás', trabas, 'XZ');

  t.check();
}
