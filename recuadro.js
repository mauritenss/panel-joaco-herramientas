// Recuadro: pone un rectángulo redondeado a la medida exacta del texto seleccionado, detrás de él,
// con su misma duración. No anima nada: ni el recuadro ni el texto tienen entrada ni salida.
//
// Cómo mide: apaga un instante las otras pistas de video, exporta un cuadro solo con el texto
// y busca dónde hay píxeles. Con eso dibuja el recuadro (una imagen TGA con transparencia del
// tamaño del cuadro), la guarda en "Recuadros Joaco" al lado del proyecto, la importa y la pega
// en la pista de abajo. Nunca corre ni pisa clips: si abajo no hay lugar, sube el texto.

const ppro = panel.ppro;
const p = panel.premiere;
const uxp = require("uxp");

// Colores provisorios: los definitivos los pasa Mauro.
const ESTILOS = [
  { id: "naranja", nombre: "Naranja", relleno: "#C53A0E", borde: "#E88A6A" },
  { id: "azul", nombre: "Azul", relleno: "#212047", borde: "#D9A0B4" },
];

// Márgenes y forma, en proporción al alto del texto medido.
const MARGEN_X = 0.5;
const MARGEN_Y = 0.28;

// Tamaño de texto y recuadro juntos, en %. Se recuerda entre sesiones.
const TAMANIO_MIN = 50;
const TAMANIO_MAX = 120;
const TAMANIO_PASO = 5;
const CLAVE_TAMANIO = "panelJoaco.recuadro.tamanio";

function leerTamanio() {
  try {
    const n = Number(window.localStorage.getItem(CLAVE_TAMANIO));
    return n >= TAMANIO_MIN && n <= TAMANIO_MAX ? n : 100;
  } catch (error) {
    return 100;
  }
}

function guardarTamanio(n) {
  try {
    window.localStorage.setItem(CLAVE_TAMANIO, String(n));
  } catch (error) { /* sin memoria: vuelve a 100 la próxima vez */ }
}

let tamanio = leerTamanio();
const PASO_MEDIDA = 0.01; // cada toque de Ancho o Alto suma o resta este % del cuadro
const REDONDEO = 0.28; // radio = esta fracción del alto del recuadro
const BORDE = 1 / 540; // grosor del borde = esta fracción del ancho del cuadro

const CARPETA = "Recuadros Joaco";

async function clipsDePista(secuencia, indice) {
  const pista = await secuencia.getVideoTrack(indice);
  const items = await pista.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
  const lista = [];
  for (const item of items) {
    lista.push({ item, inicio: (await item.getStartTime()).seconds, fin: (await item.getEndTime()).seconds });
  }
  return lista;
}

async function pistaLibre(secuencia, indice, desde, hasta) {
  const clips = await clipsDePista(secuencia, indice);
  return !clips.some((c) => c.inicio < hasta - 0.001 && c.fin > desde + 0.001);
}

function quitar(proyecto, editor, item) {
  // La selección solo es válida dentro del callback.
  ppro.TrackItemSelection.createEmptySelection((seleccion) => {
    seleccion.addItem(item);
    p.transaccion(proyecto, "Recuadro: quitar", (c) =>
      c.addAction(editor.createRemoveItemsAction(seleccion, false, ppro.Constants.MediaType.VIDEO, false))
    );
  });
}

// Copia el texto a otra pista (misma hora, pisando solo espacio vacío) y borra el original.
async function moverDePista(proyecto, editor, secuencia, item, salto) {
  const inicio = (await item.getStartTime()).seconds;
  const destino = (await item.getTrackIndex()) + salto;
  p.transaccion(proyecto, "Recuadro: subir texto", (c) =>
    c.addAction(editor.createCloneTrackItemAction(item, ppro.TickTime.createWithSeconds(0), salto, 0, true, false))
  );
  quitar(proyecto, editor, item);
  const nuevo = (await clipsDePista(secuencia, destino)).find((c) => Math.abs(c.inicio - inicio) < 0.001);
  return nuevo ? nuevo.item : null;
}

