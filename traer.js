// Traer video: abre en Premiere lo que dejó la herramienta de cortes, listo para editar.
//   "Traer video": Joaco elige la carpeta del video (la que tiene Crudos y Cortes), o Cortes, o
//     Cortes/Livianos. El panel sube hasta la carpeta del video, toma el XML de livianos más nuevo
//     (Cortes/Livianos/ultimo.json si está; si no, el vN más alto, sin mirar "viejos"), obliga a
//     Drive a bajar el XML y esos livianos, cambia las rutas a las de esta compu, lo importa en el
//     proyecto abierto y abre esa secuencia. Si ya estaba, la abre y no la duplica.
//   "Pasar a originales": cuando terminaron de bajar los crudos originales, revisa que estén todos y
//     completos, guarda una copia del proyecto y le engancha a cada clip su original como alta
//     resolución (attachProxy). Los livianos se ven agrandados; con el original se corrige la escala.
// El disco va por panel.disco (UXP en Premiere; las pruebas lo cambian por uno de Node).

const ppro = panel.ppro;
const p = panel.premiere;
const MAX_ACCIONES = 40;
const CLAVE_CARPETA = "traer-carpeta";
// "… - cortes vN (livianos).xml" o "… - cortes vN (Joaco) (livianos).xml".
const XML_LIVIANOS = / - cortes v(\d+)(?: \(Joaco\))? \(livianos\)\.xml$/i;
const SECUENCIA_CORTADO = / - Cortado(?: v\d+)?(?: \(livianos\))?$/i;
const CARPETAS = { secuencias: "Secuencias", pantalla: "Crudos", camara: "Cámara", audio: "Audio" };
const ESPERA_DRIVE_MS = 25000;
const TROZO_BAJADA = 1024 * 1024;

let estado = null;
const avisar = (texto) => {
  if (estado) estado.textContent = texto;
};
const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));

// ---------- Disco ----------

const rutaDeUrl = (u) => panel.premiere.rutaDeUrl(u);
const urlDeRuta = (r) => panel.premiere.urlDeRuta(r);
const plano = (s) => panel.premiere.normalizarTexto(s);
// file://... se pasa a ruta de disco antes de comparar. NFC: "Módulo" de Windows
// coincide con el mismo nombre descompuesto que guarda el disco de Mac.
const comoRuta = (ruta) => (/^file:/i.test(String(ruta || "")) ? rutaDeUrl(ruta) : String(ruta || ""));
const normal = (ruta) => plano(comoRuta(ruta)).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const enLivianos = (ruta) => /\/livianos\//.test(normal(ruta));
// Lo que viene después de ".../Livianos/" (por ejemplo "camara/1.camara.mp4").
const relativoLiviano = (ruta) => {
  const n = comoRuta(ruta).replace(/\\/g, "/");
  const i = n.toLowerCase().lastIndexOf("/livianos/");
  return i < 0 ? null : n.slice(i + "/livianos/".length);
};
const carpetaDe = (ruta) => ruta.replace(/[\\/][^\\/]*$/, "");

