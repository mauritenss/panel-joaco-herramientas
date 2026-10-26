// Funciones comunes para hablar con Premiere. Todas las herramientas las usan vía panel.premiere.
// Se carga primero (ver indice.json).

const ppro = panel.ppro;

// Rutas de Windows y de Mac. El XML de cortes sale de la PC
// (file://localhost/I%3a/My%20Drive/...). En la Mac el mismo archivo está en
// /Users/.../CloudStorage/GoogleDrive-.../My Drive, o "Mi unidad" si el Drive está en
// español, y las unidades compartidas en "Shared drives" o "Unidades compartidas".
// El pathurl que se escribe en Mac es file:///Users/... con espacios y tildes codificados.
// Los nombres se comparan en NFC: el disco de Mac suele guardar "Módulo" descompuesto (NFD)
// y el XML de Windows viene compuesto.
// Para saber si un clip es de la carpeta elegida no alcanza el principio de la ruta:
// en Windows empieza con I:\ y en la Mac con /Users/.../CloudStorage/.... Se compara
// desde "My Drive", "Mi unidad", "Shared drives" o "Unidades compartidas".

function normalizarTexto(s) {
  const t = String(s ?? "");
  return typeof t.normalize === "function" ? t.normalize("NFC") : t;
}

function decodificarSegmento(x) {
  try {
    return decodeURIComponent(x);
  } catch (error) {
    return x;
  }
}