async function tamanioCuadro(secuencia) {
  const rect = await (await secuencia.getSettings()).getVideoFrameRect();
  return { ancho: Math.round(rect.width), alto: Math.round(rect.height) };
}

// Exporta un cuadro con solo la pista del texto encendida y mide dónde está el texto.
async function medirTexto(secuencia, texto, cuadro) {
  const pistaTexto = await texto.getTrackIndex();
  const inicio = (await texto.getStartTime()).seconds;
  const fin = (await texto.getEndTime()).seconds;
  const momento = ppro.TickTime.createWithSeconds(inicio + (fin - inicio) * 0.6);

  const total = await secuencia.getVideoTrackCount();
  const estados = [];
  for (let i = 0; i < total; i++) {
    const pista = await secuencia.getVideoTrack(i);
    estados.push({ pista, apagada: await pista.isMuted() });
  }

  const datos = await uxp.storage.localFileSystem.getDataFolder();
  const escala = 2;
  const base = `medida-${Date.now()}.bmp`;
  const esperar = (ms) => new Promise((listo) => setTimeout(listo, ms));
  let bytes = null;
  let archivo = null;
  try {
    for (let i = 0; i < total; i++) await estados[i].pista.setMute(i !== pistaTexto);
    // Apagar una pista tarda un instante en llegar al render (probado: sin pausa sale el video).
    await esperar(700);
    const ok = await ppro.Exporter.exportSequenceFrame(
      secuencia, momento, base, datos.nativePath,
      Math.round(cuadro.ancho / escala), Math.round(cuadro.alto / escala)
    );
    if (!ok) throw new Error("Premiere no pudo exportar el cuadro para medir el texto.");

    // Premiere le agrega la extensión otra vez ("x.bmp.bmp") y termina de escribir un rato después
    // de avisar que exportó: se reintenta la lectura hasta 5 s.
    for (let intento = 0; intento < 25 && !bytes; intento++) {
      for (const nombre of [`${base}.bmp`, base]) {
        try {
          archivo = await datos.getEntry(nombre);
          bytes = await archivo.read({ format: uxp.storage.formats.binary });
          break;
        } catch (error) {
          bytes = null;
        }
      }
      if (!bytes) await esperar(200);
    }
  } finally {
    for (const e of estados) await e.pista.setMute(e.apagada);
  }
  if (!bytes) throw new Error("No pude leer el cuadro exportado.");
  const imagen = panel.dibujo.leerBMP(bytes);
  const caja = panel.dibujo.cajaDelTexto(imagen);
  const lineas = caja ? panel.dibujo.renglonesDelTexto(imagen, caja) : { renglones: 1, alto: 0 };
  try { await archivo.delete(); } catch (error) { /* no importa */ }
  if (!caja) return null;
  return { x: caja.x * escala, y: caja.y * escala, ancho: caja.ancho * escala, alto: caja.alto * escala, renglones: lineas.renglones, altoRenglon: lineas.alto * escala };
}

async function carpetaRecuadros(proyecto) {
  const rutaProyecto = proyecto.path.replace(/^\\\\\?\\/, "");
  const carpetaProyecto = rutaProyecto.slice(0, Math.max(rutaProyecto.lastIndexOf("\\"), rutaProyecto.lastIndexOf("/")));
  const fs = uxp.storage.localFileSystem;
  const base = await fs.getEntryWithUrl(`file:/${carpetaProyecto.replace(/\\/g, "/")}`);
  try {
    return await base.getEntry(CARPETA);
  } catch (error) {
    return await base.createFolder(CARPETA);
  }
}

