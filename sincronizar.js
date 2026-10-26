// Sincronizar: se tiran todos los crudos (pantalla, cámara y audio) en una secuencia y se toca un botón.
// El panel escucha el audio de cada archivo (medios.js), encuentra cuáles se grabaron a la vez
// (sincro.js) y rearma la secuencia con las tomas una detrás de otra, en el orden en que se grabaron:
//   V1 pantalla · V2 cámara · A1 el audio bueno (grabador) · abajo los audios de cámara y pantalla, muteados.
// Antes de tocar nada guarda una copia de la secuencia tal como estaba.

const ppro = panel.ppro;
const p = panel.premiere;
const TPS = 254016000000; // ticks por segundo
const HUECO = 2; // segundos entre una toma y la siguiente
const MAX_ACCIONES = 40; // Premiere no acepta más de ~50 acciones por transacción
const IMAGENES = /\.(png|jpe?g|psd|tiff?|gif|bmp|tga|ai|eps|svg|webp|heic|exr|dpx)$/i;
const NOMBRES = { pantalla: "Pantalla", camara: "Cámara", audio: "Audio" };

let estado = null; // renglón de progreso adentro de la caja
let cancelar = false;

function avisar(texto) {
  if (estado) estado.textContent = texto;
}

function revisarCancelado() {
  if (cancelar) throw new Error("Cancelado. No toqué la secuencia.");
}

const minutos = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const nombreDe = (ruta) => {
  const nombre = String(ruta).split(/[\\/]/).pop();
  return typeof nombre.normalize === "function" ? nombre.normalize("NFC") : nombre;
};

function enTandas(proyecto, nombre, armadores) {
  for (let i = 0; i < armadores.length; i += MAX_ACCIONES) {
    const tanda = armadores.slice(i, i + MAX_ACCIONES);
    const ok = p.transaccion(proyecto, nombre, (c) => {
      for (const armar of tanda) c.addAction(armar());
    });
    if (!ok) throw new Error(`Premiere no aceptó "${nombre}".`);
  }
}

async function itemsDe(secuencia, video) {
  const tipo = ppro.Constants.TrackItemType.CLIP;
  const total = video ? await secuencia.getVideoTrackCount() : await secuencia.getAudioTrackCount();
  const lista = [];
  for (let i = 0; i < total; i++) {
    const pista = video ? await secuencia.getVideoTrack(i) : await secuencia.getAudioTrack(i);
    for (const item of await pista.getTrackItems(tipo, false)) lista.push({ item, pista: i, video });
  }
  return lista;
}

async function rutaDe(item) {
  try {
    const projectItem = await item.getProjectItem();
    const clip = ppro.ClipProjectItem.cast(projectItem);
    return { projectItem, clip, ruta: clip ? await clip.getMediaFilePath() : "" };
  } catch (error) {
    return { projectItem: null, clip: null, ruta: "" };
  }
}

// Archivos que hay en la secuencia, cada uno una vez aunque tenga video y audio en pistas distintas.
async function archivosDeLaSecuencia(secuencia) {
  const porRuta = new Map();
  let otros = 0;
  for (const { item, video } of [...(await itemsDe(secuencia, true)), ...(await itemsDe(secuencia, false))]) {
    const { projectItem, clip, ruta } = await rutaDe(item);
    if (!ruta || IMAGENES.test(ruta)) {
      otros++;
      continue;
    }
    // I:\My Drive\... y /Users/.../My Drive/... son el mismo archivo. Se abre con la ruta
    // que dio Premiere: no se inventa la de la otra compu.
    const clave = p.claveDeRuta(ruta);
    if (!porRuta.has(clave)) porRuta.set(clave, { ruta, projectItem, clip, items: [], conVideo: false, duracion: 0 });
    const a = porRuta.get(clave);
    a.items.push(item);
    if (video) a.conVideo = true;
    a.duracion = Math.max(a.duracion, (await item.getDuration()).seconds);
  }
  return { archivos: [...porRuta.values()], otros };
}

