# CAD paramétrico

CAD paramétrico basado en historial, que corre entero en el navegador y está pensado para **impresión 3D**. Funciona como Fusion 360 o el Part Design de FreeCAD: la pieza se arma con una lista de operaciones editables. Si cambiás una medida, todo lo que sigue se recalcula.

## Qué hace

- **Sketches 2D con restricciones:** coincidente, horizontal, vertical, paralela, perpendicular, tangente, igual, distancia, radio y ángulo. Muestra un indicador de "totalmente definido".
  - Herramientas: punto, línea, rectángulo (también desde el centro), círculo, arco, polígono, ranura y **texto**.
- **Dibujo directo en 3D** sobre caras planas, planos base o planos de construcción.
- **Operaciones:**
  - extrusión, revolución, barrido y solevación, cada una como nuevo cuerpo, unir o cortar;
  - redondeo, chaflán y vaciado;
  - patrón lineal o circular, y simetría;
  - **agujero**: simple, cajeado o avellanado, con presets de tornillos e insertos;
  - **rosca modelada**, interna o externa.
- **Planos de construcción:** desplazados, o girados alrededor de X, Y, Z o de una arista del modelo.
- **Historial:**
  - editar, suprimir, borrar o retroceder con el marcador;
  - **reordenar** arrastrando las features (con control de dependencias);
  - deshacer y rehacer.
- **Parámetros con nombre y expresiones** (`ancho / 2`), usables en cualquier campo numérico.
- **Importar y exportar:**
  - importar **STL/STEP** como referencia o para encastres (cortar la pieza importada);
  - exportar **STL, 3MF y STEP**.
- **Para imprimir:**
  - propiedades de la pieza: volumen, masa y metros de filamento según el material;
  - comprobación automática: sólido válido, malla cerrada, normales hacia afuera y cuerpos sin superponerse.
- **Análisis visual:** sombreados matcap, cebra y normales.

Todo en milímetros. El documento es un JSON y se guarda como archivo `.cad.json`, con un borrador automático en el navegador.

## Cómo correrlo

Requiere Node.js 20 o más nuevo.

```bash
npm install
npm run dev      # abre http://localhost:5173
npm test         # tests (con OpenCascade real, sin simulaciones)
npm run build    # versión para publicar, en dist/
```

Atajos útiles: `?` muestra todos los atajos. `K` crea un sketch, `L` `R` `C` `T` dibujan, y `Shift+E` extruye.

Con `?pieza=nombre` en la dirección, cada pestaña guarda su propio borrador.

## Cómo está hecho

- **TypeScript + Vite**, interfaz en **Solid.js**.
- **Kernel B-rep:** OpenCascade (WASM) a través de [replicad](https://replicad.xyz). Corre en un Web Worker.
- **Solver de restricciones 2D:** [planegcs](https://github.com/Salusoft89/planegcs), el solver de FreeCAD.
- **Visualización:** Three.js. Solo dibuja; no tiene geometría propia.
- **Fuente del texto:** Roboto, leída con opentype.js.

Carpetas principales:

| Carpeta | Contenido |
|---|---|
| `src/document` | Modelo del documento, operaciones puras, expresiones, validación de archivos |
| `src/sketch` | Sketches: solver, perfiles, texto |
| `src/kernel` | Motor de recálculo con cache, features de OpenCascade, nombres topológicos, exportación |
| `src/viewport` | Vista 3D, selección, manipuladores, cubo de vistas |
| `src/ui` | Interfaz: barra, historial, paneles, editor de sketch |
| `tests` | Tests del documento, del recálculo y de cada operación, con volúmenes comparados contra fórmulas |

### Nombres topológicos

Las referencias a caras y aristas (para redondeos, sketches sobre caras, etc.) usan nombres que salen de la historia de cada operación, por ejemplo `extrusión:side:<curva>`. Además guardan una huella geométrica, así que sobreviven a los cambios de medidas. Si una referencia se pierde, la feature queda en error en el historial y el resto del modelo no se rompe.

## Licencias de terceros

- OpenCascade, vía `replicad-opencascadejs`: LGPL-2.1.
- planegcs: LGPL-2.0 o posterior.
- Roboto: SIL Open Font License 1.1.
- replicad, Solid.js, Three.js, opentype.js y fflate: licencias MIT o similares.
