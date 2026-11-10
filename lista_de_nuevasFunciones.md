# Funciones que le faltan a la app y cómo implementarlas

Lista ordenada por prioridad para un CAD pensado para impresión 3D. Cada función dice para qué sirve, cómo se haría en este código y cuánto trabajo es.

**Esfuerzo:** S = uno o dos días · M = alrededor de una semana · L = varias semanas.

**Receta común para una feature nueva** (se repite en casi todas, así que no la repito abajo):

1. Tipo en [`src/document/types.ts`](src/document/types.ts) y constructor `makeX` en [`src/document/ops.ts`](src/document/ops.ts).
2. Lectura y validación en [`src/document/serialize.ts`](src/document/serialize.ts).
3. Función `runX` en `src/kernel/features/`, con nombres de caras vía `NameBuilder`.
4. Caso en `compute()` de [`src/kernel/recompute.ts`](src/kernel/recompute.ts) y sus dependencias en `requiredFeatures`.
5. Botón en [`src/ui/tools.ts`](src/ui/tools.ts), creación en [`src/ui/store.ts`](src/ui/store.ts) y panel en [`src/ui/FeatureEditor.tsx`](src/ui/FeatureEditor.tsx).
6. Tests con OpenCascade real en `tests/`, comparando volúmenes contra fórmulas.

---

## Resumen

| # | Función | Para qué | Esfuerzo |
|---|---|---|---|
| 1 | Vista en corte | Ver el interior sin modificar la pieza | S |
| 2 | Análisis de voladizos | Saber qué necesita soportes antes de imprimir | S |
| 3 | Análisis de espesor de pared | Encontrar paredes demasiado finas | M |
| 4 | Holguras de encastre | Que las piezas encajen al imprimirlas | S |
| 5 | Ocultar y aislar cuerpos | Trabajar en piezas de varios cuerpos | S |
| 6 | Operar sobre un cuerpo elegido | Unir o cortar contra un cuerpo y no contra todos | M |
| 7 | Proyectar aristas al sketch | Dibujar apoyándose en geometría existente | M |
| 8 | Cotas que faltan en el sketch | Diámetro, punto medio, colineal, concéntrico | S |
| 9 | Extruir "hasta" una cara | Extrusiones que siguen a la pieza | M |
| 10 | Nervio | Refuerzos desde una línea abierta | M |
| 11 | Patrón a lo largo de una curva y de cualquier feature | Repetir agujeros, redondeos, etc. | M |
| 12 | Hélice y resorte | Resortes, roscas a medida, rampas | S |
| 13 | Envolver / grabar sobre caras curvas | Texto sobre un cilindro | L |
| 14 | Desborde del redondeo | Redondeos mayores que la cara vecina | L (más si hay que recompilar OpenCascade) |
| 15 | Redondeo de cara completa | Bordes totalmente redondeados | M |
| 16 | Unir superficies en un sólido | Cerrar el flujo de superficies | M |
| 17 | Desfase y engrosado de caras | Dar espesor a cualquier superficie | S |
| 18 | Orientar para imprimir | Apoyar la pieza sobre una cara | S |
| 19 | Partir pieza con encastres | Piezas más grandes que la cama | M |
| 20 | Exportar por cuerpo y con colores | Multimaterial y piezas separadas | S |
| 21 | Plano 2D con cotas | Documentar la pieza | L |
| 22 | Ensamble simple | Ubicar piezas guardadas y revisar interferencias | L |
| 23 | Configuraciones | Variantes de una pieza (S, M, L) | M |
| 24 | Reparar referencias perdidas | Reasignar la cara o arista de una feature en error | M |
| 25 | Publicar como página web | Usarla sin instalar nada | S |

---

## Ver y analizar

### 1. Vista en corte

**Qué es:** un plano que corta la vista (no la pieza) para ver el interior: paredes, agujeros, roscas.