async function binRecuadros(proyecto) {
  const raiz = await proyecto.getRootItem();
  const buscar = async () => (await raiz.getItems()).find((it) => it.name === CARPETA);
  let bin = await buscar();
  if (!bin) {
    p.transaccion(proyecto, "Recuadro: carpeta", (c) => c.addAction(raiz.createBinAction(CARPETA, false)));
    bin = await buscar();
  }
  return bin;
}

// Guarda el TGA, lo importa al bin y lo pega en [desde, hasta] en la pista (sin correr nada).
async function colocarImagen(proyecto, editor, secuencia, bytes, pista, desde, hasta, nombre) {
  const carpeta = await carpetaRecuadros(proyecto);
  const archivo = await carpeta.createFile(`${nombre}.tga`, { overwrite: true });
  await archivo.write(bytes.buffer, { format: uxp.storage.formats.binary });

  const bin = await binRecuadros(proyecto);
  await proyecto.importFiles([archivo.nativePath], true, bin);
  const item = (await ppro.FolderItem.cast(bin).getItems()).find((it) => it.name === `${nombre}.tga`);
  if (!item) throw new Error("No encontré la imagen del recuadro en el proyecto.");

  // Se fija la duración en el propio clip del proyecto, así al pegarlo no pisa nada de después.
  const clip = ppro.ClipProjectItem.cast(item);
  p.transaccion(proyecto, "Recuadro: duración", (c) =>
    c.addAction(clip.createSetInOutPointsAction(ppro.TickTime.createWithSeconds(0), ppro.TickTime.createWithSeconds(hasta - desde)))
  );
  p.transaccion(proyecto, "Recuadro: pegar", (c) =>
    c.addAction(editor.createOverwriteItemAction(item, ppro.TickTime.createWithSeconds(desde), pista, -1))
  );
  const puesto = (await clipsDePista(secuencia, pista)).find((c) => Math.abs(c.inicio - desde) < 0.001);
  if (!puesto) return null;
  // Al pegar queda un cuadro más corto: se estira hasta el final exacto del texto (ese tramo está libre).
  if (Math.abs(puesto.fin - hasta) > 0.001) {
    p.transaccion(proyecto, "Recuadro: final", (c) =>
      c.addAction(puesto.item.createSetEndAction(ppro.TickTime.createWithSeconds(hasta)))
    );
  }
  return puesto.item;
}

// Cambia la escala del clip por `factor` dejando quieto el punto `centro` (0 a 1 del cuadro):
// la escala crece desde el ancla del clip, así que se corre la posición para compensar.
async function escalarClip(proyecto, clip, factor, centro) {
  const cadena = await clip.getComponentChain();
  const movimiento = await p.buscarComponente(cadena, "AE.ADBE Motion");
  const posicion = movimiento.getParam(0);
  const escala = movimiento.getParam(1);
  if (posicion.isTimeVarying() || escala.isTimeVarying()) {
    throw new Error("El texto ya tiene keyframes de posición o escala: no se le cambia el tamaño.");
  }
  const actual = (await posicion.getStartValue()).value.value;
  const x = Array.isArray(actual) ? actual[0] : actual.x;
  const y = Array.isArray(actual) ? actual[1] : actual.y;
  const escalaActual = (await escala.getStartValue()).value.value;
  if (typeof x !== "number" || typeof y !== "number" || typeof escalaActual !== "number") {
    throw new Error("No pude leer la posición y la escala del clip.");
  }
  const nueva = escalaActual * factor;
  p.transaccion(proyecto, "Recuadro: tamaño", (c) => {
    c.addAction(escala.createSetValueAction(escala.createKeyframe(nueva)));
    c.addAction(
      posicion.createSetValueAction(
        posicion.createKeyframe(new ppro.PointF(centro.x + factor * (x - centro.x), centro.y + factor * (y - centro.y)))
      )
    );
  });
  const leida = (await escala.getStartValue()).value.value;
  if (Math.abs(leida - nueva) > 0.5) throw new Error("Premiere no aplicó el tamaño.");
}