// Lee el audio de cada archivo. Los que no se pueden leer igual se ubican, al final.
async function escuchar(archivos) {
  const lecturas = [];
  for (let k = 0; k < archivos.length; k++) {
    revisarCancelado();
    const a = archivos[k];
    const nombre = nombreDe(a.ruta);
    const prefijo = `Escuchando ${k + 1} de ${archivos.length}: ${nombre}`;
    avisar(prefijo);
    try {
      const l = await panel.medios.leerAudio(a.ruta, (f) => {
        revisarCancelado();
        avisar(`${prefijo} (${Math.round(f * 100)} %)`);
      });
      lecturas.push(Object.assign(l, { archivo: a }));
    } catch (error) {
      if (cancelar) throw error;
      panel.log(`No pude escuchar ${nombre}: ${error.message}. Va al final, sin sincronizar.`, "error");
      lecturas.push({ ruta: a.ruta, nombre, carpeta: "", fecha: 0, video: null, huella: null, marcas: [], inicioAudio: 0, duracion: 0, archivo: a, sinLeer: true });
    }
  }
  return lecturas;
}

// Arma la lista de clips para sincro.js. Los que no se pudieron leer se suman al aparato que corresponda.
function armarClips(lecturas) {
  const leidas = lecturas.filter((l) => !l.sinLeer);
  panel.sincro.clasificar(leidas);
  for (const l of lecturas.filter((x) => x.sinLeer)) {
    l.categoria = l.archivo.conVideo ? "camara" : "audio";
    const vecino = leidas.find((x) => x.categoria === l.categoria);
    l.aparato = vecino ? vecino.aparato : `sin-leer|${l.categoria}`;
  }
  return lecturas.map((l) => ({
    nombre: l.nombre,
    aparato: l.aparato,
    categoria: l.categoria,
    rasgo: l.huella ? panel.sincro.prepararRasgo(l.huella) : null,
    inicioAudio: l.inicioAudio,
    duracion: Math.max(l.video && l.video.duracion ? l.video.duracion : 0, l.inicioAudio + l.duracion, l.archivo.duracion),
    fecha: l.fecha,
    sinLeer: !!l.sinLeer,
    archivo: l.archivo,
  }));
}

// Dónde va cada clip (en segundos): tomas una detrás de otra (las que no se pudieron leer, al final).
// El video solo puede arrancar justo en un cuadro. Para que la boca quede exacta con la voz, la toma
// entera se corre lo justo para que su cámara principal (la más larga) caiga en un cuadro. El audio del
// grabador queda entre cuadros, exacto; los otros videos de la toma se redondean al cuadro más cercano.
function ubicar(clips, tomas, segundosPorCuadro) {
  const orden = [...tomas.filter((t) => !clips[t.clips[0].i].sinLeer), ...tomas.filter((t) => clips[t.clips[0].i].sinLeer)];
  const inicioDe = new Map();
  let cursor = 0;
  for (const toma of orden) {
    for (const c of toma.clips) inicioDe.set(c.i, cursor + c.inicio);
    cursor += toma.duracion + HUECO;
    const largo = (a, b) => clips[b.i].duracion - clips[a.i].duracion;
    const videos = toma.clips.filter((c) => clips[c.i].categoria !== "audio");
    const principal = videos.filter((c) => clips[c.i].categoria === "camara").sort(largo)[0] || videos.sort(largo)[0];
    if (!principal) continue;
    const t = inicioDe.get(principal.i);
    const corrimiento = Math.round(t / segundosPorCuadro) * segundosPorCuadro - t;
    for (const c of toma.clips) inicioDe.set(c.i, inicioDe.get(c.i) + corrimiento);
  }
  // Si algo quedó antes del cero, se corre todo una cantidad entera de cuadros.
  const minimo = Math.min(...inicioDe.values());
  if (minimo < 0) {
    const cuadros = Math.ceil(-minimo / segundosPorCuadro) * segundosPorCuadro;
    for (const [i, t] of inicioDe) inicioDe.set(i, t + cuadros);
  }
  return { orden, inicioDe };
}

// Carriles de una categoría: los clips que se pisan en el tiempo (dos cámaras a la vez) van en
// carriles distintos; si no, todos en uno. Cada carril es una pista de video y una (o más) de audio.
function carriles(clips, inicioDe, categoria) {
  const lista = [...inicioDe.keys()].filter((i) => clips[i].categoria === categoria).sort((a, b) => inicioDe.get(a) - inicioDe.get(b));
  const fines = [];
  const resultado = [];
  for (const i of lista) {
    let k = fines.findIndex((fin) => fin <= inicioDe.get(i) + 0.001);
    if (k < 0) {
      k = fines.length;
      resultado.push([]);
    }
    fines[k] = inicioDe.get(i) + clips[i].duracion;
    resultado[k].push(i);
  }
  return resultado;
}