**Cómo implementarla**
- Three.js ya lo soporta: `renderer.clippingPlanes = [new THREE.Plane(normal, distancia)]` en [`src/viewport/Viewport.ts`](src/viewport/Viewport.ts), con `renderer.localClippingEnabled = true`.
- Para que el corte se vea "macizo" y no hueco, dibujar las caras internas con otro color: una segunda pasada con `side: THREE.BackSide` y un material plano.
- Controles: un botón en los controles de vista, elección de eje (X, Y, Z o una cara plana elegida) y un manejador lineal para mover el plano. Se puede reutilizar `ManipulatorWidget`.
- No toca el kernel ni el documento: es estado de la vista.

**Atención:** las aristas no se recortan solas, hay que pasarles los mismos planos a sus materiales.

### 2. Análisis de voladizos

**Qué es:** pintar en rojo las caras que miran hacia abajo con más de 45° (o el ángulo elegido), las que van a necesitar soportes.

**Cómo implementarla**
- Es un sombreado más, junto a cebra y normales en [`src/viewport/shading.ts`](src/viewport/shading.ts): un `ShaderMaterial` que compara la normal del fragmento con la dirección de impresión (`-Z` por defecto).
- Fórmula en el shader: `ángulo = acos(dot(normal, vec3(0,0,-1)))`; rojo si es menor que el umbral, amarillo en la franja de transición.
- Parámetros: ángulo límite (45° por defecto) y dirección de impresión, como `uniforms`.
- Las caras apoyadas en la cama (z mínimo) no cuentan: descartarlas con la altura del fragmento.

**Extra útil:** sumar el área en voladizo en el panel "Pieza" (se calcula en el kernel recorriendo los triángulos de la malla).

### 3. Análisis de espesor de pared

**Qué es:** marcar las zonas donde la pared mide menos que un mínimo (por ejemplo, dos pasadas de boquilla: 0,8 mm).

**Cómo implementarla**
- En el worker, sobre la malla de exportación: para cada vértice lanzar un rayo hacia adentro (contra la normal) y medir la distancia hasta la primera cara que toca.
- Para que sea rápido hace falta una estructura espacial. La opción más simple es agregar `three-mesh-bvh` (licencia MIT) y correrlo en el worker con la geometría de la malla.
- Devolver un valor por vértice y pintarlo con un atributo de color en el viewport (escala de rojo a verde).
- API nueva en [`src/kernel/protocol.ts`](src/kernel/protocol.ts): `wallThickness(min: number)` que devuelve el arreglo de espesores y el mínimo encontrado.

**Atención:** en mallas grandes puede tardar segundos, así que tiene que ser a pedido (un botón), no en cada recálculo.

### 4. Holguras de encastre

**Qué es:** una ayuda para que dos piezas impresas encajen: holgura para deslizar, para presión, para tornillos.

**Cómo implementarla**
- Una tabla de presets en `src/document/`, como la de agujeros en [`src/document/holes.ts`](src/document/holes.ts): deslizante 0,2 mm, ajustado 0,1 mm, a presión 0 mm, etc.
- En "Combinar → cortar", un campo "Holgura": antes de restar, agrandar la herramienta con `BRepOffsetAPI_MakeOffsetShape` (ya se usa en [`src/kernel/features/dressup.ts`](src/kernel/features/dressup.ts) para el vaciado).
- Guardar la holgura como parámetro con nombre, así se ajusta una vez según la impresora y cambia en toda la pieza.

**Atención:** el desfase de OCCT falla en formas con esquinas agudas; si falla, dar un error claro en lugar de cortar sin holgura.

---

## Cuerpos

### 5. Ocultar y aislar cuerpos

**Qué es:** poder ocultar un cuerpo para ver otro, o aislar uno solo.

