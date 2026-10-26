// Medios: lee el audio de los crudos directo del archivo, sin pedirle nada a Premiere.
// Entiende WAV (también RF64 y 32 bits float) y MP4/MOV con audio PCM (cámaras) o AAC (OBS,
// celulares), normales o fragmentados. El AAC lo decodifica aac.js (panel.aac).
//
// De cada archivo saca la "huella": cuánta voz suena cada 10 ms (energía entre 200 y 4000 Hz).
// Sincronizar compara esas huellas entre sí para saber cuánto corre un archivo respecto del otro.

const HUELLA_HZ = 100;
const BLOQUE = 4 * 1024 * 1024; // de a cuánto se lee el archivo
const SALTO_MAXIMO = 256 * 1024; // si entre dos pedazos de audio hay menos que esto, se leen juntos

// ---------- Acceso al archivo ----------
// En Premiere se usa require("fs") de UXP (open + read con posición: los crudos pesan varios GB).
// Las pruebas reemplazan panel.abrirArchivo por uno hecho con el fs de Node.

async function abrirUXP(ruta) {
  const fs = require("fs");
  const variantes = panel.premiere.urlsParaFs(ruta);
  let ultimoError = null;
  for (const camino of variantes) {
    try {
      const fd = await fs.open(camino, "r");
      const datos = await fs.lstat(camino);
      const fecha = datos.mtimeMs || (datos.mtime && datos.mtime.getTime ? datos.mtime.getTime() : 0);
      return {
        tamano: Number(datos.size),
        fecha: Number(fecha) || 0,
        async leer(pos, largo) {
          const buffer = new ArrayBuffer(largo);
          const r = await fs.read(fd, buffer, 0, largo, pos);
          const leidos = r && typeof r.bytesRead === "number" ? r.bytesRead : largo;
          return new Uint8Array(buffer, 0, leidos);
        },
        async cerrar() {
          await fs.close(fd);
        },
      };
    } catch (error) {
      ultimoError = error;
    }
  }
  throw new Error(`no pude abrir el archivo (${ultimoError ? ultimoError.message : "sin detalle"})`);
}

function abrir(ruta) {
  return (panel.abrirArchivo || abrirUXP)(ruta);
}

// ---------- Huella ----------
// Recibe el audio en mono, de a pedazos, y acumula la energía de la voz cada 10 ms.
function crearHuella(frecuencia) {
  const dt = 1 / frecuencia;
  const a = 1 / (1 + 2 * Math.PI * 200 * dt); // pasa altos 200 Hz
  const b = 1 - Math.exp(-2 * Math.PI * 4000 * dt); // pasa bajos 4000 Hz
  const porCasilla = frecuencia / HUELLA_HZ;
  let xPrevio = 0, alto = 0, bajo = 0;
  let suma = 0, n = 0, limite = porCasilla, contadas = 0;
  const valores = [];
  return {
    agregar(mono) {
      for (let i = 0; i < mono.length; i++) {
        const x = mono[i];
        alto = a * (alto + x - xPrevio);
        xPrevio = x;
        bajo += b * (alto - bajo);
        suma += bajo * bajo;
        contadas++;
        n++;
        if (n >= limite) {
          valores.push(suma / contadas);
          suma = 0;
          contadas = 0;
          limite += porCasilla;
        }
      }
    },
    terminar() {
      return Float32Array.from(valores);
    },
  };
}

// ---------- Utilidades binarias ----------
const u16 = (d, p) => (d[p] << 8) | d[p + 1];
const u32 = (d, p) => ((d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3]) >>> 0;
const i32 = (d, p) => (d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3];
const u64 = (d, p) => u32(d, p) * 4294967296 + u32(d, p + 4);
const i64 = (d, p) => i32(d, p) * 4294967296 + u32(d, p + 4);
const tipo4 = (d, p) => String.fromCharCode(d[p], d[p + 1], d[p + 2], d[p + 3]);
const le16 = (d, p) => d[p] | (d[p + 1] << 8);
const le32 = (d, p) => (d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24)) >>> 0;