// pathurl del XML (file://localhost/I%3a/... o file:///Users/...) → ruta del disco.
function rutaDeUrl(u) {
  let r = String(u).trim();
  // file:///Users → /Users (las dos barras del esquema se van, queda la de la ruta).
  // file://localhost/I%3a → /I%3a. file:/Users (forma corta de UXP) → /Users.
  if (/^file:\/\/localhost/i.test(r)) r = r.replace(/^file:\/\/localhost/i, "");
  else if (/^file:\/\//i.test(r)) r = r.replace(/^file:\/\//i, "");
  else if (/^file:/i.test(r)) r = r.replace(/^file:\/*/i, "/");
  r = r.split("/").map(decodificarSegmento).join("/");
  r = rutaSinPrefijo(r);
  if (/^\/[A-Za-z]:/.test(r)) r = r.slice(1).replace(/\//g, "\\");
  else if (/^[A-Za-z]:\//.test(r)) r = r.replace(/\//g, "\\");
  return r;
}

function esRutaWindows(r) {
  return /^[A-Za-z]:[\\/]/.test(r) || /^\\\\/.test(r);
}

// Premiere en Windows a veces devuelve \\?\C:\... (o \\?\UNC\servidor\...).
// Ese prefijo no es parte del archivo: el fs de UXP lo toma como una carpeta "?" y no lo encuentra.
function rutaSinPrefijo(ruta) {
  const r = String(ruta ?? "").trim();
  if (/^\\\\\?\\UNC\\/i.test(r)) return "\\\\" + r.slice(8);
  if (/^\/\/\?\/UNC\//i.test(r)) return "//" + r.slice(8);
  if (/^\\\\\?\\[A-Za-z]:[\\/]/.test(r)) return r.slice(4);
  if (/^\/\/\?\/[A-Za-z]:\//.test(r)) return r.slice(4);
  if (/^\/\?\/[A-Za-z]:\//.test(r)) return r.slice(3);
  return r;
}

// Ruta del disco → pathurl. Windows queda file://localhost/I%3a/... (como el XML de cortes).
// Mac queda file:///Users/... 
function urlDeRuta(r) {
  r = rutaSinPrefijo(r);
  const posix = String(r).replace(/\\/g, "/");
  const partes = posix.split("/");
  if (!esRutaWindows(r) && posix.startsWith("/")) {
    return "file:///" + partes.filter((x) => x !== "").map((x) => encodeURIComponent(x)).join("/");
  }
  const codificar = (x, i) => (i === 0 && /^[A-Za-z]:$/.test(x) ? x[0] + "%3a" : encodeURIComponent(x));
  return "file://localhost/" + partes.filter((x, i) => i > 0 || x).map(codificar).join("/");
}

// Variantes para require("fs") de UXP. En Mac se prueba primero file:/// con %20,
// porque "Application Support" y "My Drive" tienen espacios. En Windows se prueba
// primero la forma que ya andaba (file:/C:/...).
function urlsParaFs(ruta) {
  const cruda = /^file:/i.test(ruta) ? rutaDeUrl(ruta) : String(ruta);
  const nativa = rutaSinPrefijo(cruda);
  const posix = nativa.replace(/\\/g, "/");
  const esWin = /^[A-Za-z]:\//.test(posix);
  const partes = posix.split("/").filter((x) => x !== "");
  const codificada = partes.map((x, i) => (i === 0 && /^[A-Za-z]:$/.test(x) ? x[0] + "%3a" : encodeURIComponent(x))).join("/");
  const lista = [];
  if (esWin) {
    const vieja = "file:/" + posix;
    lista.push(vieja, encodeURI(vieja), "file:///" + codificada, "file://localhost/" + codificada);
  } else {
    const vieja = "file:" + (posix.startsWith("/") ? posix : "/" + posix);
    lista.push("file:///" + codificada, "file:///" + partes.join("/"), vieja, encodeURI(vieja));
  }
  lista.push(nativa);
  return [...new Set(lista)];
}

function unirRuta(carpeta, nombre) {
  const base = String(carpeta).replace(/[\\/]+$/, "");
  return base + (base.includes("\\") ? "\\" : "/") + nombre;
}

// Cada ancla es UN segmento (el espacio va adentro del nombre de la carpeta de Drive).
const ANCLAS_DRIVE = new Set(["my drive", "mi unidad", "shared drives", "unidades compartidas"]);

function segmentosDe(canon) {
  return String(canon || "").split("/").filter((x) => x !== "");
}

// file://, barras, %20, NFC, minúsculas y sin barra al final. Así se comparan.
function canonRuta(ruta) {
  let r = rutaSinPrefijo(String(ruta ?? "").trim());
  if (/^file:/i.test(r)) r = rutaDeUrl(r);
  r = r.replace(/\\/g, "/");
  if (/%[0-9A-Fa-f]{2}/.test(r)) r = r.split("/").map(decodificarSegmento).join("/");
  return normalizarTexto(r).replace(/\/+$/, "").toLowerCase();
}

// Desde "My Drive" (o la ancla que sea) hasta el archivo. Vacío si no está en Drive.
function colaDrive(canon) {
  const partes = segmentosDe(canon);
  const i = partes.findIndex((s) => ANCLAS_DRIVE.has(s));
  return i < 0 ? "" : partes.slice(i).join("/");
}

// Identidad del archivo: la cola de Drive, o la ruta entera si no es de Drive
// (así /tmp/a y C:\tmp\a no se toman por el mismo).
function claveDeRuta(ruta) {
  const c = canonRuta(ruta);
  return colaDrive(c) || c;
}

// ¿Este clip es de la carpeta del video elegida, aunque la ruta sea de la otra compu?
function esDeEstaCarpeta(ruta, carpeta) {
  const clip = canonRuta(ruta);
  const base = canonRuta(carpeta);
  if (!clip || !base) return false;
  if (clip === base || clip.startsWith(base + "/")) return true;
  const colaClip = colaDrive(clip);
  const colaBase = colaDrive(base);
  if (colaClip && colaBase && (colaClip === colaBase || colaClip.startsWith(colaBase + "/"))) return true;
  const nombre = segmentosDe(base).pop();
  return !!nombre && clip.includes("/" + nombre + "/cortes/livianos/");
}

// El archivo está de verdad adentro de la carpeta elegida (la de esta compu).
// Una ruta de Windows que solo se parece en el final no cuenta: no se la pasamos a Premiere.
function estaEnLaCarpeta(ruta, carpeta) {
  const clip = canonRuta(ruta);
  const base = canonRuta(carpeta);
  if (!clip || !base) return false;
  return clip === base || clip.startsWith(base + "/");
}

panel.premiere = {
  // Proyecto y secuencia abiertos. Devuelve null y avisa si falta alguno.
  async contexto() {
    const proyecto = await ppro.Project.getActiveProject();
    if (!proyecto) {
      panel.log("No hay ningún proyecto abierto.", "error");
      return null;
    }
    const secuencia = await proyecto.getActiveSequence();
    if (!secuencia) {
      panel.log("No hay ninguna secuencia abierta.", "error");
      return null;
    }
    return { proyecto, secuencia };
  },

  // Clips de video seleccionados en la línea de tiempo.
  async clipsSeleccionados(secuencia) {
    const seleccion = await secuencia.getSelection();
    const items = await seleccion.getTrackItems();
    return items.filter((item) => item instanceof ppro.VideoClipTrackItem);
  },

  // Duración de N cuadros según la secuencia, como TickTime.
  // getVideoFrameRate no existe en Premiere 26.0: ahí se usa getTimebase (ticks por cuadro).
  async cuadros(secuencia, cantidad) {
    const ajustes = await secuencia.getSettings();
    let fps;
    if (typeof ajustes.getVideoFrameRate === "function") {
      fps = ajustes.getVideoFrameRate().value;
    } else {
      fps = 254016000000 / Number(await secuencia.getTimebase());
    }
    return ppro.TickTime.createWithSeconds(cantidad / fps);
  },

  // Ejecuta un grupo de cambios en el proyecto. Devuelve true si Premiere lo aceptó.
  transaccion(proyecto, nombre, armar) {
    let ok = false;
    proyecto.lockedAccess(() => {
      ok = proyecto.executeTransaction((compuesta) => armar(compuesta), nombre);
    });
    return ok;
  },

  // Último componente de la cadena con ese nombre interno (matchName), o null.
  async buscarComponente(cadena, matchName) {
    let encontrado = null;
    const total = cadena.getComponentCount();
    for (let i = 0; i < total; i++) {
      const componente = cadena.getComponentAtIndex(i);
      if ((await componente.getMatchName()) === matchName) encontrado = componente;
    }
    return encontrado;
  },

  // Anima un parámetro: pares [TickTime, valor]. Reemplaza lo que haya en ese tramo
  // y respeta los keyframes que ya tenía el clip fuera de él.
  animar(proyecto, parametro, claves) {
    const t = panel.premiere;
    const desde = claves[0][0];
    const hasta = claves[claves.length - 1][0];
    const antes = parametro.isTimeVarying()
      ? parametro.getKeyframeListAsTickTimes().map((tiempo) => tiempo.ticks)
      : [];

    if (!parametro.isTimeVarying()) {
      t.transaccion(proyecto, "Activar animación", (c) =>
        c.addAction(parametro.createSetTimeVaryingAction(true))
      );
    } else {
      t.transaccion(proyecto, "Limpiar tramo", (c) =>
        c.addAction(parametro.createRemoveKeyframeRangeAction(desde, hasta))
      );
    }

    // Keyframes que Premiere agrega solo al activar la animación: se borran después.
    const sobrantes = parametro
      .getKeyframeListAsTickTimes()
      .filter((tiempo) => !antes.includes(tiempo.ticks));

    t.transaccion(proyecto, "Agregar keyframes", (c) => {
      for (const [tiempo, valor] of claves) {
        const clave = parametro.createKeyframe(valor);
        clave.position = tiempo;
        c.addAction(parametro.createAddKeyframeAction(clave));
      }
    });

    const nuestros = claves.map(([tiempo]) => tiempo.ticks);
    const aBorrar = sobrantes.filter((tiempo) => !nuestros.includes(tiempo.ticks));
    if (aBorrar.length) {
      t.transaccion(proyecto, "Quitar keyframes sobrantes", (c) => {
        for (const tiempo of aBorrar) c.addAction(parametro.createRemoveKeyframeAction(tiempo));
      });
    }

    t.transaccion(proyecto, "Suavizar keyframes", (c) => {
      for (const [tiempo] of claves) {
        c.addAction(
          parametro.createSetInterpolationAtKeyframeAction(
            tiempo,
            ppro.Constants.InterpolationMode.BEZIER
          )
        );
      }
    });
  },

  normalizarTexto,
  rutaDeUrl,
  urlDeRuta,
  rutaSinPrefijo,
  urlsParaFs,
  unirRuta,
  canonRuta,
  claveDeRuta,
  esDeEstaCarpeta,
  estaEnLaCarpeta,
};