**Cómo implementarla**
- El kernel ya sabe a qué cuerpo pertenece cada cara. Falta mandarlo al viewport: un arreglo `faceBody` (índice de sólido por cara) en `MeshPayload`.
- En [`src/viewport/Viewport.ts`](src/viewport/Viewport.ts), un conjunto de cuerpos ocultos y un grupo de geometría por cuerpo (o descartar sus triángulos al armar el índice).
- En la interfaz, una lista "Cuerpos" debajo del historial con un ojo por cuerpo, y "Aislar" en el menú de la cara seleccionada.
- Es estado de la vista: no se guarda en el documento ni afecta la exportación.

### 6. Operar sobre un cuerpo elegido

**Qué es:** hoy "unir" y "cortar" actúan sobre todos los cuerpos. Falta elegir contra cuál.

**Cómo implementarla**
- Campo opcional `target?: FaceRef` en las features que crean cuerpo (extrusión, revolución, barrido, solevación), igual al que ya tiene Combinar.
- En `combine()` de [`src/kernel/features/boolean.ts`](src/kernel/features/boolean.ts): si hay `target`, separar los sólidos del compuesto, operar solo sobre el que contiene esa cara y volver a armar el compuesto.
- En los paneles, un botón "Elegir cuerpo…" que usa el modo de elegir caras que ya existe (`beginPick` con un slot nuevo).

**Atención:** los nombres de las caras de los cuerpos que no se tocan tienen que pasar intactos (`nb.carry(input, null)`).

---

## Sketch

### 7. Proyectar aristas al sketch

**Qué es:** traer aristas del modelo al sketch como geometría de referencia, para acotar y dibujar contra ellas.

**Cómo implementarla**
- Entidad nueva `{ type: 'projected', edge: EdgeRef }` en el sketch. No es editable: su posición la da el modelo.
- En `evaluateSketch` de [`src/kernel/features/sketch.ts`](src/kernel/features/sketch.ts): resolver la arista, proyectarla al plano con `toPlane` y convertirla en línea, arco o spline de construcción con sus puntos fijos.
- En el solver ([`src/sketch/solver.ts`](src/sketch/solver.ts)), esos puntos entran con `fixed: true`, así el resto se puede restringir contra ellos.
- El contorno de la cara de apoyo ya se dibuja como referencia visual; esto lo vuelve seleccionable.

**Atención:** el sketch pasa a depender del sólido, así que deja de valer el atajo `solidIndependentBase` de la cache para ese sketch.

### 8. Cotas y restricciones que faltan

**Qué es:** diámetro, punto medio, colineal y concéntrico.

**Cómo implementarla**
- **Diámetro:** misma restricción que radio, mostrando el doble. Es un cambio de presentación en [`src/sketch/rules.ts`](src/sketch/rules.ts).
- **Punto medio:** planegcs tiene dos restricciones de punto medio (`midpoint_on_line_ll` y `midpoint_on_line_pppp`); hay que mapear una en `toGcs`. Falta comprobar cuál sirve para "este punto es el medio de esta línea": si ninguna encaja directo, se arma con el punto sobre la línea más distancias iguales a los dos extremos.
- **Colineal:** dos `point_on_line_pl` (los dos extremos de una línea sobre la otra).
- **Concéntrico:** `p2p_coincident` entre los centros.
- Agregar cada una a la barra de restricciones del editor y a las reglas de selección.

### 9. Extruir "hasta" una cara

**Qué es:** que la extrusión termine en una cara elegida, en la siguiente cara que encuentre, o atraviese todo.

**Cómo implementarla**
- Campo `extent: 'distance' | 'toFace' | 'toNext' | 'through'` y `toFace?: FaceRef` en `ExtrudeFeature`.
- **Hasta una cara:** extruir una distancia mayor que la caja de la pieza y cortar el prisma con la superficie de esa cara extendida (`BRepAlgoAPI_Splitter`), quedándose con la parte del lado del sketch.
- **Atravesar todo:** distancia = diagonal de la caja × 2, como ya hace el agujero pasante.
- **Hasta la siguiente:** la clase de OCCT que lo hace (`BRepFeat_MakePrism`) no está en la compilación WASM que usa la app (lo verifiqué). Se resuelve a mano: extruir largo, partir el prisma con el sólido (`BRepAlgoAPI_Splitter`) y quedarse con el primer tramo desde el sketch.