// Cajas hijas dentro de [inicio, fin) de un MP4/MOV ya leído en memoria.
function cajas(d, inicio, fin) {
  const lista = [];
  let p = inicio;
  while (p + 8 <= fin) {
    let largo = u32(d, p);
    const tipo = tipo4(d, p + 4);
    let cabecera = 8;
    if (largo === 1) {
      largo = u64(d, p + 8);
      cabecera = 16;
    } else if (largo === 0) {
      largo = fin - p;
    }
    if (largo < cabecera || p + largo > fin) break;
    lista.push({ tipo, inicio: p + cabecera, fin: p + largo, caja: p });
    p += largo;
  }
  return lista;
}

const hija = (d, caja, tipo) => (caja ? cajas(d, caja.inicio, caja.fin).find((c) => c.tipo === tipo) : null);
function camino(d, caja, ...tipos) {
  let actual = caja;
  for (const t of tipos) actual = hija(d, actual, t);
  return actual;
}

// ---------- PCM ----------
// Convierte bytes PCM intercalados a mono (promedio de los dos primeros canales), entre -1 y 1.
function pcmAMono(bytes, f) {
  const porMuestra = f.bits / 8;
  const porCuadro = porMuestra * f.canales;
  const cuadros = Math.floor(bytes.length / porCuadro);
  const mono = new Float32Array(cuadros);
  const usar = Math.min(2, f.canales);
  const vista = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const le = !f.bigEndian;
  for (let i = 0; i < cuadros; i++) {
    let suma = 0;
    for (let c = 0; c < usar; c++) {
      const p = i * porCuadro + c * porMuestra;
      let v;
      if (f.flotante) {
        v = f.bits === 64 ? vista.getFloat64(p, le) : vista.getFloat32(p, le);
      } else if (f.bits === 16) {
        v = vista.getInt16(p, le) / 32768;
      } else if (f.bits === 24) {
        const b0 = bytes[p], b1 = bytes[p + 1], b2 = bytes[p + 2];
        let x = le ? b0 | (b1 << 8) | (b2 << 16) : b2 | (b1 << 8) | (b0 << 16);
        if (x & 0x800000) x -= 0x1000000;
        v = x / 8388608;
      } else if (f.bits === 32) {
        v = vista.getInt32(p, le) / 2147483648;
      } else {
        v = f.sinSigno ? (bytes[p] - 128) / 128 : ((bytes[p] << 24) >> 24) / 128;
      }
      suma += v;
    }
    mono[i] = suma / usar;
  }
  return mono;
}

// ---------- WAV ----------
async function leerWAV(archivo, alAvanzar) {
  const cabecera = await archivo.leer(0, 12);
  const marca = tipo4(cabecera, 0);
  if ((marca !== "RIFF" && marca !== "RF64") || tipo4(cabecera, 8) !== "WAVE") return null;

  let formato = null;
  let datos = null;
  let tamanoRF64 = null;
  let p = 12;
  while (p + 8 <= archivo.tamano && !(formato && datos)) {
    const h = await archivo.leer(p, 8);
    const id = tipo4(h, 0);
    const largo = le32(h, 4);
    if (id === "fmt ") {
      const f = await archivo.leer(p + 8, Math.min(largo, 64));
      let codigo = le16(f, 0);
      if (codigo === 0xfffe && largo >= 26) codigo = le16(f, 24);
      formato = { codigo, canales: le16(f, 2), frecuencia: le32(f, 4), bits: le16(f, 14) };
    } else if (id === "ds64") {
      const f = await archivo.leer(p + 8, 24);
      tamanoRF64 = le32(f, 8) + le32(f, 12) * 4294967296;
    } else if (id === "data") {
      let tamano = largo;
      if (largo === 0xffffffff && tamanoRF64 !== null) tamano = tamanoRF64;
      datos = { pos: p + 8, tamano: Math.min(tamano, archivo.tamano - p - 8) };
    }
    p += 8 + largo + (largo & 1);
  }
  if (!formato || !datos) throw new Error("WAV sin formato o sin datos");
  if (formato.codigo !== 1 && formato.codigo !== 3) throw new Error(`WAV comprimido (código ${formato.codigo}), no lo leo`);

  const f = {
    canales: formato.canales,
    bits: formato.bits,
    flotante: formato.codigo === 3,
    bigEndian: false,
    sinSigno: formato.bits === 8,
  };
  const porCuadro = (f.bits / 8) * f.canales;
  const huella = crearHuella(formato.frecuencia);
  const paso = Math.floor(BLOQUE / porCuadro) * porCuadro;
  for (let leido = 0; leido < datos.tamano; leido += paso) {
    const largo = Math.min(paso, datos.tamano - leido);
    huella.agregar(pcmAMono(await archivo.leer(datos.pos + leido, largo), f));
    alAvanzar(leido / datos.tamano);
  }
  return {
    video: null,
    frecuencia: formato.frecuencia,
    canales: formato.canales,
    formato: `WAV ${f.flotante ? "float " : ""}${f.bits} bits`,
    inicioAudio: 0,
    huella: huella.terminar(),
    marcas: [],
  };
}

