// Caja de seguridad «solid-state» estilo hard surface: cuerpo con aristas verticales redondeadas,
// junta a media altura, costillas sobre la tapa, paneles frontales rebajados con escalón central,
// tapas laterales en relieve con tornillos y asa, patas y ranuras de traba.
import type { EdgeInfo } from '../kernel/protocol';
import { circle, octagon, rectC, type Ex, type Shape2d, type TemplateBuilder } from './builder';

export function buildSsc(t: TemplateBuilder) {
  // ---- parámetros
  t.param('largo', 480, 'Largo del frente (X)');
  t.param('ancho', 360, 'Profundidad (Y)');
  t.param('alto', 250, 'Alto total sin patas (Z)');
  t.param('radio', 14, 'Redondeo de las aristas verticales');
  t.param('borde_r', 8, 'Redondeo de los bordes de arriba y abajo');
  t.param('junta', 3, 'Profundidad de la junta a media altura');
  t.param('costillas', 6, 'Cantidad de costillas sobre la tapa');
  t.param('costilla_ancho', 24, 'Ancho de cada costilla');
  t.param('costilla_alto', 10, 'Altura de las costillas');
  t.param('costilla_margen', 50, 'Margen de las costillas a los extremos');
  t.param('paso', '(largo - 2 * costilla_margen) / (costillas - 1)', 'Separación entre costillas');
  t.param('panel_margen', 28, 'Margen de los paneles del frente');
  t.param('muesca', 22, 'Profundidad del escalón central de los paneles');
  t.param('muesca_ancho', 'largo * 0.22', 'Medio ancho del escalón central');
  t.param('relieve', 4, 'Profundidad o salida de paneles y tapas');
  t.param('tapa_margen', 20, 'Margen de la tapa lateral');
  t.param('tapa_chaflan', 30, 'Chaflán de las esquinas de la tapa lateral');
  t.param('tornillo_d', 18, 'Diámetro de los alojamientos de tornillo');
  t.param('asa_ancho', 110, 'Ancho del asa lateral');
  t.param('asa_d', 12, 'Diámetro de la barra del asa');
  t.param('asa_sep', 26, 'Separación del asa a la tapa');
  t.param('pata', 10, 'Altura de las patas');
  t.param('pata_lado', 40, 'Lado de las patas');

  const near = (a: number, b: number) => Math.abs(a - b) < 1e-3;
  const v = (e: Ex) => t.value(e);

  // ---- cuerpo
  t.feature('Cuerpo', 'XY', 0, [rectC(0, 0, 'largo', 'ancho')], { distance: 'alto', operation: 'new' });
  t.fillet('Aristas verticales', (e: EdgeInfo) => e.curveType === 'LINE' && near(e.length, v('alto'))
    && near(Math.abs(e.midpoint[0]), v('largo / 2')) && near(Math.abs(e.midpoint[1]), v('ancho / 2')), 'radio');
  t.fillet('Borde superior', (e) => near(e.midpoint[2], v('alto')), 'borde_r');
  t.fillet('Borde inferior', (e) => near(e.midpoint[2], 0), 'borde_r');

  // ---- junta a media altura (el octógono sigue el redondeo de las esquinas)
  t.feature('Junta', 'XY', 'alto / 2', [octagon('largo', 'ancho', 'radio * 0.586')], {
    distance: 'junta * 2', direction: 'symmetric', operation: 'cut', thin: 'junta * 2',
  });

  // ---- costillas de la tapa: una y su patrón a lo largo del frente
  const costilla = t.feature('Costilla', 'XY', 'alto - 1', [
    rectC('-(costillas - 1) * paso / 2', 0, 'costilla_ancho', 'ancho - 2 * costilla_margen'),
  ], { distance: 'costilla_alto + 1' });
  t.pattern('Costillas', costilla, { axis: 'X', count: 'round(costillas)', spacing: 'paso' });
  t.fillet('Redondeo costillas', (e) => near(e.midpoint[2], v('alto + costilla_alto')), 'costilla_alto * 0.4');

  // ---- paneles del frente: campo rebajado con un escalón central (arriba y abajo de la junta)
  const W = 'largo / 2 - radio - panel_margen';
  const n1 = 'muesca_ancho', n2 = 'muesca_ancho + muesca';
  const half = (zb: string, zt: string, notchUp: boolean): Shape2d => {
    // Mitad superior: el borde de arriba baja en el centro. Mitad inferior: el de abajo sube.
    const zn = notchUp ? `${zb} + muesca` : `${zt} - muesca`;
    const pts: [Ex, Ex][] = notchUp
      ? [[`-(${W})`, zb], [`-(${n2})`, zb], [`-(${n1})`, zn], [n1, zn], [n2, zb], [W, zb], [W, zt], [`-(${W})`, zt]]
      : [[`-(${W})`, zb], [W, zb], [W, zt], [n2, zt], [n1, zn], [`-(${n1})`, zn], [`-(${n2})`, zt], [`-(${W})`, zt]];
    return { kind: 'poly', points: pts };
  };
  const frente = t.feature('Paneles frente', 'XZ', 'ancho / 2', [
    half('alto / 2 + junta + panel_margen / 2', 'alto - borde_r - panel_margen', false),
    half('borde_r + panel_margen', 'alto / 2 - junta - panel_margen / 2', true),
  ], { distance: 'relieve', direction: 'reversed', operation: 'cut' });
  t.mirror('Paneles atrás', frente, 'XZ');

  // ---- ranuras de traba en el centro del frente (arriba y abajo)
  const trabas = t.feature('Ranuras traba', 'XZ', 'ancho / 2', [
    rectC(0, 'alto - borde_r - panel_margen / 2', 'muesca_ancho * 0.35', 'panel_margen * 0.3'),
    rectC(0, 'borde_r + panel_margen / 2', 'muesca_ancho * 0.35', 'panel_margen * 0.3'),
  ], { distance: 'relieve', direction: 'reversed', operation: 'cut' });
  t.mirror('Ranuras traba atrás', trabas, 'XZ');

  // ---- tapas laterales en relieve (lado +X y su simetría)
  const tapa = t.feature('Tapa lateral', 'YZ', 'largo / 2 - 1', [
    { ...octagon('ancho - 2 * tapa_margen', 'alto - 2 * tapa_margen', 'tapa_chaflan') },
  ].map((s) => shiftV(s, 'alto / 2')), { distance: 'relieve + 1' });
  t.mirror('Tapa lateral opuesta', tapa, 'YZ');

  // Alojamientos de tornillo: agujero y cabeza adentro.
  const ty = 'ancho / 2 - tapa_margen - tapa_chaflan * 0.9';
  const tz = 'alto / 2 - tapa_margen - tapa_chaflan * 0.9';
  const screws = (r: string) => ['1', '-1'].flatMap((sy) => ['1', '-1'].map((sz) =>
    circle(`${sy} * (${ty})`, `alto / 2 + ${sz} * (${tz})`, r)));
  const agujeros = t.feature('Alojamientos tornillos', 'YZ', 'largo / 2 + relieve', screws('tornillo_d / 2'), {
    distance: 'relieve * 0.8', direction: 'reversed', operation: 'cut',
  });
  t.mirror('Alojamientos tornillos opuestos', agujeros, 'YZ');
  const cabezas = t.feature('Tornillos', 'YZ', 'largo / 2 + relieve * 0.2 - 0.5', screws('tornillo_d * 0.32'), { distance: 'relieve * 0.5' });
  t.mirror('Tornillos opuestos', cabezas, 'YZ');

  // Asa: dos soportes y una barra horizontal.
  const za = 'alto / 2';
  const soportes = t.feature('Soportes asa', 'YZ', 'largo / 2 + relieve - 1', [
    rectC('asa_ancho / 2', za, 'asa_d * 1.5', 'asa_d * 2.2'),
    rectC('-asa_ancho / 2', za, 'asa_d * 1.5', 'asa_d * 2.2'),
  ], { distance: 'asa_sep + asa_d / 2 + 1' });
  t.mirror('Soportes asa opuesta', soportes, 'YZ');
  t.feature('Barras asas', 'XZ', 0, [
    circle('largo / 2 + relieve + asa_sep', za, 'asa_d / 2'),
    circle('-(largo / 2 + relieve + asa_sep)', za, 'asa_d / 2'),
  ], { distance: 'asa_ancho + asa_d * 1.5', direction: 'symmetric' });

  // ---- patas en las esquinas
  const px = 'largo / 2 - radio - pata_lado / 2', py = 'ancho / 2 - radio - pata_lado / 2';
  t.feature('Patas', 'XY', 1, ['1', '-1'].flatMap((sx) => ['1', '-1'].map((sy) =>
    rectC(`${sx} * (${px})`, `${sy} * (${py})`, 'pata_lado', 'pata_lado'))), {
    distance: 'pata + 1', direction: 'reversed',
  });

  t.check();
}

/** Corre un contorno en v (alto del plano del sketch). */
function shiftV(s: Shape2d, dv: string): Shape2d {
  if (s.kind === 'circle') return { ...s, center: [s.center[0], `(${String(s.center[1])}) + ${dv}`] };
  return { ...s, points: s.points.map(([u, w]) => [u, `(${String(w)}) + ${dv}`] as [Ex, Ex]) };
}