### 10. Nervio

**Qué es:** un refuerzo que sale de una línea abierta y se extiende hasta tocar el material.

**Cómo implementarla**
- La extrusión delgada ya engrosa líneas abiertas. El nervio agrega: extender los extremos de la línea hasta las caras y rellenar hacia el sólido.
- Receta: engrosar la línea (como la extrusión delgada), extruirla lejos en la dirección del nervio, intersectar con el "aire" entre las paredes (caja de la pieza menos el sólido) y unir.
- Opción de ángulo de desmoldeo, reutilizando [`src/kernel/features/direct.ts`](src/kernel/features/direct.ts).

### 11. Patrón a lo largo de una curva y de cualquier feature

**Qué es:** hoy el patrón repite solo extrusiones y revoluciones. Falta repetir agujeros, redondeos o grupos de features, y hacerlo a lo largo de una curva.

**Cómo implementarla**
- **Cualquier feature:** en lugar de repetir la operación, repetir su resultado. Calcular la diferencia entre el sólido antes y después de la feature (`cut` en un sentido y en el otro), transformar esos cuerpos y aplicarlos. Así funciona con cualquier feature sin conocerla.
- **A lo largo de una curva:** tomar la trayectoria con `buildPathWire` de [`src/kernel/features/sweep.ts`](src/kernel/features/sweep.ts), repartir N puntos por longitud y poner una copia en cada uno, girada según la tangente.

**Atención:** con muchas copias, unir de a una es lento. Conviene juntar todas las copias en un compuesto y hacer una sola booleana.

### 12. Hélice y resorte

**Qué es:** una curva helicoidal como trayectoria de barrido: resortes, rampas, roscas a medida.

**Cómo implementarla**
- `makeHelix` de replicad ya se usa en [`src/kernel/features/thread.ts`](src/kernel/features/thread.ts).
- Agregar al barrido la opción "trayectoria helicoidal" con eje, paso, altura y radio, en lugar de un sketch de trayectoria.
- Usar `BRepOffsetAPI_MakePipeShell` en modo binormal (como la rosca) para que el perfil no se retuerza.
- Para paso variable o hélice cónica, construir la hélice como una curva 2D sobre una superficie cónica.

### 13. Envolver sobre caras curvas

**Qué es:** grabar o poner en relieve un texto o un dibujo sobre un cilindro o un cono.

**Cómo implementarla**
- Un cilindro se puede "desenrollar": cada punto (u, v) del sketch va a (ángulo = u / radio, altura = v).
- Construir cada curva del sketch como curva 2D en el espacio de parámetros de la cara y crear la arista con `BRepBuilderAPI_MakeEdge(curva2d, superficie)`.
- Con esas aristas armar caras sobre el cilindro, desfasarlas el relieve pedido y unirlas o restarlas.

**Atención:** es la más difícil de esta lista: el texto tiene muchos contornos pequeños y las booleanas con caras desfasadas fallan seguido. Empezar solo con cilindros.

---

## Redondeos y superficies

### 14. Desborde del redondeo

**Qué es:** que el redondeo pueda ser más grande que la cara vecina, comiéndosela y apoyándose en la siguiente. Hoy el motor reduce el radio en ese tramo.