// ---------- MP4 / MOV ----------

// Cajas del primer nivel. Si el archivo es fragmentado (OBS), se guardan también los moof.
async function cajasDelArchivo(archivo) {
  const lista = [];
  let p = 0;
  while (p + 8 <= archivo.tamano) {
    const h = await archivo.leer(p, 16);
    let largo = u32(h, 0);
    const tipo = tipo4(h, 4);
    let cabecera = 8;
    if (largo === 1) {
      largo = u64(h, 8);
      cabecera = 16;
    } else if (largo === 0) {
      largo = archivo.tamano - p;
    }
    if (largo < 8 || !/^[\x20-\x7e]{4}$/.test(tipo)) break;
    lista.push({ tipo, pos: p, largo, cabecera });
    p += largo;
  }
  return lista;
}

function leerElst(d, edts) {
  const elst = hija(d, edts, "elst");
  if (!elst) return [];
  const v = d[elst.inicio];
  const cantidad = u32(d, elst.inicio + 4);
  const lista = [];
  let p = elst.inicio + 8;
  for (let i = 0; i < cantidad; i++) {
    if (v === 1) {
      lista.push({ duracion: u64(d, p), tiempo: i64(d, p + 8) });
      p += 20;
    } else {
      lista.push({ duracion: u32(d, p), tiempo: i32(d, p + 4) });
      p += 12;
    }
  }
  return lista;
}

// Cuándo arranca la pista respecto del tiempo 0 del clip, en segundos, según su lista de ediciones:
// un hueco al principio la atrasa; un "media time" la adelanta (AAC descarta las muestras de arranque).
function inicioPorEdiciones(ediciones, escalaPelicula, escalaPista) {
  let inicio = 0;
  for (const e of ediciones) {
    if (e.tiempo === -1) {
      inicio += e.duracion / escalaPelicula;
    } else {
      inicio -= e.tiempo / escalaPista;
      break;
    }
  }
  return inicio;
}

// Descriptor de esds (largo variable de 1 a 4 bytes) → AudioSpecificConfig de AAC.
function configuracionAAC(d, esds) {
  let p = esds.inicio + 4;
  const leerLargo = () => {
    let largo = 0;
    for (let i = 0; i < 4; i++) {
      const b = d[p++];
      largo = (largo << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return largo;
  };
  let objeto = 0;
  while (p < esds.fin) {
    const etiqueta = d[p++];
    const largo = leerLargo();
    if (etiqueta === 3) {
      const banderas = d[p + 2];
      p += 3;
      if (banderas & 0x80) p += 2;
      if (banderas & 0x40) p += 1 + d[p];
      if (banderas & 0x20) p += 2;
    } else if (etiqueta === 4) {
      objeto = d[p];
      p += 13;
    } else if (etiqueta === 5) {
      return { objeto, asc: d.slice(p, p + largo) };
    } else {
      p += largo;
    }
  }
  return { objeto, asc: null };
}

// HE-AAC (SBR/PS): se decodifica solo la base AAC-LC, a la mitad de frecuencia. Alcanza para la huella.
function configuracionBase(asc) {
  const bits = { d: asc, p: 0 };
  const leer = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++, bits.p++) v = (v << 1) | ((bits.d[bits.p >> 3] >> (7 - (bits.p & 7))) & 1);
    return v;
  };
  const objeto = leer(5);
  if (objeto !== 5 && objeto !== 29) return asc;
  const indice = leer(4);
  if (indice === 15) leer(24);
  const canales = leer(4);
  const indiceExt = leer(4);
  if (indiceExt === 15) leer(24);
  const base = leer(5);
  if (indice === 15 || base !== 2) return asc;
  return Uint8Array.from([(2 << 3) | (indice >> 1), ((indice & 1) << 7) | (canales << 3)]);
}