// Pistas de audio donde quedaron los clips de estos archivos (un clip estéreo usa 1, uno de 2 mono usa 2).
async function pistasDeAudioDe(secuencia, rutas) {
  const usadas = new Set();
  for (const { item, pista } of await itemsDe(secuencia, false)) {
    const { ruta } = await rutaDe(item);
    if (rutas.has(p.claveDeRuta(ruta))) usadas.add(pista);
  }
  return [...usadas];
}

async function sincronizar() {
  const ctx = await p.contexto();
  if (!ctx) return;
  const editor = ppro.SequenceEditor.getEditor(ctx.secuencia);
  const cuadro = Number(await ctx.secuencia.getTimebase()); // ticks por cuadro

  avisar("Buscando los crudos en la secuencia…");
  const { archivos, otros } = await archivosDeLaSecuencia(ctx.secuencia);
  if (archivos.length < 2) {
    panel.log("Tirá todos los crudos (pantalla, cámara y audio) en la secuencia y volvé a tocar.", "error");
    return;
  }

  const lecturas = await escuchar(archivos);
  const clips = armarClips(lecturas);
  avisar("Comparando los audios…");
  const pares = await panel.sincro.compararTodos(clips, (f) => {
    revisarCancelado();
    avisar(`Comparando los audios… ${Math.round(f * 100)} %`);
  });
  const { tomas, avisos } = panel.sincro.armarTomas(clips, pares);
  const { orden, inicioDe } = ubicar(clips, tomas, cuadro / TPS);
  revisarCancelado();
  if (!orden.some((t) => t.clips.length > 1)) {
    panel.log("No encontré archivos que se hayan grabado a la vez (¿tienen audio?). No cambié nada.", "error");
    avisar("");
    return;
  }

  // De acá en adelante se toca la secuencia. Primero, la copia.
  avisar("Guardando una copia de la secuencia…");
  enTandas(ctx.proyecto, "Sincronizar: copia de la secuencia", [() => ctx.secuencia.createCloneAction()]);

  avisar("Acomodando…");
  let sacados = false;
  ppro.TrackItemSelection.createEmptySelection((seleccion) => {
    for (const a of archivos) for (const item of a.items) seleccion.addItem(item, true);
    sacados = p.transaccion(ctx.proyecto, "Sincronizar: sacar los crudos", (c) =>
      c.addAction(editor.createRemoveItemsAction(seleccion, false, ppro.Constants.MediaType.ANY, false))
    );
  });
  if (!sacados) throw new Error("Premiere no me dejó sacar los clips para reacomodarlos. No cambié nada más.");

  // Sin puntos de entrada/salida: cada clip entra entero, desde su primer cuadro.
  enTandas(ctx.proyecto, "Sincronizar: clips enteros", archivos.map((a) => () => a.clip.createClearInOutPointsAction()));

  // Pistas de video: pantalla abajo, cámara arriba. Audio: grabador, después cámara, después pantalla.
  const carrilesDe = {};
  for (const cat of ["pantalla", "camara", "audio"]) {
    carrilesDe[cat] = carriles(clips, inicioDe, cat).map((lista) => ({ lista, video: -1, audio: [] }));
  }
  let pistaVideo = 0;
  for (const cat of ["pantalla", "camara"]) for (const carril of carrilesDe[cat]) carril.video = pistaVideo++;
  let pistaAudio = 0;
  const nombresVideo = [];
  const nombresAudio = [];
  for (const cat of ["audio", "camara", "pantalla"]) {
    for (const [k, carril] of carrilesDe[cat].entries()) {
      const desde = pistaAudio;
      avisar(`Acomodando: ${NOMBRES[cat].toLowerCase()}…`);
      enTandas(ctx.proyecto, `Sincronizar: ${NOMBRES[cat]}`, carril.lista.map((i) => () => {
        const segundos = inicioDe.get(i);
        // El video cae justo en un cuadro; el audio solo puede quedar entre cuadros (más preciso).
        const ticks = carril.video >= 0 ? Math.round((segundos * TPS) / cuadro) * cuadro : Math.round(segundos * TPS);
        return editor.createOverwriteItemAction(clips[i].archivo.projectItem, ppro.TickTime.createWithTicks(String(ticks)), carril.video, desde);
      }));
      // Un clip estéreo usa una pista de audio; uno con dos canales mono usa dos: se mira dónde quedó.
      carril.audio = await pistasDeAudioDe(ctx.secuencia, new Set(carril.lista.map((i) => p.claveDeRuta(clips[i].archivo.ruta))));
      if (carril.audio.length) pistaAudio = Math.max(...carril.audio) + 1;
      const n = carrilesDe[cat].length > 1 ? ` ${k + 1}` : "";
      if (carril.video >= 0) nombresVideo[carril.video] = `${NOMBRES[cat]}${n}`;
      for (const a of carril.audio) nombresAudio[a] = cat === "audio" ? `Audio${n}` : `Audio ${NOMBRES[cat].toLowerCase()}${n}`;
    }
  }

  // Si hay audio bueno, los audios de cámara y pantalla quedan muteados (se usan solo de referencia).
  const hayGrabador = clips.some((c) => c.categoria === "audio" && !c.sinLeer);
  if (hayGrabador) {
    for (const carril of [...carrilesDe.camara, ...carrilesDe.pantalla]) {
      for (const a of carril.audio) await (await ctx.secuencia.getAudioTrack(a)).setMute(true);
    }
  }
  try {
    const nombrar = [];
    for (const [i, n] of nombresVideo.entries()) if (n) nombrar.push(async () => (await ctx.secuencia.getVideoTrack(i)).createSetNameAction(n));
    for (const [i, n] of nombresAudio.entries()) if (n) nombrar.push(async () => (await ctx.secuencia.getAudioTrack(i)).createSetNameAction(n));
    const acciones = await Promise.all(nombrar.map((f) => f()));
    enTandas(ctx.proyecto, "Sincronizar: nombres de pistas", acciones.map((a) => () => a));
  } catch (error) {
    // Los nombres son de adorno: si Premiere no deja, se sigue igual.
  }

  // Resumen
  const sincronizadas = orden.filter((t) => t.clips.length > 1);
  const solos = orden.filter((t) => t.clips.length === 1 && !clips[t.clips[0].i].sinLeer).map((t) => clips[t.clips[0].i].nombre);
  const total = orden.reduce((s, t) => s + t.duracion, 0) + HUECO * Math.max(0, orden.length - 1);
  panel.log(`Listo: ${sincronizadas.length} toma${sincronizadas.length === 1 ? "" : "s"} sincronizada${sincronizadas.length === 1 ? "" : "s"} con ${archivos.length} archivos (${minutos(total)}). La secuencia original quedó copiada en el proyecto.`, "ok");
  if (solos.length) panel.log(`Sin pareja (quedaron solos, en su lugar por hora): ${solos.join(", ")}.`);
  if (!hayGrabador) panel.log("No encontré audio de grabador: dejé sonando el de cámara y pantalla.");
  const sinGrabador = sincronizadas
    .filter((t) => !t.clips.some((c) => clips[c.i].categoria === "audio"))
    .map((t) => minutos(Math.min(...t.clips.map((c) => inicioDe.get(c.i)))));
  if (hayGrabador && sinGrabador.length) panel.log(`La toma que arranca en ${sinGrabador.join(", ")} no tiene audio de grabador: ahí desmuteá el audio de cámara.`, "error");
  if (otros) panel.log(`Había ${otros} clip${otros === 1 ? "" : "s"} que no son crudos (gráficos, imágenes): no los moví.`);
  for (const aviso of avisos) panel.log(aviso);
  avisar(`Listo. ${sincronizadas.length} toma${sincronizadas.length === 1 ? "" : "s"} en orden.`);
}