**Cómo implementarla**
- Detectar la cara angosta con `localRadiusLimits` de [`src/kernel/features/filletEngine.ts`](src/kernel/features/filletEngine.ts), que ya mide el ancho.
- Quitar esa cara y extender las vecinas hasta que se corten. La clase de OCCT pensada para esto (`BRepAlgoAPI_Defeaturing`) no está en la compilación WASM que usa la app (lo verifiqué), así que hay dos caminos: recompilar OpenCascade incluyéndola, o hacerlo a mano extendiendo las superficies vecinas, cortándolas entre sí y cosiendo el sólido de nuevo.
- Redondear la arista nueva que queda entre las caras extendidas.
- Si no se puede, caer al comportamiento actual (radio reducido con aviso).

### 15. Redondeo de cara completa

**Qué es:** reemplazar una cara angosta entera por un redondeo tangente a sus dos vecinas (el borde de una placa totalmente redondeado).

**Cómo implementarla**
- Caso simple (cara plana entre dos caras paralelas): radio = mitad del ancho, redondeando las dos aristas a la vez. El motor ya resuelve las dos aristas juntas.
- Caso general (ancho variable): radio variable a lo largo de la arista, tomando en cada punto la mitad del ancho medido. La ley de radio por tramo ya existe (`buildWithLaws`).

### 16. Unir superficies en un sólido

**Qué es:** la solevación y el parche ya crean superficies sin espesor. Falta coserlas y, si cierran un volumen, convertirlas en sólido.

**Cómo implementarla**
- `BRepBuilderAPI_Sewing` (disponible en la app) con las caras elegidas y una tolerancia (0,01 mm por defecto).
- Si la cáscara resultante es cerrada, `BRepBuilderAPI_MakeSolid` y `BRepLib.OrientClosedSolid`, como hace la importación de STL en [`src/kernel/features/import.ts`](src/kernel/features/import.ts).
- Si quedan bordes abiertos, mostrarlos resaltados para que se vea dónde falta cerrar.

### 17. Desfase y engrosado de caras

**Qué es:** dar espesor a cualquier superficie o cara elegida, y desfasar caras de un sólido.

**Cómo implementarla**
- `thickenSheet` de [`src/kernel/features/surface.ts`](src/kernel/features/surface.ts) ya lo hace para el parche y la solevación. Falta una feature "Engrosar" que tome caras elegidas.
- Opciones: hacia un lado, hacia el otro o simétrico (dos engrosados de medio espesor unidos).

---

## Imprimir y exportar

### 18. Orientar para imprimir

**Qué es:** elegir una cara y que la pieza quede apoyada en la cama por esa cara.

**Cómo implementarla**
- Calcular la rotación que lleva la normal de la cara a `-Z` y la traslación que deja esa cara en z = 0.
- Aplicarla como una feature "Mover" que ya existe ([`src/kernel/features/bodies.ts`](src/kernel/features/bodies.ts)), o solo al exportar si no se quiere tocar el modelo.
- Extra: sugerir la orientación con menos voladizo probando las caras planas más grandes.

### 19. Partir la pieza con encastres

**Qué es:** cortar una pieza más grande que la cama y agregar pernos y agujeros para alinear las mitades.

**Cómo implementarla**
- "Dividir" ya corta con un plano. Agregar al panel: cantidad y diámetro de pernos.
- Sobre la cara de corte, repartir puntos (centro de la cara y simetrías), sumar cilindros a una mitad y restarlos a la otra con la holgura de la función 4.
- Alternativa más simple: solo agujeros en las dos mitades, para usar pernos o trozos de filamento.

### 20. Exportar por cuerpo y con colores

**Qué es:** exportar cada cuerpo en su archivo, o un 3MF con cuerpos de distinto color para multimaterial.

**Cómo implementarla**
- `to3MF` en [`src/kernel/export/meshExport.ts`](src/kernel/export/meshExport.ts) ya recibe una malla por cuerpo. Agregar la extensión de materiales del formato (`<basematerials>` y `pid` en cada objeto).
- Color por cuerpo guardado en el documento (un mapa `FaceRef → color`).
- En el diálogo de exportación, casillas por cuerpo y la opción "un archivo por cuerpo" (un zip con `fflate`, que ya está instalado).