const punto = (v) => (Array.isArray(v) ? { x: v[0], y: v[1] } : { x: v.x, y: v.y });

// Posición, ancla y escala del clip (valores fijos, sin keyframes).
async function leerMovimiento(clip) {
  const cadena = await clip.getComponentChain();
  const mov = await p.buscarComponente(cadena, "AE.ADBE Motion");
  const [pos, ancla, escala] = [mov.getParam(0), mov.getParam(5), mov.getParam(1)];
  if (pos.isTimeVarying() || ancla.isTimeVarying() || escala.isTimeVarying()) {
    throw new Error("El recuadro tiene keyframes de posición o escala: no se le cambia la medida.");
  }
  return {
    pos: punto((await pos.getStartValue()).value.value),
    ancla: punto((await ancla.getStartValue()).value.value),
    escala: (await escala.getStartValue()).value.value,
  };
}

// Deja posición y ancla en el mismo punto (el centro del recuadro): así la escala crece desde el centro.
async function ponerMovimiento(proyecto, clip, m) {
  const cadena = await clip.getComponentChain();
  const mov = await p.buscarComponente(cadena, "AE.ADBE Motion");
  const [pos, ancla, escala] = [mov.getParam(0), mov.getParam(5), mov.getParam(1)];
  p.transaccion(proyecto, "Recuadro: ancla", (c) => {
    c.addAction(ancla.createSetValueAction(ancla.createKeyframe(new ppro.PointF(m.ancla.x, m.ancla.y))));
    c.addAction(pos.createSetValueAction(pos.createKeyframe(new ppro.PointF(m.pos.x, m.pos.y))));
    if (typeof m.escala === "number" && m.escala !== 100) c.addAction(escala.createSetValueAction(escala.createKeyframe(m.escala)));
  });
}

// La medida del recuadro viaja en el nombre del archivo, así se puede cambiar después sin volver a medir.
const NOMBRE_RECUADRO = /^recuadro-([a-z]+)-\d+-x(-?\d+)-y(-?\d+)-w(\d+)-h(\d+)\.tga$/;

function dibujarRecuadro(cuadro, caja, estilo) {
  const radio = Math.min(caja.alto / 2, caja.alto * REDONDEO);
  const grosor = Math.max(1.5, cuadro.ancho * BORDE);
  return panel.dibujo.recuadroTGA(cuadro.ancho, cuadro.alto, caja, estilo.relleno, estilo.borde, radio, grosor);
}

function nombreRecuadro(estilo, caja) {
  return `recuadro-${estilo.id}-${Date.now()}-x${Math.round(caja.x)}-y${Math.round(caja.y)}-w${Math.round(caja.ancho)}-h${Math.round(caja.alto)}`;
}

// Cambia el ancho y el alto del recuadro seleccionado, desde su centro, redibujándolo (los bordes no se deforman).
// dAncho y dAlto van como fracción del cuadro (0.01 = 1%).
async function ajustarRecuadro(dAncho, dAlto) {
  const ctx = await p.contexto();
  if (!ctx) return;
  const { proyecto, secuencia } = ctx;
  const editor = ppro.SequenceEditor.getEditor(secuencia);

  let viejo = null;
  let datos = null;
  for (const clip of await p.clipsSeleccionados(secuencia)) {
    const item = await clip.getProjectItem();
    const m = NOMBRE_RECUADRO.exec(item.name || "");
    if (m) { viejo = clip; datos = m; break; }
  }
  if (!viejo) {
    panel.log("Seleccioná un recuadro hecho con este panel.", "error");
    return;
  }
  const estilo = ESTILOS.find((e) => e.id === datos[1]);
  if (!estilo) {
    panel.log("No reconozco el color de este recuadro.", "error");
    return;
  }
  const cuadro = await tamanioCuadro(secuencia);
  const ancho = Math.max(20, Number(datos[4]) + dAncho * cuadro.ancho);
  const alto = Math.max(20, Number(datos[5]) + dAlto * cuadro.alto);
  const centroX = Number(datos[2]) + Number(datos[4]) / 2;
  const centroY = Number(datos[3]) + Number(datos[5]) / 2;
  const caja = { x: centroX - ancho / 2, y: centroY - alto / 2, ancho, alto };

  const movimiento = await leerMovimiento(viejo);
  const desde = (await viejo.getStartTime()).seconds;
  const hasta = (await viejo.getEndTime()).seconds;
  const pista = await viejo.getTrackIndex();

  const bytes = dibujarRecuadro(cuadro, caja, estilo);
  quitar(proyecto, editor, viejo);
  const nuevo = await colocarImagen(proyecto, editor, secuencia, bytes, pista, desde, hasta, nombreRecuadro(estilo, caja));
  if (!nuevo) throw new Error("No encontré el recuadro después de redibujarlo.");
  await ponerMovimiento(proyecto, nuevo, movimiento);
  panel.log(`Recuadro: ${Math.round(ancho)} x ${Math.round(alto)} px.`, "ok");
}