// archivos.json trae "archivo" relativo al contenido ("camara/a.mp4", "pantalla y audio/b.mp4").
// Si viene una ruta absoluta de Windows (I:\... o file://...), se queda con lo que está
// después de la carpeta del video elegida en esta compu, y si ahí adentro dice Crudos o
// Livianos, con lo que sigue: es el mismo camino en las dos carpetas.
function claveDeArchivo(archivo, carpetaVideo) {
  let r = String(archivo || "").trim();
  const eraUrl = /^file:/i.test(r);
  if (eraUrl) r = rutaDeUrl(r);
  r = plano(r).replace(/\\/g, "/");
  const absoluta = eraUrl || /^[A-Za-z]:\//.test(r) || r.startsWith("/");
  if (!absoluta) return r.replace(/^\/+/, "");
  const video = carpetaVideo ? plano(String(carpetaVideo)).replace(/\\/g, "/").split("/").filter(Boolean).pop() : "";
  if (video) {
    const marca = "/" + video.toLowerCase() + "/";
    const i = r.toLowerCase().lastIndexOf(marca);
    if (i >= 0) r = r.slice(i + marca.length);
  }
  // Después de la carpeta del video puede quedar "Crudos/camara/a.mp4" o
  // "Cortes/Livianos/camara/a.mp4". La clave es el camino de adentro, el mismo del liviano.
  const n = r.toLowerCase();
  for (const ancla of ["livianos/", "crudos/"]) {
    const conBarra = "/" + ancla;
    const i = n.lastIndexOf(conBarra);
    if (i >= 0) return r.slice(i + conBarra.length);
    if (n.startsWith(ancla)) return r.slice(ancla.length);
  }
  return r.replace(/^[A-Za-z]:\//, "").replace(/^\/+/, "");
}

// ---------- Carpeta del video y XML más nuevo ----------

function padreRuta(ruta) {
  const s = String(ruta || "").replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  if (i <= 0) return null;
  if (i === 2 && /^[A-Za-z]:/.test(s)) return null;
  return s.slice(0, i);
}

function nombreDeRuta(ruta) {
  return String(ruta || "").replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() || "";
}

// "viejos" es una carpeta, no parte del nombre de un archivo.
function enViejos(ruta) {
  return normal(ruta).split("/").includes("viejos");
}

function esEscalon(nombre) {
  const n = plano(nombre).toLowerCase();
  return n === "cortes" || n === "livianos" || n === "crudos" || n === "viejos" || /^livianos-/.test(n) || /^crudos-/.test(n);
}

// Hijos directos (en minúsculas) que se ven en las rutas de archivo.
function hijosDe(carpeta, rutas) {
  const base = normal(carpeta);
  const nombres = new Set();
  for (const r of rutas || []) {
    const n = normal(r);
    if (!n.startsWith(base + "/")) continue;
    const seg = n.slice(base.length + 1).split("/")[0];
    if (seg) nombres.add(seg);
  }
  return nombres;
}

// La carpeta del video tiene un hijo "Cortes", o (los zips) un Livianos y un Crudos.
// "livianos.mp4" no cuenta: el hijo tiene que llamarse Livianos o Livianos-...
function esRaizVideo(nombres) {
  if (nombres.has("cortes")) return true;
  let livianos = false;
  let crudos = false;
  for (const n of nombres) {
    if (/^livianos($|-)/.test(n)) livianos = true;
    if (/^crudos($|-)/.test(n)) crudos = true;
  }
  return livianos && crudos;
}

// Sube desde Cortes, Livianos o viejos hasta la carpeta del video.
// Se queda con la ruta tal cual (mayúsculas, NFD, barras de Windows).
function carpetaDelVideo(elegida, rutasArchivos) {
  let actual = String(elegida || "").replace(/[\\/]+$/, "");
  const rutas = rutasArchivos || [];
  for (let i = 0; i < 8 && actual; i++) {
    if (esRaizVideo(hijosDe(actual, rutas))) return actual;
    if (!esEscalon(nombreDeRuta(actual))) return actual;
    const padre = padreRuta(actual);
    if (!padre || padre === actual) return actual;
    actual = padre;
  }
  return actual;
}

function versionDeXml(archivo) {
  const m = String(archivo && archivo.nombre || "").match(XML_LIVIANOS);
  return m ? Number(m[1]) : 0;
}

function coincideXml(archivo, pedido) {
  const rel = plano(String(pedido || "")).trim().replace(/\\/g, "/");
  const base = rel.split("/").filter(Boolean).pop();
  if (!base || plano(archivo.nombre).toLowerCase() !== base.toLowerCase()) return false;
  const absoluta = /^[A-Za-z]:\//.test(rel) || rel.startsWith("/");
  if (absoluta || rel.startsWith("../") || !rel.includes("/")) return true;
  return normal(archivo.ruta).endsWith("/" + rel.replace(/^\/+/, "").toLowerCase());
}

// ultimo.json ({ xml, secuencia, version }) gana, aunque haya un vN más alto.
// Si no está o el JSON no se entiende, el vN más alto fuera de viejos.
function elegirXml(archivos, ultimoTexto) {
  const xmls = (archivos || [])
    .filter((a) => XML_LIVIANOS.test(a.nombre || "") && !enViejos(a.ruta))
    .sort((a, b) => versionDeXml(b) - versionDeXml(a) || String(a.ruta).length - String(b.ruta).length);
  let pedido = null;
  if (ultimoTexto && String(ultimoTexto).trim()) {
    try {
      const data = JSON.parse(ultimoTexto);
      if (data && data.xml) pedido = data;
    } catch (error) {
      pedido = null;
    }
  }
  if (pedido) {
    const matches = xmls.filter((a) => coincideXml(a, pedido.xml));
    if (!matches.length) {
      const base = String(pedido.xml).replace(/\\/g, "/").split("/").filter(Boolean).pop();
      return { error: `ultimo.json pide «${base}» y no está en la carpeta del video (no uso los de viejos). No importé nada.` };
    }
    const archivo = matches[0];
    return {
      archivo,
      video: archivo.nombre.replace(XML_LIVIANOS, ""),
      secuencia: pedido.secuencia ? String(pedido.secuencia).trim() : null,
      version: pedido.version != null ? pedido.version : null,
    };
  }
  if (!xmls.length) return null;
  const archivo = xmls[0];
  return { archivo, video: archivo.nombre.replace(XML_LIVIANOS, ""), secuencia: null, version: null };
}

function decodificarXml(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function esCortado(nombre) {
  return SECUENCIA_CORTADO.test(String(nombre || "").trim());
}

function versionCortado(nombre) {
  const m = String(nombre || "").match(/ - Cortado(?: v(\d+))?(?: \(livianos\))?$/i);
  return m && m[1] ? Number(m[1]) : 0;
}

// La de ultimo.json, si ese nombre está en el XML. Si no, la Cortado
// ("… - Cortado", "… - Cortado vN" o "… - Cortado vN (livianos)").
// No se abre la primera secuencia que aparezca.
function secuenciaDelXml(texto, preferida) {
  const nombres = [...String(texto || "").matchAll(/<sequence\b[^>]*>\s*<name>([^<]*)<\/name>/gi)].map((m) => decodificarXml(m[1]).trim());
  if (preferida) {
    const p = plano(String(preferida)).trim();
    const hallada = nombres.find((n) => plano(n) === p);
    if (hallada) return hallada;
  }
  const cortados = nombres.filter((n) => esCortado(n));
  cortados.sort((a, b) => versionCortado(b) - versionCortado(a));
  return cortados[0] || null;
}

// La carpeta del video es la que contiene Cortes/Livianos. null si el XML no está ahí.
function carpetaDeVideoDelXml(ruta) {
  const s = String(ruta || "").replace(/[\\/]+$/, "");
  const sep = s.includes("\\") ? "\\" : "/";
  const partes = s.split(/[\\/]/);
  const bajos = partes.map((p) => plano(p).toLowerCase());
  for (let i = bajos.length - 1; i >= 1; i--) {
    if (bajos[i] === "livianos" && bajos[i - 1] === "cortes") {
      if (i < 2) return null;
      return partes.slice(0, i - 1).join(sep);
    }
  }
  return null;
}

function carpetasDeVideos(archivos) {
  const vistos = new Map();
  for (const a of archivos || []) {
    if (!XML_LIVIANOS.test(a.nombre || "") || enViejos(a.ruta)) continue;
    const c = carpetaDeVideoDelXml(a.ruta);
    if (!c) continue;
    const k = normal(c);
    if (!vistos.has(k)) vistos.set(k, c);
  }
  return [...vistos.values()];
}

// 15 s, y más según el peso de los livianos, sin pasar de 60 s.
function topeDeImport(bytes) {
  const base = 15000;
  const escalado = base + Math.ceil((Number(bytes) || 0) / (1024 * 1024)) * 1000;
  return Math.min(60000, Math.max(base, escalado));
}

function esErrorDeDisco(error) {
  const m = String((error && error.message) || "");
  return /no such file or directory|\bENOENT\b/i.test(m);
}

function mensajeNoBajo(nombre, error, boton) {
  const detalle = (error && error.message) || "";
  const mudo = /sin respuesta|timed out|timeout|ETIMEDOUT|ECONNRESET|EIO/i.test(detalle);
  const porque = mudo ? "Drive no respondió" : "no se pudo leer";
  const cual = boton || "Traer video";
  return `Falta bajar «${nombre}» (${porque}). Esperá un minuto y volvé a tocar ${cual}. Si sigue igual, clic derecho sobre ese archivo → Disponible sin conexión, y tocá el botón otra vez.`;
}

function conTope(promesa, ms) {
  return new Promise((ok, mal) => {
    const t = setTimeout(() => mal(new Error("sin respuesta")), ms);
    Promise.resolve(promesa).then(
      (v) => {
        clearTimeout(t);
        ok(v);
      },
      (e) => {
        clearTimeout(t);
        mal(e);
      }
    );
  });
}

// Lee el archivo entero y tira los bytes: así Drive en modo transmisión lo baja de verdad,
// sin dejarlo todo en memoria. Si pasa 25 s sin recibir nada, se rinde.
async function leerEntero(camino, alAvanzar) {
  const fs = require("fs");
  const enNode = typeof process !== "undefined" && process.versions && process.versions.node && fs.promises && fs.promises.open;
  if (enNode) {
    const fh = await conTope(fs.promises.open(camino, "r"), ESPERA_DRIVE_MS);
    try {
      const total = Number((await conTope(fh.stat(), ESPERA_DRIVE_MS)).size) || 0;
      if (!total) throw new Error("archivo vacío");
      let pos = 0;
      while (pos < total) {
        const largo = Math.min(TROZO_BAJADA, total - pos);
        const buf = Buffer.allocUnsafe(largo);
        const r = await conTope(fh.read(buf, 0, largo, pos), ESPERA_DRIVE_MS);
        const n = r && r.bytesRead ? r.bytesRead : 0;
        if (!n) throw new Error("lectura incompleta");
        pos += n;
        if (alAvanzar) await alAvanzar(pos, total);
      }
    } finally {
      await fh.close();
    }
    return;
  }
  const fd = await conTope(fs.open(camino, "r"), ESPERA_DRIVE_MS);
  try {
    const total = Number((await conTope(fs.lstat(camino), ESPERA_DRIVE_MS)).size) || 0;
    if (!total) throw new Error("archivo vacío");
    let pos = 0;
    while (pos < total) {
      const largo = Math.min(TROZO_BAJADA, total - pos);
      const buffer = new ArrayBuffer(largo);
      const r = await conTope(fs.read(fd, buffer, 0, largo, pos), ESPERA_DRIVE_MS);
      const n = r && typeof r.bytesRead === "number" ? r.bytesRead : 0;
      if (!n) throw new Error("lectura incompleta");
      pos += n;
      if (alAvanzar) await alAvanzar(pos, total);
    }
  } finally {
    try {
      await fs.close(fd);
    } catch (error) {
      /* el cierre no cambia que la lectura ya terminó o falló */
    }
  }
}

async function bajarPorFs(ruta, alAvanzar) {
  let ultimo = null;
  for (const camino of panel.premiere.urlsParaFs(ruta)) {
    try {
      await leerEntero(camino, alAvanzar);
      return;
    } catch (error) {
      ultimo = error;
      if (error && (error.message === "sin respuesta" || error.message === "lectura incompleta")) throw error;
    }
  }
  throw ultimo || new Error("no pude abrir el archivo");
}

async function asegurarBajado(d, item, alAvanzar) {
  const nombre = (item && (item.nombre || item.ruta)) || "archivo";
  try {
    if (d && typeof d.bajar === "function") await d.bajar(item, alAvanzar);
    else await bajarPorFs(item.ruta, alAvanzar);
  } catch (error) {
    if (error && /Disponible sin conexión/.test(error.message || "")) throw error;
    throw new Error(mensajeNoBajo(nombre, error));
  }
}

async function padreDe(d, carpeta) {
  if (typeof d.padre === "function") {
    try {
      const p = await d.padre(carpeta);
      if (p) return p;
    } catch (error) {
      /* sigo por la ruta */
    }
  }
  const arriba = padreRuta(d.ruta(carpeta));
  if (!arriba) return null;
  if (typeof carpeta === "string") return arriba;
  return null;
}

async function subirHastaVideo(d, carpeta) {
  let actual = carpeta;
  for (let i = 0; i < 8 && actual; i++) {
    const ruta = String(d.ruta(actual) || "").replace(/[\\/]+$/, "");
    const archivos = await d.listar(actual);
    if (esRaizVideo(hijosDe(ruta, archivos.map((a) => a.ruta)))) return actual;
    if (!esEscalon(nombreDeRuta(ruta))) return actual;
    const padre = await padreDe(d, actual);
    if (!padre) return actual;
    const rutaPadre = String(d.ruta(padre) || "").replace(/[\\/]+$/, "");
    if (!rutaPadre || normal(rutaPadre) === normal(ruta)) return actual;
    actual = padre;
  }
  return actual;
}

async function recordarSiPuede(d, carpeta) {
  if (typeof d.recordarCarpeta !== "function") return;
  try {
    await d.recordarCarpeta(carpeta);
  } catch (error) {
    /* sin token nuevo: queda el que se guardó al elegir */
  }
}

async function intentarFs(ruta, hacer) {
  const fs = require("fs");
  let ultimo = null;
  for (const candidato of panel.premiere.urlsParaFs(ruta)) {
    try {
      return await hacer(fs, candidato);
    } catch (error) {
      ultimo = error;
    }
  }
  throw ultimo || new Error("no pude usar el archivo");
}
const discoUXP = {
  async elegirCarpeta() {
    const fs = require("uxp").storage.localFileSystem;
    const carpeta = await fs.getFolder();
    if (!carpeta) return null;
    try {
      window.localStorage.setItem(CLAVE_CARPETA, await fs.createPersistentToken(carpeta));
    } catch (error) {
      /* sin token: la próxima vez se vuelve a elegir */
    }
    return carpeta;
  },
  async carpetaGuardada() {
    const token = window.localStorage.getItem(CLAVE_CARPETA);
    if (!token) return null;
    try {
      return await require("uxp").storage.localFileSystem.getEntryForPersistentToken(token);
    } catch (error) {
      return null;
    }
  },
  ruta: (carpeta) => carpeta.nativePath,
  olvidarCarpeta: () => window.localStorage.removeItem(CLAVE_CARPETA),
  // La carpeta de arriba. Entry.parent a veces no está: se arma la ruta y se vuelve a pedir.
  async padre(carpeta) {
    try {
      if (carpeta && carpeta.parent && carpeta.parent.isFolder) return carpeta.parent;
    } catch (error) {
      /* sin parent: se prueba por la ruta */
    }
    const arriba = padreRuta(carpeta && carpeta.nativePath);
    if (!arriba) return null;
    const fs = require("uxp").storage.localFileSystem;
    for (const u of panel.premiere.urlsParaFs(arriba)) {
      try {
        const e = await fs.getEntryWithUrl(u);
        if (e && e.isFolder) return e;
      } catch (error) {
        /* otra variante de la URL */
      }
    }
    return null;
  },
  async recordarCarpeta(carpeta) {
    if (!carpeta || typeof carpeta.nativePath !== "string") return;
    try {
      const fs = require("uxp").storage.localFileSystem;
      window.localStorage.setItem(CLAVE_CARPETA, await fs.createPersistentToken(carpeta));
    } catch (error) {
      /* sin token: la próxima vez se vuelve a elegir */
    }
  },
  // Carpeta propia del panel en esta compu: ahí va el XML con las rutas locales (no ensucia el Drive).
  async carpetaDatos() {
    return (await require("uxp").storage.localFileSystem.getDataFolder()).nativePath;
  },
  // Todos los archivos adentro de la carpeta (hasta 8 niveles): [{ ruta, nombre, tamano }].
  async listar(carpeta) {
    const lista = [];
    async function recorrer(dir, nivel) {
      for (const e of await dir.getEntries()) {
        if (e.isFolder) {
          if (nivel < 8) await recorrer(e, nivel + 1);
        } else {
          let tamano = 0;
          try {
            tamano = Number((await e.getMetadata()).size) || 0;
          } catch (error) {
            /* sin tamaño */
          }
          // Se guarda la entrada para leerla sin armar una URL: en Mac "My Drive" y
          // "Application Support" tienen espacios, y el fs de UXP a veces no las abre.
          lista.push({
            ruta: e.nativePath,
            nombre: e.name,
            tamano,
            async leer() {
              return await e.read({ format: require("uxp").storage.formats.utf8 });
            },
          });
        }
      }
    }
    await recorrer(carpeta, 0);
    return lista;
  },
  async leerTexto(ruta) {
    return await intentarFs(ruta, (fs, u) => fs.readFile(u, { encoding: "utf-8" }));
  },
  async escribirTexto(ruta, texto) {
    await intentarFs(ruta, (fs, u) => fs.writeFile(u, texto, { encoding: "utf-8" }));
  },
  async copiar(desde, hasta) {
    const datos = await intentarFs(desde, (fs, u) => fs.readFile(u));
    await intentarFs(hasta, (fs, u) => fs.writeFile(u, datos));
  },
  // El XML "(esta compu)" se escribe con la carpeta de datos del panel, no con una URL.
  async escribirEnDatos(nombre, texto) {
    try {
      const uxp = require("uxp");
      const carpeta = await uxp.storage.localFileSystem.getDataFolder();
      const archivo = await carpeta.createFile(nombre, { overwrite: true });
      await archivo.write(texto, { format: uxp.storage.formats.utf8 });
      return archivo.nativePath;
    } catch (error) {
      const ruta = panel.premiere.unirRuta(await this.carpetaDatos(), nombre);
      await this.escribirTexto(ruta, texto);
      return ruta;
    }
  },
};
const disco = () => panel.disco || discoUXP;

async function leerArchivo(d, item) {
  if (item && typeof item.leer === "function") {
    try {
      return await item.leer();
    } catch (error) {
      /* la entrada no leyó: se prueba por la ruta */
    }
  }
  return d.leerTexto(item.ruta);
}

// Una sola lectura. Si Drive no contesta en 25 s, se dice qué archivo falta.
async function leerTextoSeguro(d, item, boton) {
  const nombre = (item && (item.nombre || item.ruta)) || "archivo";
  try {
    const texto = await conTope(leerArchivo(d, item), ESPERA_DRIVE_MS);
    if (texto == null || texto === "") throw new Error("archivo vacío");
    return texto;
  } catch (error) {
    if (error && /Disponible sin conexión/.test(error.message || "")) throw error;
    throw new Error(mensajeNoBajo(nombre, error, boton));
  }
}

// Un byte alcanza para saber si el archivo está en el disco. Drive a veces lo lista
// con el tamaño completo aunque siga en la nube: abrirlo tira "no such file or directory".
async function leerPrimerByte(ruta) {
  const fs = require("fs");
  const enNode = typeof process !== "undefined" && process.versions && process.versions.node && fs.promises && fs.promises.open;
  let ultimo = null;
  for (const camino of panel.premiere.urlsParaFs(ruta)) {
    try {
      if (enNode) {
        const fh = await conTope(fs.promises.open(camino, "r"), ESPERA_DRIVE_MS);
        try {
          const buf = Buffer.alloc(1);
          const r = await conTope(fh.read(buf, 0, 1, 0), ESPERA_DRIVE_MS);
          if (!r || !r.bytesRead) throw new Error("archivo vacío");
        } finally {
          await fh.close();
        }
      } else {
        const fd = await conTope(fs.open(camino, "r"), ESPERA_DRIVE_MS);
        try {
          const buffer = new ArrayBuffer(1);
          const r = await conTope(fs.read(fd, buffer, 0, 1, 0), ESPERA_DRIVE_MS);
          const n = r && typeof r.bytesRead === "number" ? r.bytesRead : 0;
          if (!n) throw new Error("archivo vacío");
        } finally {
          try {
            await fs.close(fd);
          } catch (error) {
            /* el cierre no cambia que la lectura ya terminó o falló */
          }
        }
      }
      return;
    } catch (error) {
      ultimo = error;
      if (error && error.message === "sin respuesta") throw error;
    }
  }
  throw ultimo || new Error("no pude abrir el archivo");
}

// En las pruebas el disco es de mentira: el archivo no está en el fs. En Premiere se lee un byte.
async function originalDisponible(d, item) {
  if (d && typeof d.originalDisponible === "function") return d.originalDisponible(item);
  if (d !== discoUXP) return true;
  try {
    await leerPrimerByte(item.ruta);
    return true;
  } catch (error) {
    return false;
  }
}

async function escribirXmlLocal(d, nombre, texto) {
  if (typeof d.escribirEnDatos === "function") return d.escribirEnDatos(nombre, texto);
  const ruta = panel.premiere.unirRuta(await d.carpetaDatos(), nombre);
  await d.escribirTexto(ruta, texto);
  return ruta;
}

async function laCarpeta(elegirOtra) {
  const d = disco();
  let carpeta = elegirOtra ? null : await d.carpetaGuardada();
  if (!carpeta) {
    avisar("Elegí la carpeta del video…");
    carpeta = await d.elegirCarpeta();
  }
  if (!carpeta) throw new Error("No elegiste ninguna carpeta.");
  const resuelta = await subirHastaVideo(d, carpeta);
  if (normal(d.ruta(resuelta)) !== normal(d.ruta(carpeta))) {
    avisar(`Uso la carpeta del video: ${nombreDeRuta(d.ruta(resuelta))}`);
  }
  await recordarSiPuede(d, resuelta);
  return resuelta;
}

// ---------- Proyecto ----------

async function proyectoAbierto() {
  const proyecto = await ppro.Project.getActiveProject();
  if (!proyecto) throw new Error("Primero abrí o creá un proyecto en Premiere (Archivo > Nuevo > Proyecto).");
  if (!proyecto.path) throw new Error("Guardá el proyecto una vez (Archivo > Guardar) y volvé a tocar el botón.");
  return proyecto;
}

async function guardar(proyecto) {
  if (!(await proyecto.save())) throw new Error("Premiere no pudo guardar el proyecto.");
}

function enTandas(proyecto, nombre, acciones) {
  for (let i = 0; i < acciones.length; i += MAX_ACCIONES) {
    const tanda = acciones.slice(i, i + MAX_ACCIONES);
    const ok = p.transaccion(proyecto, nombre, (c) => {
      for (const armar of tanda) c.addAction(armar());
    });
    if (!ok) throw new Error(`Premiere no aceptó "${nombre}".`);
  }
}

// Clip, secuencia o carpeta. Premiere no dice qué devuelve cast con el tipo equivocado, así que no
// se confía en eso: es clip solo si es secuencia o tiene archivo; si no, carpeta si se puede listar.
// Se anota item.type de cada uno para conocer los números reales (la prueba de mañana lo dice).
const tiposVistos = {};
async function tipoDe(item) {
  let r = {};
  try {
    const clip = ppro.ClipProjectItem.cast(item);
    if (clip && typeof clip.isSequence === "function") {
      const secuencia = await clip.isSequence();
      const ruta = secuencia ? "" : (await clip.getMediaFilePath()) || "";
      if (secuencia || ruta) r = { clip, secuencia, ruta };
    }
  } catch (error) {
    /* no es un clip */
  }
  if (!r.clip) {
    try {
      const carpeta = ppro.FolderItem.cast(item);
      if (carpeta && typeof carpeta.getItems === "function") {
        await carpeta.getItems();
        r = { carpeta };
      }
    } catch (error) {
      /* tampoco es carpeta */
    }
  }
  const clase = r.carpeta ? "carpeta" : r.secuencia ? "secuencia" : r.clip ? "clip" : "otro";
  tiposVistos[clase] = item.type;
  return r;
}

// Todos los clips y secuencias adentro de una carpeta del proyecto, con la carpeta en la que están.
// Cada elemento: { item (ProjectItem), clip, secuencia, padre (FolderItem), padreId }.
async function recorrerProyecto(carpeta, padreId, lista = []) {
  for (const item of await carpeta.getItems()) {
    const t = await tipoDe(item);
    if (t.carpeta) await recorrerProyecto(t.carpeta, item.getId(), lista);
    else if (t.clip) lista.push({ item, clip: t.clip, secuencia: t.secuencia, ruta: t.ruta, padre: carpeta, padreId });
  }
  return lista;
}

// Carpeta del proyecto con ese nombre adentro de `padre` (la crea si no está): { item, carpeta }.
async function crearCarpeta(proyecto, padre, nombre) {
  const buscar = async () => {
    for (const it of await padre.getItems()) {
      if (it.name !== nombre) continue;
      const t = await tipoDe(it);
      if (t.carpeta) return { item: it, carpeta: t.carpeta };
    }
    return null;
  };
  let bin = await buscar();
  if (!bin) {
    p.transaccion(proyecto, `Carpeta ${nombre}`, (c) => c.addAction(padre.createBinAction(nombre, false)));
    bin = await buscar();
  }
  if (!bin) throw new Error(`No pude crear la carpeta "${nombre}" en el proyecto.`);
  return bin;
}

// ---------- Traer video ----------

function ultimoEn(archivos) {
  return (archivos || [])
    .filter((a) => plano(a.nombre).toLowerCase() === "ultimo.json" && /\/livianos\/ultimo\.json$/.test(normal(a.ruta)) && !enViejos(a.ruta))
    .sort((a, b) => {
      const pa = /\/cortes\/livianos\/ultimo\.json$/.test(normal(a.ruta)) ? 0 : 1;
      const pb = /\/cortes\/livianos\/ultimo\.json$/.test(normal(b.ruta)) ? 0 : 1;
      return pa - pb || String(a.ruta).length - String(b.ruta).length;
    })[0] || null;
}

async function traerVideo() {
  const d = disco();
  const proyecto = await proyectoAbierto();
  const carpeta = await laCarpeta(true);

  avisar("Buscando los archivos…");
  const archivos = await d.listar(carpeta);
  const carpetasVideo = carpetasDeVideos(archivos);
  if (carpetasVideo.length > 1) {
    const cuales = carpetasVideo.map((c) => nombreDeRuta(c)).slice(0, 4).join(", ");
    throw new Error(`Hay XML de más de un video (${cuales}). Elegí la carpeta de un solo video.`);
  }
  const ultimo = ultimoEn(archivos);
  let ultimoTexto = null;
  if (ultimo) {
    avisar("Bajando ultimo.json…");
    ultimoTexto = await leerTextoSeguro(d, ultimo);
  }
  const elegido = elegirXml(archivos, ultimoTexto);
  if (elegido && elegido.error) throw new Error(elegido.error);
  if (!elegido) {
    const soloViejos = archivos.some((a) => XML_LIVIANOS.test(a.nombre || "") && enViejos(a.ruta));
    throw new Error(
      soloViejos
        ? "Solo encontré XML de livianos en la carpeta viejos. No importé nada."
        : 'No encontré el XML de livianos ("… - cortes vN (livianos).xml") en la carpeta del video. Elegí esa carpeta, Cortes o Livianos.'
    );
  }
  const xml = elegido.archivo;
  const video = elegido.video;

  avisar(`Bajando el XML: ${xml.nombre}`);
  const texto = await leerTextoSeguro(d, xml);
  avisar(`Bajando el XML: ${xml.nombre} (100%)`);
  const nombreSecuencia = secuenciaDelXml(texto, elegido.secuencia);
  if (!nombreSecuencia) throw new Error("El XML no tiene ninguna secuencia para abrir. No importé nada.");

  // Si esa secuencia ya está en el proyecto, se abre y no se importa de nuevo.
  const raiz = await proyecto.getRootItem();
  const ya = (await proyecto.getSequences()).find((s) => plano(s.name) === plano(nombreSecuencia));
  if (ya) {
    await proyecto.openSequence(ya);
    const msg = `Ya estaba «${ya.name}». La abrí y no la dupliqué. Si querés traerla de nuevo, borrala del proyecto y tocá el botón otra vez.`;
    panel.log(msg, "ok");
    avisar(msg);
    return;
  }

  // Cada ruta del XML se cambia por la de esta compu, buscando el mismo archivo adentro de "Livianos".
  const livianos = archivos.filter((a) => enLivianos(a.ruta) && !enViejos(a.ruta));
  const faltan = [];
  const usados = [];
  const vistos = new Set();
  const nuevo = texto.replace(/<pathurl>([^<]*)<\/pathurl>/g, (todo, u) => {
    const rel = relativoLiviano(rutaDeUrl(u));
    // En Drive el tamaño del listado miente (0, o el peso final antes de bajar).
    // Se elige por la ruta; la lectura de después dice si el archivo está de verdad.
    const candidatos = rel ? livianos.filter((a) => normal(a.ruta).endsWith("/livianos/" + normal(rel))) : [];
    const local = candidatos.find((a) => a.tamano > 0) || candidatos[0] || null;
    if (!local) {
      faltan.push(rel || rutaDeUrl(u));
      return todo;
    }
    const clave = normal(local.ruta);
    if (!vistos.has(clave)) {
      vistos.add(clave);
      usados.push(local);
    }
    return `<pathurl>${urlDeRuta(local.ruta)}</pathurl>`;
  });
  const unicos = [...new Set(faltan)];
  if (unicos.length) {
    throw new Error(`Faltan ${unicos.length} livianos: ${unicos.slice(0, 4).join(", ")}${unicos.length > 4 ? "…" : ""}. Esperá a que termine de bajar la carpeta Livianos.`);
  }

  // Drive en modo transmisión: leer el liviano entero lo baja. Si no responde, se dice cuál.
  for (let i = 0; i < usados.length; i++) {
    const item = usados[i];
    const contar = () => avisar(`Bajando ${i + 1} de ${usados.length}: ${item.nombre}`);
    contar();
    await asegurarBajado(d, item, (pos, total) => {
      if (total) avisar(`Bajando ${i + 1} de ${usados.length}: ${item.nombre} (${Math.min(100, Math.floor((100 * pos) / total))}%)`);
    });
  }

  // El XML con las rutas de esta compu va a la carpeta del panel, no a la del video (puede ser del Drive).
  const rutaXml = await escribirXmlLocal(d, xml.nombre.replace(/\.xml$/i, " (esta compu).xml"), nuevo);

  avisar("Importando en Premiere…");
  const bin = await crearCarpeta(proyecto, raiz, video);
  const ok = await proyecto.importFiles([rutaXml], true, bin.item, false);
  if (!ok) throw new Error("Premiere no pudo importar el XML.");
  // Se espera a que deje de cambiar lo importado. 15 s, y más si los livianos pesan, hasta 60 s.
  const bytes = usados.reduce((suma, a) => suma + (Number(a.tamano) || 0), 0);
  const vueltas = Math.ceil(topeDeImport(bytes) / 500);
  let importados = [];
  let iguales = 0;
  for (let i = 0; i < vueltas && iguales < 2; i++) {
    const ahora = await recorrerProyecto(bin.carpeta, bin.item.getId());
    iguales = ahora.length && ahora.length === importados.length ? iguales + 1 : 0;
    importados = ahora;
    if (iguales < 2) await esperar(500);
  }
  if (!importados.length) throw new Error("Premiere dijo que importó, pero no aparece nada en la carpeta del video.");

  avisar("Ordenando en carpetas…");
  const destinos = {};
  for (const [clave, nombre] of Object.entries(CARPETAS)) destinos[clave] = await crearCarpeta(proyecto, bin.carpeta, nombre);
  const propias = new Set(Object.values(destinos).map((b) => b.item.getId()));
  const mover = [];
  for (const x of await recorrerProyecto(bin.carpeta, bin.item.getId())) {
    if (propias.has(x.padreId)) continue;
    let clave = "pantalla";
    if (x.secuencia) clave = "secuencias";
    else {
      const ruta = normal(x.ruta);
      if (/\/camara\//.test(ruta)) clave = "camara";
      else if (/\/audio\//.test(ruta)) clave = "audio";
    }
    mover.push(() => x.padre.createMoveItemAction(x.item, destinos[clave].carpeta));
  }
  if (mover.length) enTandas(proyecto, "Ordenar video", mover);
  // La carpeta que crea Premiere con el nombre del XML queda vacía: se borra (solo si quedó vacía).
  const vacias = [];
  for (const it of await bin.carpeta.getItems()) {
    if (propias.has(it.getId())) continue;
    const t = await tipoDe(it);
    if (t.carpeta && !(await recorrerProyecto(t.carpeta, it.getId())).length) vacias.push(() => bin.carpeta.createRemoveItemAction(it));
  }
  if (vacias.length) enTandas(proyecto, "Ordenar video", vacias);

  // Abre la secuencia que dice ultimo.json, o "Cortado", en la línea de tiempo.
  const enSecuencias = new Set((await destinos.secuencias.carpeta.getItems()).map((it) => it.getId()));
  let abierta = null;
  for (const s of await proyecto.getSequences()) {
    if (plano(s.name) !== plano(nombreSecuencia)) continue;
    const item = await s.getProjectItem();
    if (item && enSecuencias.has(item.getId())) abierta = s;
  }
  if (!abierta) {
    for (const s of await proyecto.getSequences()) {
      if (plano(s.name) === plano(nombreSecuencia)) abierta = s;
    }
  }
  if (abierta) await proyecto.openSequence(abierta);
  else panel.log(`Importé «${video}», pero no encontré la secuencia «${nombreSecuencia}» para abrirla. Buscala en el panel Proyecto.`, "error");
  await guardar(proyecto);

  const cual = elegido.version != null ? `v${elegido.version}` : xml.nombre;
  panel.log(`Traje "${video}" (${cual}): ${mover.length} elementos ordenados${abierta ? ` y abrí «${abierta.name}»` : ""}. Proyecto guardado.`, "ok");
  panel.log(`(para Mauro) tipos: ${JSON.stringify(tiposVistos)}`);
  avisar(abierta ? "Listo. Cuando bajen los originales, tocá «Pasar a originales»." : `Importé, pero no abrí «${nombreSecuencia}». Buscala en el proyecto.`);
}

// ---------- Pasar a originales ----------

async function mirarCarpeta(d, elegirOtra) {
  try {
    const carpeta = await laCarpeta(elegirOtra);
    return { carpeta, archivos: await d.listar(carpeta) };
  } catch (error) {
    if (!esErrorDeDisco(error)) throw error;
    throw new Error("No pude mirar la carpeta del video. Si está en Drive, clic derecho → Disponible sin conexión, y volvé a tocar Pasar a originales. No cambié nada.");
  }
}

async function pasarAOriginales() {
  const d = disco();
  const proyecto = await proyectoAbierto();
  let { carpeta, archivos } = await mirarCarpeta(d, false);
  let lista = archivos.find((a) => normal(a.ruta).endsWith("/livianos/archivos.json"));
  if (!lista) {
    // La carpeta guardada no es la del video: se pide de nuevo.
    ({ carpeta, archivos } = await mirarCarpeta(d, true));
    lista = archivos.find((a) => normal(a.ruta).endsWith("/livianos/archivos.json"));
  }
  if (!lista) throw new Error("No encontré Livianos/archivos.json en la carpeta del video.");
  avisar("Bajando archivos.json…");
  // Traer video no abre este archivo. Si Drive lo tiene solo en la nube, fs tira
  // "no such file or directory": hay que bajarlo y decirlo, no mostrar ese texto.
  const textoLista = await leerTextoSeguro(d, lista, "Pasar a originales");
  let esperados;
  try {
    esperados = JSON.parse(textoLista).archivos;
  } catch (error) {
    throw new Error(`No pude leer «${lista.ruta}»: no es el listado de originales. No cambié nada.`);
  }
  if (!Array.isArray(esperados)) throw new Error(`No pude leer «${lista.ruta}»: no tiene la lista de archivos. No cambié nada.`);
  avisar(`Revisando los originales en ${d.ruta(carpeta)}…`);
  const carpetaRuta = d.ruta(carpeta);

  // Cada original tiene que estar entero (mismo tamaño que en la PC de Mauro) y fuera de Livianos.
  // "archivo" es relativo al contenido. Si viniera absoluto de Windows, se resuelve contra esta carpeta.
  const originales = {};
  const faltan = [];
  for (const e of esperados) {
    const clave = claveDeArchivo(e.archivo, carpetaRuta);
    // Solo un archivo que esté de verdad en la carpeta elegida. La ruta de Windows del
    // clip no se reescribe: el original es el que listó el disco de esta compu.
    const candidatos = archivos.filter(
      (a) => !enLivianos(a.ruta) && p.estaEnLaCarpeta(a.ruta, carpetaRuta) && normal(a.ruta).endsWith("/" + normal(clave))
    );
    // Si hay más de uno con ese nombre, primero el que está adentro de una carpeta "Crudos".
    const enCrudos = (a) => Number(normal(a.ruta).includes("/crudos/"));
    candidatos.sort((a, b) => enCrudos(b) - enCrudos(a));
    const entero = candidatos.find((a) => a.tamano === e.original.bytes);
    // El tamaño que muestra Drive no prueba que el archivo esté en el disco.
    if (entero && (await originalDisponible(d, entero))) originales[normal(clave)] = { ruta: entero.ruta, info: e };
    else if (entero) faltan.push(`${e.archivo} (Drive lo muestra, pero no está en el disco)`);
    else if (candidatos.length) faltan.push(`${e.archivo} (a medio bajar: ${Math.round(candidatos[0].tamano / 1048576)} de ${Math.round(e.original.bytes / 1048576)} MB)`);
    else faltan.push(e.archivo);
  }
  if (faltan.length) {
    const cuantos = faltan.length === 1 ? "falta 1 original" : `faltan ${faltan.length} originales`;
    throw new Error(`Todavía ${cuantos}: ${faltan.slice(0, 3).join(", ")}${faltan.length > 3 ? "…" : ""}. Si está en Drive, clic derecho sobre el archivo → Disponible sin conexión, y volvé a tocar Pasar a originales. No cambié nada.`);
  }

  // Solo los clips que usan un liviano de ESTA carpeta (otro video del proyecto no se toca).
  // El clip puede seguir con la ruta de Windows (I:\My Drive\...) y la carpeta ser la de la Mac:
  // se comparan desde "My Drive". El zip descomprimido sigue entrando, porque está adentro
  // de la carpeta ("Livianos-2026…-001/Livianos/…").
  const deEsteVideo = (ruta) => p.esDeEstaCarpeta(ruta, carpetaRuta);
  const raiz = await proyecto.getRootItem();
  const aPasar = [];
  let deOtraCarpeta = 0;
  let yaPasados = 0;
  let primeraAjena = "";
  const rutasOriginales = new Set(Object.values(originales).map((o) => p.claveDeRuta(o.ruta)));
  for (const x of await recorrerProyecto(raiz, raiz.getId ? raiz.getId() : "raiz")) {
    if (x.secuencia) continue;
    if (!enLivianos(x.ruta)) {
      // Después de pasar, el clip apunta al original: cuenta como ya pasado de este video.
      if (rutasOriginales.has(p.claveDeRuta(x.ruta))) yaPasados++;
      continue;
    }
    if (!deEsteVideo(x.ruta)) {
      if (!(await x.clip.hasProxy())) {
        deOtraCarpeta++;
        if (!primeraAjena) primeraAjena = x.ruta;
      }
      continue;
    }
    if (await x.clip.hasProxy()) {
      yaPasados++;
      continue;
    }
    const original = originales[normal(relativoLiviano(x.ruta))];
    if (!original) throw new Error(`No sé cuál es el original de ${x.ruta}. No cambié nada.`);
    aPasar.push({ ...x, original });
  }
  if (!aPasar.length && !yaPasados && deOtraCarpeta) {
    disco().olvidarCarpeta();
    panel.log(`Clip: ${primeraAjena}`, "error");
    panel.log(`Normalizada: ${p.canonRuta(primeraAjena)}`, "error");
    panel.log(`Contra: ${p.canonRuta(carpetaRuta)}`, "error");
    throw new Error(`Hay ${deOtraCarpeta} clips con livianos, pero no de ${carpetaRuta}. Volvé a tocar el botón y elegí la carpeta de ese video. No cambié nada.`);
  }
  if (!aPasar.length) {
    avisar("No hay nada para pasar en este video: ya está con los originales.");
    return;
  }

  // Copia del proyecto antes de tocar: attachProxy no se puede deshacer.
  // En Windows Premiere a veces da la ruta como \\?\C:\.... Sin sacarlo, el fs no lee el .prproj.
  avisar("Guardando una copia del proyecto…");
  const origen = p.rutaSinPrefijo(proyecto.path);
  try {
    await guardar(proyecto);
  } catch (error) {
    if (!esErrorDeDisco(error)) throw error;
    throw new Error(`No pude guardar el proyecto «${origen}». No cambié nada.`);
  }
  const copia = /\.prproj$/i.test(origen)
    ? origen.replace(/\.prproj$/i, " (antes de originales).prproj")
    : origen + " (antes de originales).prproj";
  let hayCopia = false;
  let falloCopia = null;
  for (let i = 0; i < 2 && !hayCopia; i++) {
    try {
      if (i) await esperar(300);
      await d.copiar(origen, copia);
      hayCopia = true;
    } catch (error) {
      falloCopia = error;
    }
  }
  if (!hayCopia) {
    const crudo = String((falloCopia && falloCopia.message) || "");
    const detalle = crudo && !esErrorDeDisco(falloCopia) ? ` (${crudo})` : "";
    panel.log(
      `No pude guardar la copia del proyecto${detalle}. No leí «${origen}» o no escribí «${copia}». Sigo sin esa copia: si algo queda mal, no hay archivo para volver atrás.`,
      "error"
    );
  }

  avisar(`Pasando ${aPasar.length} clips a los originales…`);
  const pasados = new Map(); // id del elemento del proyecto -> factor de escala
  const fallaron = [];
  for (const x of aPasar) {
    if ((await x.clip.canProxy()) && (await x.clip.attachProxy(x.original.ruta, true))) {
      const e = x.original.info;
      pasados.set(x.item.getId(), e.liviano.ancho ? e.original.ancho / e.liviano.ancho : 1);
    } else fallaron.push(x.item.name);
  }

  // Los livianos estaban agrandados para ocupar lo mismo que el original: se vuelve a la escala real.
  avisar("Corrigiendo la escala…");
  let corregidos = 0;
  try {
    for (const secuencia of await proyecto.getSequences()) {
      const total = await secuencia.getVideoTrackCount();
      for (let i = 0; i < total; i++) {
        const pista = await secuencia.getVideoTrack(i);
        for (const ti of await pista.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)) {
          const item = await ti.getProjectItem();
          const factor = item && pasados.get(item.getId());
          if (!factor || Math.abs(factor - 1) < 0.001) continue;
          await dividirEscala(proyecto, ti, factor);
          corregidos++;
        }
      }
    }
  } catch (error) {
    // Quedó a medias: no se guarda. Si hubo copia, esa es el punto para volver.
    const vuelta = hayCopia
      ? `No guardé: cerrá sin guardar y abrí la copia ${copia} (aunque Premiere haya autoguardado, abrí la copia).`
      : "No guardé, y no hay copia de antes: si podés, cerrá sin guardar.";
    throw new Error(`Los clips ya apuntan a los originales, pero la escala quedó a medias (${error.message}). ${vuelta}`);
  }
  await guardar(proyecto);

  if (fallaron.length) panel.log(`No pude pasar ${fallaron.length}: ${fallaron.slice(0, 3).join(", ")}`, "error");
  if (hayCopia) {
    panel.log(`Pasé ${pasados.size} clips a los originales y corregí la escala de ${corregidos} en la línea de tiempo. Copia de antes: ${copia}`, "ok");
    avisar("Listo. Revisá el encuadre y exportá. Si algo quedó mal, abrí la copia «(antes de originales)».");
  } else {
    panel.log(`Pasé ${pasados.size} clips a los originales y corregí la escala de ${corregidos} en la línea de tiempo. No quedó copia del proyecto de antes.`, "ok");
    avisar("Listo. Revisá el encuadre y exportá. No quedó copia de antes: si algo queda mal, no hay archivo para volver atrás.");
  }
}

// Escala del Movimiento dividida por `factor`. Con keyframes: se borran y se vuelven a poner con el
// valor nuevo y la misma interpolación (como hace Suavizar).
async function dividirEscala(proyecto, trackItem, factor) {
  const cadena = await trackItem.getComponentChain();
  const movimiento = await p.buscarComponente(cadena, "AE.ADBE Motion");
  if (!movimiento) return;
  const escala = movimiento.getParam(1);
  if (!escala.isTimeVarying()) {
    const valor = (await escala.getStartValue()).value.value;
    const ok = p.transaccion(proyecto, "Escala de originales", (c) => c.addAction(escala.createSetValueAction(escala.createKeyframe(valor / factor))));
    if (!ok) throw new Error("Premiere no aceptó la escala");
    return;
  }
  const tiempos = escala.getKeyframeListAsTickTimes();
  const claves = [];
  for (const tiempo of tiempos) {
    const k = escala.getKeyframePtr(tiempo);
    let modo = null;
    try {
      modo = await k.getTemporalInterpolationMode();
    } catch (error) {
      /* sin dato: queda la que ponga Premiere */
    }
    claves.push({ tiempo, valor: k.value.value / factor, modo });
  }
  // De a un keyframe: se borra y se vuelve a poner con el valor nuevo enseguida, así la animación
  // nunca se queda sin keyframes (si se queda sin, Premiere la apaga).
  enTandas(
    proyecto,
    "Escala de originales",
    claves.flatMap((x) => [
      () => escala.createRemoveKeyframeAction(x.tiempo),
      () => {
        const clave = escala.createKeyframe(x.valor);
        clave.position = x.tiempo;
        return escala.createAddKeyframeAction(clave);
      },
    ])
  );
  const conModo = claves.filter((x) => typeof x.modo === "number");
  if (conModo.length) enTandas(proyecto, "Escala de originales", conModo.map((x) => () => escala.createSetInterpolationAtKeyframeAction(x.tiempo, x.modo)));

  // Se verifica que quedaron los mismos keyframes con el valor nuevo.
  const ahora = escala.isTimeVarying() ? escala.getKeyframeListAsTickTimes() : [];
  const bien =
    ahora.length === claves.length &&
    claves.every((x) => {
      const k = escala.getKeyframePtr(x.tiempo);
      return k && Math.abs(k.value.value - x.valor) < 0.01;
    });
  if (!bien) throw new Error("los keyframes de escala no quedaron como tenían que quedar");
}

// ---------- Botones ----------

function boton(fila, texto, colores, accion) {
  const b = document.createElement("div");
  b.className = "boton-color";
  b.textContent = texto;
  b.style.backgroundColor = colores[0];
  b.style.borderColor = colores[1];
  let trabajando = false;
  b.addEventListener("click", async () => {
    if (trabajando) return;
    trabajando = true;
    b.classList.add("trabajando");
    try {
      await accion();
    } catch (error) {
      let mensaje = String((error && error.message) || "");
      if (/no such file or directory|\bENOENT\b/i.test(mensaje)) {
        mensaje = "No encontré el archivo en el disco. Si está en Drive, clic derecho → Disponible sin conexión, y tocá el botón otra vez.";
      }
      panel.log(`${texto}: ${mensaje}`, "error");
      avisar("");
    } finally {
      trabajando = false;
      b.classList.remove("trabajando");
    }
  });
  fila.appendChild(b);
}

panel.traer = {
  traerVideo,
  pasarAOriginales,
  rutaDeUrl,
  urlDeRuta,
  claveDeArchivo,
  leerPrimerByte,
  carpetaDelVideo,
  elegirXml,
  secuenciaDelXml,
  topeDeImport,
};

panel.registrar({
  nombre: "Traer video",
  descripcion: "Abre el video cortado listo para editar, con copias livianas. Al final se pasa a los originales.",
  dibujar(caja) {
    const fila = document.createElement("div");
    fila.className = "colores";
    boton(fila, "Traer video", ["#212047", "#e58fb0"], traerVideo);
    boton(fila, "Pasar a originales", ["#212047", "#8fd3e5"], pasarAOriginales);
    caja.appendChild(fila);
    estado = document.createElement("p");
    estado.textContent = "";
    caja.appendChild(estado);
  },
});