// Formato del audio a partir de la entrada de stsd.
function formatoAudio(d, entrada) {
  const codigo = tipo4(d, entrada.caja + 4);
  const base = entrada.caja + 8; // después de tamaño + tipo
  const version = u16(d, base + 8);
  let canales = u16(d, base + 16);
  let bits = u16(d, base + 18);
  let frecuencia = u32(d, base + 24) / 65536;
  let hijos = base + 28;
  let flotante = false;
  let bigEndian = true;
  let banderasLPCM = null;
  if (version === 1) {
    hijos += 16;
  } else if (version === 2) {
    frecuencia = new DataView(d.buffer, d.byteOffset + base + 32, 8).getFloat64(0);
    canales = u32(d, base + 40);
    bits = u32(d, base + 48);
    banderasLPCM = u32(d, base + 52);
    hijos = base + 64;
  }
  // En MP4 (no QuickTime) la versión 1 no suma esos 16 bytes: se prueba dónde empiezan las cajas de verdad.
  const valida = (p) => {
    const lista = cajas(d, p, entrada.fin);
    return lista.length > 0 && lista[lista.length - 1].fin === entrada.fin && lista.every((c) => /^[\x20-\x7e]{4}$/.test(c.tipo));
  };
  if (hijos < entrada.fin && !valida(hijos)) hijos = [base + 28, base + 44, base + 64].find(valida) || hijos;
  const extra = cajas(d, hijos, entrada.fin);
  const buscar = (lista, t) => {
    for (const c of lista) {
      if (c.tipo === t) return c;
      if (c.tipo === "wave") {
        const adentro = buscar(cajas(d, c.inicio, c.fin), t);
        if (adentro) return adentro;
      }
    }
    return null;
  };

  if (codigo === "mp4a") {
    const esds = buscar(extra, "esds");
    if (!esds) throw new Error("AAC sin configuración (esds)");
    const { objeto, asc } = configuracionAAC(d, esds);
    if (objeto === 0x69 || objeto === 0x6b) throw new Error("el audio es MP3, no lo leo");
    if (!asc) throw new Error("AAC sin AudioSpecificConfig");
    return { tipo: "aac", asc: configuracionBase(asc), canales, frecuencia };
  }

  const pcm = { sowt: [16, false, false], twos: [bits === 8 ? 8 : 16, false, true], in24: [24, false, true], in32: [32, false, true], fl32: [32, true, true], fl64: [64, true, true], "raw ": [8, false, false], lpcm: null, ipcm: null, fpcm: null };
  if (!(codigo in pcm)) throw new Error(`audio "${codigo.trim()}" no soportado`);
  if (pcm[codigo]) [bits, flotante, bigEndian] = pcm[codigo];
  if (codigo === "lpcm" && banderasLPCM !== null) {
    flotante = (banderasLPCM & 1) !== 0;
    bigEndian = (banderasLPCM & 2) !== 0;
  }
  if (codigo === "ipcm" || codigo === "fpcm") {
    flotante = codigo === "fpcm";
    const pcmC = buscar(extra, "pcmC");
    if (pcmC) {
      bigEndian = (d[pcmC.inicio + 4] & 1) === 0;
      bits = d[pcmC.inicio + 5];
    }
  }
  const enda = buscar(extra, "enda");
  if (enda && u16(d, enda.inicio) === 1) bigEndian = false;
  return { tipo: "pcm", canales, frecuencia, bits, flotante, bigEndian, sinSigno: codigo === "raw " };
}