async function recuadro(estilo) {
  const ctx = await p.contexto();
  if (!ctx) return;
  const { proyecto, secuencia } = ctx;
  const editor = ppro.SequenceEditor.getEditor(secuencia);

  const clips = await p.clipsSeleccionados(secuencia);
  if (clips.length !== 1) {
    panel.log("Seleccioná un solo subtítulo en la línea de tiempo.", "error");
    return;
  }
  let texto = clips[0];
  const desde = (await texto.getStartTime()).seconds;
  const hasta = (await texto.getEndTime()).seconds;
  const cuadro = await tamanioCuadro(secuencia);

  const medida = await medirTexto(secuencia, texto, cuadro);
  if (!medida) {
    panel.log("No encontré el texto en pantalla. ¿Está visible en ese momento?", "error");
    return;
  }

  // Los márgenes salen del alto de un renglón: con varios renglones el recuadro no se agranda de más.
  const altoRenglon = medida.altoRenglon;
  const margenX = altoRenglon * MARGEN_X;
  const margenY = altoRenglon * MARGEN_Y;
  const caja = {
    x: medida.x - margenX,
    y: medida.y - margenY,
    ancho: medida.ancho + margenX * 2,
    alto: medida.alto + margenY * 2,
  };
  const bytes = dibujarRecuadro(cuadro, caja, estilo);

  // Pista: la de abajo del texto si está libre; si no, se sube el texto a una libre.
  const pistaTexto = await texto.getTrackIndex();
  const totalPistas = await secuencia.getVideoTrackCount();
  let pistaRecuadro;
  if (pistaTexto >= 1 && (await pistaLibre(secuencia, pistaTexto - 1, desde, hasta))) {
    pistaRecuadro = pistaTexto - 1;
  } else {
    let arriba = pistaTexto + 1;
    while (arriba < totalPistas && !(await pistaLibre(secuencia, arriba, desde, hasta))) arriba++;
    if (arriba >= totalPistas) {
      panel.log("No hay una pista libre arriba del texto. Agregá una pista de video y probá de nuevo.", "error");
      return;
    }
    texto = await moverDePista(proyecto, editor, secuencia, texto, arriba - pistaTexto);
    if (!texto) throw new Error("No pude subir el texto de pista.");
    pistaRecuadro = pistaTexto;
  }

  const nombre = nombreRecuadro(estilo, caja);
  const puesto = await colocarImagen(proyecto, editor, secuencia, bytes, pistaRecuadro, desde, hasta, nombre);
  if (!puesto) throw new Error("No encontré el recuadro después de ponerlo.");

  const centro = { x: (caja.x + caja.ancho / 2) / cuadro.ancho, y: (caja.y + caja.alto / 2) / cuadro.alto };
  try {
    await ponerMovimiento(proyecto, puesto, { pos: centro, ancla: centro });
  } catch (error) {
    panel.log(`El recuadro quedó, pero sin el ancla en el centro: ${error.message}`, "error");
  }
  if (tamanio !== 100) {
    try {
      for (const clip of [puesto, texto]) await escalarClip(proyecto, clip, tamanio / 100, centro);
    } catch (error) {
      panel.log(`El recuadro quedó, pero sin cambiar el tamaño: ${error.message}`, "error");
      return { pistaRecuadro, desde, hasta, medida, caja };
    }
  }
  panel.log(`Recuadro ${estilo.nombre.toLowerCase()} listo en V${pistaRecuadro + 1} (tamaño ${tamanio}%).`, "ok");
  return { pistaRecuadro, desde, hasta, medida, caja };
}

