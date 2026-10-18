// Sincro: compara las huellas de audio de los crudos y arma las tomas. Es pura cuenta, sin Premiere
// (se prueba en la compu con pruebas/sincro-prueba.js).
//
// 1. A cada huella se le saca el volumen y el ruido de fondo: queda el "ritmo" de la voz.
// 2. Cada par de archivos de aparatos distintos se compara corriendo uno sobre el otro (correlación
//    con FFT, primero gruesa a 25 por segundo y después fina a 100). Donde más se parecen, van juntos.
// 3. Con los pares seguros se arman las tomas: grupos de archivos que se grabaron a la vez.
// 4. Las tomas se ordenan por la hora de los archivos.

const HZ = panel.medios.HUELLA_HZ; // 100 casillas por segundo
const JUNTAR = 4; // la pasada gruesa usa 1 casilla cada 4 (25 por segundo)
const SOLAPE_MINIMO = 5; // segundos: menos que eso juntos no alcanza para estar seguro
const PARECIDO_MINIMO = 0.25;
const SEGURIDAD_MINIMA = 1.3; // el mejor lugar le tiene que ganar por esto al segundo mejor

// ---------- Rasgo: la huella sin volumen ni ruido de fondo ----------

function normalizar(valores) {
  const n = valores.length;
  let suma2 = 0;
  for (let i = 0; i < n; i++) suma2 += valores[i] * valores[i];
  const desvio = Math.sqrt(suma2 / n);
  if (desvio < 1e-6) return null;
  const tope = 3 * desvio;
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) r[i] = Math.max(-tope, Math.min(tope, valores[i])) / desvio;
  return r;
}

// Devuelve null si no hay voz (silencio, un tono parejo): esos archivos no se pueden sincronizar.
function prepararRasgo(energia) {
  const n = energia.length;
  if (n < 2 * HZ) return null;
  const ordenadas = Float32Array.from(energia).sort();
  const piso = Math.max(ordenadas[Math.floor(n * 0.1)], 1e-12);
  const prefijo = new Float64Array(n + 1);
  const log = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    log[i] = Math.log10(energia[i] + piso);
    prefijo[i + 1] = prefijo[i] + log[i];
  }
  // Se resta el promedio del segundo alrededor: así no importa el volumen ni el ruido de cada micrófono.
  const radio = HZ / 2;
  const plano = new Float32Array(n);
  let suma2 = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - radio);
    const b = Math.min(n, i + radio + 1);
    plano[i] = log[i] - (prefijo[b] - prefijo[a]) / (b - a);
    suma2 += plano[i] * plano[i];
  }
  if (Math.sqrt(suma2 / n) < 0.03) return null;
  const fino = normalizar(plano);
  const grueso = new Float32Array(Math.floor(n / JUNTAR));
  for (let i = 0; i < grueso.length; i++) {
    let s = 0;
    for (let k = 0; k < JUNTAR; k++) s += fino[i * JUNTAR + k];
    grueso[i] = s / JUNTAR;
  }
  return { fino, grueso: normalizar(grueso), espectros: new Map() };
}

// ---------- FFT ----------

const tablasFFT = new Map();
function tablas(n) {
  if (!tablasFFT.has(n)) {
    const cos = new Float64Array(n / 2);
    const sen = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sen[i] = Math.sin((2 * Math.PI * i) / n);
    }
    const inv = new Uint32Array(n);
    const bitsN = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bitsN; b++) r = (r << 1) | ((i >> b) & 1);
      inv[i] = r;
    }
    tablasFFT.set(n, { cos, sen, inv });
  }
  return tablasFFT.get(n);
}