// Pedazos de audio dentro del archivo, en orden: { pos, largo }. Para AAC, un pedazo = un cuadro.
// Para PCM, un pedazo = un chunk entero (puede tener miles de muestras).
function pedazosDeTabla(d, stbl, formato) {
  const stsz = hija(d, stbl, "stsz");
  const stsc = hija(d, stbl, "stsc");
  const stco = hija(d, stbl, "stco") || hija(d, stbl, "co64");
  if (!stsz || !stsc || !stco) return [];

  const tamanoFijo = u32(d, stsz.inicio + 4);
  const cantidad = u32(d, stsz.inicio + 8);
  const tamanoDe = (i) => (tamanoFijo ? tamanoFijo : u32(d, stsz.inicio + 12 + 4 * i));

  const es64 = tipo4(d, stco.caja + 4) === "co64";
  const chunks = u32(d, stco.inicio + 4);
  const offsetDe = (i) => (es64 ? u64(d, stco.inicio + 8 + 8 * i) : u32(d, stco.inicio + 8 + 4 * i));

  const reglas = [];
  const nReglas = u32(d, stsc.inicio + 4);
  for (let i = 0; i < nReglas; i++) {
    const p = stsc.inicio + 8 + 12 * i;
    reglas.push({ primero: u32(d, p) - 1, muestras: u32(d, p + 4) });
  }

  const porCuadro = formato.tipo === "pcm" ? (formato.bits / 8) * formato.canales : 0;
  const pedazos = [];
  let muestra = 0;
  for (let c = 0, r = 0; c < chunks && muestra < cantidad; c++) {
    while (r + 1 < reglas.length && reglas[r + 1].primero <= c) r++;
    const enChunk = Math.min(reglas[r].muestras, cantidad - muestra);
    let pos = offsetDe(c);
    if (formato.tipo === "pcm") {
      // En QuickTime viejo cada "muestra" PCM ocupa 1 byte en stsz aunque mida un cuadro entero.
      let bytes;
      if (tamanoFijo) bytes = enChunk * (tamanoFijo === 1 ? porCuadro : tamanoFijo);
      else {
        bytes = 0;
        for (let k = 0; k < enChunk; k++) bytes += tamanoDe(muestra + k);
      }
      pedazos.push({ pos, largo: bytes });
    } else {
      for (let k = 0; k < enChunk; k++) {
        const largo = tamanoDe(muestra + k);
        pedazos.push({ pos, largo });
        pos += largo;
      }
    }
    muestra += enChunk;
  }
  return pedazos;
}

// Pedazos en un MP4 fragmentado: cada moof trae su traf/trun con las muestras.
async function pedazosFragmentados(archivo, lista, idPista, porDefecto) {
  const pedazos = [];
  for (const caja of lista) {
    if (caja.tipo !== "moof") continue;
    const d = await archivo.leer(caja.pos, caja.largo);
    for (const traf of cajas(d, caja.cabecera, d.length).filter((c) => c.tipo === "traf")) {
      const tfhd = hija(d, traf, "tfhd");
      if (!tfhd || u32(d, tfhd.inicio + 4) !== idPista) continue;
      const banderas = u32(d, tfhd.inicio) & 0xffffff;
      let p = tfhd.inicio + 8;
      let base = caja.pos;
      if (banderas & 0x1) {
        base = u64(d, p);
        p += 8;
      }
      if (banderas & 0x2) p += 4;
      if (banderas & 0x8) p += 4;
      const tamanoDefecto = banderas & 0x10 ? u32(d, p) : porDefecto;
      let siguiente = null;
      for (const trun of cajas(d, traf.inicio, traf.fin).filter((c) => c.tipo === "trun")) {
        const bt = u32(d, trun.inicio) & 0xffffff;
        const cantidad = u32(d, trun.inicio + 4);
        let q = trun.inicio + 8;
        let pos = siguiente === null ? base : siguiente;
        if (bt & 0x1) {
          pos = base + i32(d, q);
          q += 4;
        }
        if (bt & 0x4) q += 4;
        for (let i = 0; i < cantidad; i++) {
          if (bt & 0x100) q += 4;
          let largo = tamanoDefecto;
          if (bt & 0x200) {
            largo = u32(d, q);
            q += 4;
          }
          if (bt & 0x400) q += 4;
          if (bt & 0x800) q += 4;
          pedazos.push({ pos, largo });
          pos += largo;
        }
        siguiente = pos;
      }
    }
  }
  return pedazos;
}

// Lee los pedazos agrupando los que están cerca, y le pasa los bytes de cada uno a "usar".
async function recorrerPedazos(archivo, pedazos, usar, alAvanzar) {
  let i = 0;
  while (i < pedazos.length) {
    const desde = pedazos[i].pos;
    let j = i;
    let hasta = pedazos[i].pos + pedazos[i].largo;
    while (j + 1 < pedazos.length) {
      const sig = pedazos[j + 1];
      if (sig.pos < hasta || sig.pos - hasta > SALTO_MAXIMO || sig.pos + sig.largo - desde > BLOQUE) break;
      hasta = sig.pos + sig.largo;
      j++;
    }
    const bytes = await archivo.leer(desde, Math.max(0, Math.min(hasta, archivo.tamano) - desde));
    for (let k = i; k <= j; k++) {
      const a = pedazos[k].pos - desde;
      if (a + pedazos[k].largo <= bytes.length) usar(bytes.subarray(a, a + pedazos[k].largo));
    }
    i = j + 1;
    alAvanzar(i / pedazos.length);
  }
}