panel.sincronizar = sincronizar;

panel.registrar({
  nombre: "Sincronizar",
  descripcion: "Tirá todos los crudos (pantalla, cámara y audio) en una secuencia y tocá el botón: arma las tomas en orden, sincronizadas por el audio. Antes guarda una copia de la secuencia.",

  dibujar(caja) {
    const fila = document.createElement("div");
    fila.className = "colores";
    const boton = document.createElement("div");
    boton.className = "boton-color";
    boton.textContent = "Sincronizar todo";
    boton.style.backgroundColor = "#212047";
    boton.style.borderColor = "#e58fb0";
    let trabajando = false;
    boton.addEventListener("click", async () => {
      if (trabajando) {
        cancelar = true;
        avisar("Cancelando…");
        return;
      }
      trabajando = true;
      cancelar = false;
      boton.classList.add("trabajando");
      boton.textContent = "Sincronizando… (tocá para cancelar)";
      try {
        await sincronizar();
      } catch (error) {
        panel.log(`Sincronizar: ${error.message}`, "error");
        avisar("");
      } finally {
        trabajando = false;
        boton.classList.remove("trabajando");
        boton.textContent = "Sincronizar todo";
      }
    });
    fila.appendChild(boton);
    caja.appendChild(fila);
    estado = document.createElement("p");
    estado.textContent = "";
    caja.appendChild(estado);
  },
});
