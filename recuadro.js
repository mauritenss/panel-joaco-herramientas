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
const MARGEN_X = 0.55;
const MARGEN_Y = 0.32;
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
  const renglones = caja ? panel.dibujo.renglonesDelTexto(imagen, caja) : 1;
  try { await archivo.delete(); } catch (error) { /* no importa */ }
  if (!caja) return null;
  return { x: caja.x * escala, y: caja.y * escala, ancho: caja.ancho * escala, alto: caja.alto * escala, renglones };
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
  const altoRenglon = medida.alto / medida.renglones;
  const margenX = altoRenglon * MARGEN_X;
  const margenY = altoRenglon * MARGEN_Y;
  const caja = {
    x: medida.x - margenX,
    y: medida.y - margenY,
    ancho: medida.ancho + margenX * 2,
    alto: medida.alto + margenY * 2,
  };
  const radio = Math.min(caja.alto / 2, caja.alto * REDONDEO);
  const grosor = Math.max(1.5, cuadro.ancho * BORDE);
  const bytes = panel.dibujo.recuadroTGA(cuadro.ancho, cuadro.alto, caja, estilo.relleno, estilo.borde, radio, grosor);

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

  const nombre = `recuadro-${estilo.id}-${Date.now()}`;
  const puesto = await colocarImagen(proyecto, editor, secuencia, bytes, pistaRecuadro, desde, hasta, nombre);
  if (!puesto) throw new Error("No encontré el recuadro después de ponerlo.");

  panel.log(`Recuadro ${estilo.nombre.toLowerCase()} listo en V${pistaRecuadro + 1}.`, "ok");
  return { pistaRecuadro, desde, hasta, medida, caja };
}

panel.recuadro = recuadro;
panel.estilosRecuadro = ESTILOS;

panel.registrar({
  nombre: "Recuadro",
  descripcion: "Seleccioná el subtítulo y tocá un color.",

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
  },
});