---

## Documentar y organizar

### 21. Plano 2D con cotas

**Qué es:** vistas de frente, de arriba y de costado, con cotas, exportadas a PDF o SVG.

**Cómo implementarla**
- OCCT tiene `HLRBRep_Algo` para obtener las aristas visibles y ocultas proyectadas, y replicad lo expone como `drawProjection`. Las dos cosas están disponibles en la app (lo verifiqué).
- Convertir esas aristas a SVG, agregar cotas automáticas de las medidas generales y permitir cotas manuales entre puntos.
- Exportar SVG directo; para PDF, imprimir el SVG desde el navegador.

**Atención:** el plano en sí es rápido de sacar; lo largo es el editor de cotas.

### 22. Ensamble simple

**Qué es:** traer varias piezas guardadas, ubicarlas una contra otra y revisar si chocan.

**Cómo implementarla**
- Un tipo de documento nuevo que referencia archivos `.cad.json` y guarda una posición por pieza.
- Cada pieza se calcula con su propio motor de recálculo y se muestra con su transformación.
- Interferencias: `BRepAlgoAPI_Common` entre pares, como ya hace la comprobación de cuerpos superpuestos en [`src/kernel/features/check.ts`](src/kernel/features/check.ts).
- Empezar con ubicación manual (los manipuladores de mover ya existen) y dejar las restricciones entre piezas para después.

### 23. Configuraciones

**Qué es:** variantes de una misma pieza con distintos valores de parámetros (tamaño S, M y L).

**Cómo implementarla**
- Una tabla en el documento: filas = configuraciones, columnas = parámetros con nombre.
- Elegir una configuración reemplaza los valores antes de `evaluateDocument` en [`src/document/evaluate.ts`](src/document/evaluate.ts). El resto del sistema no cambia.
- Exportar todas de una vez, una por archivo.

### 24. Reparar referencias perdidas

**Qué es:** cuando una feature queda en error porque perdió su cara o arista, poder reasignarla con un clic en lugar de borrarla y rehacerla.

**Cómo implementarla**
- El modo de elegir referencias ya existe (`beginPick`). Falta ofrecerlo desde el error: un botón "Reasignar…" junto al mensaje en el historial.
- Mostrar dónde estaba la referencia perdida: la huella geométrica guarda el centro (`FaceRef.center`), así que se puede dibujar un marcador en ese punto.
- Sugerir la cara o arista más parecida (más cercana y del mismo tipo) como primera opción.

### 25. Publicar como página web

**Qué es:** que la app se abra desde una dirección, sin instalar Node ni correr comandos.

**Cómo implementarla**
- `npm run build` ya genera una versión estática en `dist/`.
- GitHub Pages: un flujo de GitHub Actions que construya y publique en cada push. Hay que poner `base` en [`vite.config.ts`](vite.config.ts) con el nombre del repositorio.
- El repositorio es privado: Pages en repos privados requiere un plan pago de GitHub. Las alternativas gratuitas son hacer público el repositorio o usar Netlify o Cloudflare Pages.

**Atención:** los archivos WASM de OpenCascade pesan varios megas; conviene activar compresión y cache en el servidor.

---

## Por dónde empezar

Si el objetivo es imprimir mejor, el orden que recomiendo es:

1. **Vista en corte (1), voladizos (2) y orientar para imprimir (18).** Son tres funciones cortas que cambian el uso diario.
2. **Ocultar cuerpos (5) y operar sobre un cuerpo elegido (6).** Destraban las piezas de varios cuerpos.
3. **Proyectar aristas (7) y cotas que faltan (8).** Hacen el sketch mucho más cómodo.
4. **Holguras (4) y partir con encastres (19).** Son las específicas de impresión 3D.

Las de esfuerzo L (envolver, desborde del redondeo, plano 2D, ensamble) conviene encararlas de a una y con un caso real en la mano.