// FFT en el lugar (radix 2). inversa = true no divide por n.
function fft(re, im, inversa) {
  const n = re.length;
  const { cos, sen, inv } = tablas(n);
  for (let i = 0; i < n; i++) {
    const j = inv[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  const signo = inversa ? 1 : -1;
  for (let largo = 2; largo <= n; largo <<= 1) {
    const medio = largo >> 1;
    const paso = n / largo;
    for (let i = 0; i < n; i += largo) {
      for (let j = 0, k = 0; j < medio; j++, k += paso) {
        const wr = cos[k];
        const wi = signo * sen[k];
        const a = i + j;
        const b = a + medio;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

const potencia2 = (n) => 2 ** Math.ceil(Math.log2(n));

// Espectro de la pasada gruesa, guardado por tamaño (se reusa en todos los pares del archivo).
function espectro(rasgo, n) {
  if (!rasgo.espectros.has(n)) {
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    re.set(rasgo.grueso);
    fft(re, im, false);
    rasgo.espectros.set(n, { re: Float32Array.from(re), im: Float32Array.from(im) });
  }
  return rasgo.espectros.get(n);
}

// ---------- Comparar dos archivos ----------

// Parecido de b corrido "lag" casillas sobre a (b[t] contra a[t + lag]), solo en la parte que se pisan.
function parecidoEn(a, b, lag, desde = 0, hasta = Infinity) {
  const i0 = Math.max(0, -lag, desde);
  const i1 = Math.min(b.length, a.length - lag, hasta);
  if (i1 - i0 < 10) return { r: -1, solape: 0 };
  let ab = 0, aa = 0, bb = 0;
  for (let i = i0; i < i1; i++) {
    const x = a[i + lag];
    const y = b[i];
    ab += x * y;
    aa += x * x;
    bb += y * y;
  }
  return { r: ab / Math.sqrt(aa * bb || 1), solape: i1 - i0 };
}

// El mejor lag fino (con decimales) cerca de "centro", mirando ±radio casillas.
function mejorCerca(a, b, centro, radio, desde, hasta) {
  let mejor = { lag: centro, r: -2 };
  const rs = new Map();
  for (let lag = centro - radio; lag <= centro + radio; lag++) {
    const { r } = parecidoEn(a, b, lag, desde, hasta);
    rs.set(lag, r);
    if (r > mejor.r) mejor = { lag, r };
  }
  // Parábola entre los vecinos para afinar por debajo de los 10 ms.
  const izq = rs.get(mejor.lag - 1);
  const der = rs.get(mejor.lag + 1);
  if (izq !== undefined && der !== undefined) {
    const den = izq - 2 * mejor.r + der;
    if (den < 0) mejor.lag += Math.max(-0.5, Math.min(0.5, (0.5 * (izq - der)) / den));
  }
  return mejor;
}

// Compara dos archivos. Devuelve { desfase, parecido, seguridad, solape, deriva } o null si no van juntos.
// desfase = cuántos segundos después del arranque de A arranca B (en tiempo de clip, contando inicioAudio).
function comparar(A, B) {
  const a = A.rasgo.grueso;
  const b = B.rasgo.grueso;
  const n = potencia2(a.length + b.length);
  const ea = espectro(A.rasgo, n);
  const eb = espectro(B.rasgo, n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    re[k] = ea.re[k] * eb.re[k] + ea.im[k] * eb.im[k];
    im[k] = ea.im[k] * eb.re[k] - ea.re[k] * eb.im[k];
  }
  fft(re, im, true);

  // Energía acumulada para normalizar cada lag por la parte que se pisan.
  const pa = new Float64Array(a.length + 1);
  const pb = new Float64Array(b.length + 1);
  for (let i = 0; i < a.length; i++) pa[i + 1] = pa[i] + a[i] * a[i];
  for (let i = 0; i < b.length; i++) pb[i + 1] = pb[i] + b[i] * b[i];

  const minimo = Math.round((SOLAPE_MINIMO * HZ) / JUNTAR);
  const puntajes = new Float64Array(a.length + b.length);
  const desdeLag = -(b.length - minimo);
  const hastaLag = a.length - minimo;
  if (hastaLag < desdeLag) return null;
  let mejor = -Infinity;
  let mejorLag = 0;
  for (let lag = desdeLag; lag <= hastaLag; lag++) {
    const a0 = Math.max(0, lag);
    const a1 = Math.min(a.length, lag + b.length);
    const b0 = Math.max(0, -lag);
    const b1 = Math.min(b.length, a.length - lag);
    const c = re[lag >= 0 ? lag : n + lag] / n;
    const r = c / Math.sqrt((pa[a1] - pa[a0]) * (pb[b1] - pb[b0]) || 1);
    const puntaje = r * Math.sqrt(a1 - a0);
    puntajes[lag - desdeLag] = puntaje;
    if (puntaje > mejor) {
      mejor = puntaje;
      mejorLag = lag;
    }
  }
  // El segundo mejor, a más de un segundo del mejor: si están parejos, no es seguro.
  let segundo = 0;
  const lejos = HZ / JUNTAR;
  for (let lag = desdeLag; lag <= hastaLag; lag++) {
    if (Math.abs(lag - mejorLag) > lejos) segundo = Math.max(segundo, puntajes[lag - desdeLag]);
  }
  const seguridad = segundo > 0 ? mejor / segundo : 99;

  // Pasada fina a 100 por segundo alrededor del mejor lugar.
  const fa = A.rasgo.fino;
  const fb = B.rasgo.fino;
  const fino = mejorCerca(fa, fb, mejorLag * JUNTAR, JUNTAR * 2);
  const { solape } = parecidoEn(fa, fb, Math.round(fino.lag));
  if (fino.r < PARECIDO_MINIMO || seguridad < SEGURIDAD_MINIMA || solape < SOLAPE_MINIMO * HZ) return null;

  // Deriva: se mide el lag en el primer y el último tercio de lo que se pisan.
  let deriva = 0;
  if (solape >= 60 * HZ) {
    const lag0 = Math.round(fino.lag);
    const i0 = Math.max(0, -lag0);
    const tercio = Math.floor(solape / 3);
    const primero = mejorCerca(fa, fb, lag0, 30, i0, i0 + tercio);
    const ultimo = mejorCerca(fa, fb, lag0, 30, i0 + 2 * tercio, i0 + solape);
    deriva = (ultimo.lag - primero.lag) / HZ; // segundos de diferencia entre principio y final
  }

  return {
    desfase: A.inicioAudio + fino.lag / HZ - B.inicioAudio,
    parecido: fino.r,
    seguridad,
    solape: solape / HZ,
    deriva,
    puntaje: fino.r * Math.sqrt(solape / HZ),
  };
}

// ---------- Aparatos ----------
// Cada archivo se asigna a un aparato (la cámara, la pantalla, el grabador): misma carpeta y mismo formato.
// Un aparato no puede grabar dos archivos a la vez, así que los de un mismo aparato no se comparan.
// Para saber si un video es la pantalla o la cámara se suman pistas: nombre de OBS, carpeta, marca.
const NOMBRE_OBS = /^\d{4}-\d{2}-\d{2}[ _]\d{2}-\d{2}-\d{2}/;
const CARPETA_PANTALLA = /pantalla|screen|obs|captura|grabaci|display|monitor/i;
const CARPETA_CAMARA = /c[aá]mara|camera|\bcam\b|video|sony|canon|lumix|fuji/i;
const MARCAS_CAMARA = ["SONY", "Sony", "Canon", "Panasonic", "FUJIFILM", "Nikon", "DJI", "GoPro", "Blackmagic"];

function puntosPantalla(l) {
  let p = 0;
  if (NOMBRE_OBS.test(l.nombre)) p += 3;
  if (CARPETA_PANTALLA.test(l.carpeta)) p += 3;
  if (CARPETA_CAMARA.test(l.carpeta)) p -= 3;
  if (l.marcas.includes("OBS")) p += 2;
  if (l.marcas.includes("Lavf")) p += 1;
  if (l.marcas.some((m) => MARCAS_CAMARA.includes(m))) p -= 2;
  const proporcion = l.video.ancho / (l.video.alto || 1);
  if (Math.abs(proporcion - 16 / 9) > 0.02 && Math.abs(proporcion - 9 / 16) > 0.02) p += 1;
  return p;
}

// Agrega a cada lectura { aparato, categoria } con categoria "audio", "camara" o "pantalla".
function clasificar(lecturas) {
  const aparatos = new Map();
  for (const l of lecturas) {
    l.aparato = l.video
      ? `video|${l.carpeta}|${l.video.codec}|${l.video.ancho}x${l.video.alto}`
      : `audio|${l.carpeta}|${l.formato}|${l.frecuencia}`;
    if (!aparatos.has(l.aparato)) aparatos.set(l.aparato, []);
    aparatos.get(l.aparato).push(l);
  }
  for (const lista of aparatos.values()) {
    let categoria = "audio";
    if (lista[0].video) categoria = lista.reduce((s, l) => s + puntosPantalla(l), 0) > 0 ? "pantalla" : "camara";
    for (const l of lista) l.categoria = categoria;
  }
  return lecturas;
}

// ---------- Comparar todos con todos ----------
// clips: [{ nombre, aparato, rasgo, inicioAudio, duracion, fecha }]
// Compara cada par de aparatos distintos. Cada tanto suelta el control para que el panel se redibuje.
async function compararTodos(clips, alAvanzar = () => {}) {
  const pares = [];
  const candidatos = [];
  for (let i = 0; i < clips.length; i++) {
    for (let j = i + 1; j < clips.length; j++) {
      if (clips[i].rasgo && clips[j].rasgo && clips[i].aparato !== clips[j].aparato) candidatos.push([i, j]);
    }
  }
  for (let k = 0; k < candidatos.length; k++) {
    const [i, j] = candidatos[k];
    const r = comparar(clips[i], clips[j]);
    if (r) pares.push(Object.assign({ a: i, b: j }, r));
    alAvanzar((k + 1) / candidatos.length);
    await new Promise((listo) => setTimeout(listo, 0));
  }
  for (const c of clips) if (c.rasgo) c.rasgo.espectros.clear();
  return pares;
}

// ---------- Armar las tomas ----------
// Devuelve { tomas: [{ clips: [{ i, inicio }], duracion, hora }], avisos }, con las tomas en orden.
function armarTomas(clips, pares) {
  pares.sort((x, y) => y.puntaje - x.puntaje);

  // Cada clip arranca en su propio grupo; los pares más seguros van juntando grupos.
  const grupoDe = clips.map((c, i) => i);
  const grupos = clips.map((c, i) => new Map([[i, 0]]));
  const avisos = [];
  const choca = (destino, origen, corrimiento) => {
    for (const [i, ti] of origen) {
      for (const [k, tk] of destino) {
        if (clips[i].aparato !== clips[k].aparato) continue;
        const a0 = ti + corrimiento;
        const solape = Math.min(a0 + clips[i].duracion, tk + clips[k].duracion) - Math.max(a0, tk);
        if (solape > 1) return true;
      }
    }
    return false;
  };
  for (const p of pares) {
    const ga = grupoDe[p.a];
    const gb = grupoDe[p.b];
    if (ga === gb) {
      const esperado = grupos[ga].get(p.b) - grupos[ga].get(p.a);
      if (Math.abs(esperado - p.desfase) > 0.1) p.descartado = true;
      continue;
    }
    const corrimiento = grupos[ga].get(p.a) + p.desfase - grupos[gb].get(p.b);
    if (choca(grupos[ga], grupos[gb], corrimiento)) {
      p.descartado = true;
      continue;
    }
    for (const [i, t] of grupos[gb]) {
      grupos[ga].set(i, t + corrimiento);
      grupoDe[i] = ga;
    }
    grupos[gb].clear();
    p.usado = true;
  }

  const mediana = (lista) => {
    const o = lista.slice().sort((x, y) => x - y);
    return o[Math.floor(o.length / 2)];
  };
  const tomas = grupos
    .filter((g) => g.size)
    .map((g) => {
      const inicio = Math.min(...[...g.values()]);
      const lista = [...g].map(([i, t]) => ({ i, inicio: t - inicio })).sort((x, y) => x.inicio - y.inicio);
      const duracion = Math.max(...lista.map((c) => c.inicio + clips[c.i].duracion));
      // Hora en que arrancó la toma según cada archivo (fecha de modificación = cuando terminó de grabar).
      const hora = mediana(lista.map((c) => clips[c.i].fecha - (clips[c.i].duracion + c.inicio) * 1000));
      return { clips: lista, duracion, hora };
    })
    .sort((x, y) => x.hora - y.hora || clips[x.clips[0].i].nombre.localeCompare(clips[y.clips[0].i].nombre));

  for (const p of pares.filter((x) => x.usado && Math.abs(x.deriva) > 0.02)) {
    avisos.push(`${clips[p.a].nombre} y ${clips[p.b].nombre} se van separando ${Math.round(Math.abs(p.deriva) * 1000)} ms de punta a punta (relojes distintos): quedan alineados en el medio.`);
  }
  return { tomas, avisos };
}

panel.sincro = { prepararRasgo, clasificar, comparar, compararTodos, armarTomas, fft };