panel.recuadro = recuadro;
panel.ajustarRecuadro = ajustarRecuadro;
panel.estilosRecuadro = ESTILOS;

panel.registrar({
  nombre: "Recuadro",
  descripcion: "Seleccioná el subtítulo y tocá un color. Tamaño achica o agranda texto y recuadro juntos; Ancho y Alto cambian el recuadro seleccionado.",

  dibujar(caja) {
    const fila = document.createElement("div");
    fila.className = "colores";
    for (const estilo of ESTILOS) {
      const boton = document.createElement("div");
      boton.className = "boton-color";
      boton.textContent = estilo.nombre;
      boton.style.backgroundColor = estilo.relleno;
      boton.style.borderColor = estilo.borde;
      boton.addEventListener("click", async () => {
        boton.classList.add("trabajando");
        try {
          await recuadro(estilo);
        } catch (error) {
          panel.log(`Error: ${error.message}`, "error");
        } finally {
          boton.classList.remove("trabajando");
        }
      });
      fila.appendChild(boton);
    }
    caja.appendChild(fila);

    const filaMedida = (nombre, menos, mas, mostrarValor) => {
      const filaX = document.createElement("div");
      filaX.style.display = "flex";
      filaX.style.alignItems = "center";
      filaX.style.marginTop = "4px";
      const etiqueta = document.createElement("div");
      etiqueta.textContent = nombre;
      etiqueta.style.width = "52px";
      const valor = document.createElement("div");
      valor.style.minWidth = "44px";
      valor.style.textAlign = "center";
      if (mostrarValor) valor.textContent = mostrarValor();
      const boton = (texto, accion) => {
        const b = document.createElement("div");
        b.textContent = texto;
        b.style.width = "28px";
        b.style.textAlign = "center";
        b.style.padding = "4px 0";
        b.style.border = "1px solid #4a4a4a";
        b.style.borderRadius = "4px";
        b.style.backgroundColor = "#2d2d2d";
        b.style.cursor = "pointer";
        b.addEventListener("click", async () => {
          try {
            await accion();
            if (mostrarValor) valor.textContent = mostrarValor();
          } catch (error) {
            panel.log(`Error: ${error.message}`, "error");
          }
        });
        return b;
      };
      filaX.append(etiqueta, boton("−", menos), valor, boton("+", mas));
      caja.appendChild(filaX);
    };

    const cambiarTamanio = (delta) => () => {
      tamanio = Math.min(TAMANIO_MAX, Math.max(TAMANIO_MIN, tamanio + delta));
      guardarTamanio(tamanio);
    };
    filaMedida("Tamaño", cambiarTamanio(-TAMANIO_PASO), cambiarTamanio(TAMANIO_PASO), () => `${tamanio}%`);
    filaMedida("Ancho", () => ajustarRecuadro(-PASO_MEDIDA, 0), () => ajustarRecuadro(PASO_MEDIDA, 0));
    filaMedida("Alto", () => ajustarRecuadro(0, -PASO_MEDIDA), () => ajustarRecuadro(0, PASO_MEDIDA));
  },
});