async function leerMP4(archivo, alAvanzar) {
  const lista = await cajasDelArchivo(archivo);
  const cajaMoov = lista.find((c) => c.tipo === "moov");
  if (!cajaMoov) return null;
  const d = await archivo.leer(cajaMoov.pos, cajaMoov.largo);
  const moov = { inicio: cajaMoov.cabecera, fin: d.length };

  const mvhd = hija(d, moov, "mvhd");
  const escalaPelicula = mvhd ? u32(d, mvhd.inicio + (d[mvhd.inicio] === 1 ? 20 : 12)) : 1000;

  const pistas = [];
  for (const trak of cajas(d, moov.inicio, moov.fin).filter((c) => c.tipo === "trak")) {
    const mdia = hija(d, trak, "mdia");
    const hdlr = hija(d, mdia, "hdlr");
    const mdhd = hija(d, mdia, "mdhd");
    const tkhd = hija(d, trak, "tkhd");
    if (!hdlr || !mdhd || !tkhd) continue;
    pistas.push({
      trak,
      manejo: tipo4(d, hdlr.inicio + 8),
      id: u32(d, tkhd.inicio + (d[tkhd.inicio] === 1 ? 20 : 12)),
      escala: u32(d, mdhd.inicio + (d[mdhd.inicio] === 1 ? 20 : 12)),
      stbl: camino(d, mdia, "minf", "stbl"),
      ediciones: leerElst(d, hija(d, trak, "edts")),
    });
  }
  const audio = pistas.find((p) => p.manejo === "soun");
  const video = pistas.find((p) => p.manejo === "vide");

  // Datos del video (sirven para distinguir cámara de pantalla).
  let infoVideo = null;
  if (video && video.stbl) {
    const stsd = hija(d, video.stbl, "stsd");
    const entrada = stsd ? cajas(d, stsd.inicio + 8, stsd.fin)[0] : null;
    const stts = hija(d, video.stbl, "stts");
    let fps = 0;
    if (stts && u32(d, stts.inicio + 4) > 0) fps = video.escala / u32(d, stts.inicio + 12);
    if (!fps) {
      const mvex = hija(d, moov, "mvex");
      const trex = mvex ? cajas(d, mvex.inicio, mvex.fin).find((c) => c.tipo === "trex" && u32(d, c.inicio + 4) === video.id) : null;
      if (trex && u32(d, trex.inicio + 12)) fps = video.escala / u32(d, trex.inicio + 12);
    }
    const mdhd = hija(d, hija(d, video.trak, "mdia"), "mdhd");
    const duracion = d[mdhd.inicio] === 1 ? u64(d, mdhd.inicio + 24) : u32(d, mdhd.inicio + 16);
    infoVideo = {
      codec: entrada ? tipo4(d, entrada.caja + 4) : "",
      ancho: entrada ? u16(d, entrada.caja + 32) : 0,
      alto: entrada ? u16(d, entrada.caja + 34) : 0,
      fps: Math.round(fps * 1000) / 1000,
      duracion: duracion / video.escala,
    };
  }

  // Marcas de quién grabó: OBS escribe "Lavf" u "OBS"; las cámaras, su marca.
  let texto = "";
  for (let p = 0; p < Math.min(d.length, 200000); p++) if (d[p] >= 32 && d[p] < 127) texto += String.fromCharCode(d[p]);
  const marcas = ["OBS", "Lavf", "SONY", "Sony", "Canon", "Panasonic", "FUJIFILM", "Nikon", "Apple", "DJI", "GoPro", "Blackmagic"].filter((m) => texto.includes(m));

  if (!audio || !audio.stbl) return { video: infoVideo, sinAudio: true, marcas };

  const stsd = hija(d, audio.stbl, "stsd");
  const entrada = cajas(d, stsd.inicio + 8, stsd.fin)[0];
  const formato = formatoAudio(d, entrada);

  let pedazos = pedazosDeTabla(d, audio.stbl, formato);
  if (!pedazos.length && lista.some((c) => c.tipo === "moof")) {
    const trex = cajas(d, (hija(d, moov, "mvex") || moov).inicio, (hija(d, moov, "mvex") || moov).fin).find((c) => c.tipo === "trex" && u32(d, c.inicio + 4) === audio.id);
    pedazos = await pedazosFragmentados(archivo, lista, audio.id, trex ? u32(d, trex.inicio + 16) : 0);
  }
  if (!pedazos.length) throw new Error("no encontré el audio dentro del archivo");

  const inicioVideo = video ? inicioPorEdiciones(video.ediciones.filter((e) => e.tiempo === -1).slice(0, 1), escalaPelicula, video.escala) : 0;
  const inicioAudio = inicioPorEdiciones(audio.ediciones, escalaPelicula, audio.escala) - inicioVideo;

  let huella;
  let frecuencia = formato.frecuencia;
  if (formato.tipo === "aac") {
    if (!panel.aac) throw new Error("falta el decodificador AAC (aac.js)");
    const dec = panel.aac.crear(formato.asc);
    frecuencia = dec.frecuencia;
    huella = crearHuella(frecuencia);
    const mono = new Float32Array(1024);
    let relleno = new Uint8Array(8192); // el cuadro + 8 bytes en cero (el lector de bits lee de a 4)
    let errores = 0;
    await recorrerPedazos(archivo, pedazos, (bytes) => {
      let canales;
      if (bytes.length + 8 > relleno.length) relleno = new Uint8Array(bytes.length * 2 + 8);
      relleno.set(bytes);
      relleno.fill(0, bytes.length, bytes.length + 8);
      try {
        canales = dec.decodificar(relleno);
      } catch (error) {
        // Un cuadro roto no frena todo: se cuenta como silencio y se sigue.
        if (++errores > 50) throw new Error(`AAC: demasiados cuadros con error (${error.message})`);
        mono.fill(0);
        huella.agregar(mono);
        return;
      }
      const usar = Math.min(2, canales.length);
      for (let i = 0; i < 1024; i++) {
        let s = 0;
        for (let c = 0; c < usar; c++) s += canales[c][i];
        mono[i] = s / (usar * 32768);
      }
      huella.agregar(mono);
    }, alAvanzar);
  } else {
    huella = crearHuella(frecuencia);
    const porCuadro = (formato.bits / 8) * formato.canales;
    // Los chunks PCM pueden ser enormes: se parten en pedazos del tamaño del bloque.
    const partidos = [];
    const paso = Math.floor(BLOQUE / porCuadro) * porCuadro;
    for (const p of pedazos) {
      for (let a = 0; a < p.largo; a += paso) partidos.push({ pos: p.pos + a, largo: Math.min(paso, p.largo - a) });
    }
    await recorrerPedazos(archivo, partidos, (bytes) => huella.agregar(pcmAMono(bytes, formato)), alAvanzar);
  }

  return {
    video: infoVideo,
    frecuencia,
    canales: formato.canales,
    formato: formato.tipo === "aac" ? "AAC" : `PCM ${formato.bits} bits`,
    inicioAudio,
    huella: huella.terminar(),
    marcas,
  };
}

// ---------- Entrada ----------
// Devuelve { ruta, nombre, carpeta, fecha, video, frecuencia, formato, inicioAudio, duracion, huella, marcas }
// o tira un error con el motivo en castellano.
async function leerAudio(ruta, alAvanzar = () => {}) {
  const archivo = await abrir(ruta);
  try {
    const nativa = /^file:/i.test(ruta) ? panel.premiere.rutaDeUrl(ruta) : ruta;
    const partes = String(nativa).split(/[\\/]/);
    const base = {
      ruta,
      nombre: panel.premiere.normalizarTexto(partes[partes.length - 1]),
      carpeta: panel.premiere.normalizarTexto(partes[partes.length - 2] || ""),
      fecha: archivo.fecha,
    };
    const r = (await leerWAV(archivo, alAvanzar)) || (await leerMP4(archivo, alAvanzar));
    if (!r) throw new Error("formato que no conozco (leo WAV, MP4 y MOV)");
    if (r.sinAudio) return Object.assign(base, r, { huella: null, duracion: 0 });
    return Object.assign(base, r, { duracion: r.huella.length / HUELLA_HZ });
  } finally {
    await archivo.cerrar();
  }
}

panel.medios = { leerAudio, crearHuella, HUELLA_HZ };
