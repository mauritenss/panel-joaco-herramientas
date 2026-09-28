// Dibujo y medición de imágenes, sin librerías.
// - leerBMP: lee el cuadro que exporta Premiere (BMP de 24 o 32 bits).
// - cajaDelTexto: rectángulo que ocupa lo que no es negro (el texto solo, con las demás pistas apagadas).
// - recuadroTGA: rectángulo redondeado con borde, suavizado, en un TGA con transparencia (RLE).

function leerBMP(buffer) {
  const datos = new DataView(buffer);
  const inicio = datos.getUint32(10, true);
  const ancho = datos.getInt32(18, true);
  const altoCrudo = datos.getInt32(22, true);
  const bits = datos.getUint16(28, true);
  const alto = Math.abs(altoCrudo);
  const deAbajo = altoCrudo > 0;
  const bytes = bits / 8;
  const paso = Math.ceil((ancho * bytes) / 4) * 4;
  return {
    ancho,
    alto,
    brillo(x, y) {
      const fila = deAbajo ? alto - 1 - y : y;
      const i = inicio + fila * paso + x * bytes;
      return Math.max(datos.getUint8(i), datos.getUint8(i + 1), datos.getUint8(i + 2));
    },
  };
}

function cajaDelTexto(imagen, umbral = 60) {
  let x0 = imagen.ancho, y0 = imagen.alto, x1 = -1, y1 = -1;
  for (let y = 0; y < imagen.alto; y++) {
    for (let x = 0; x < imagen.ancho; x++) {
      if (imagen.brillo(x, y) > umbral) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, ancho: x1 - x0 + 1, alto: y1 - y0 + 1 };
}

function colorRGB(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Distancia con signo a un rectángulo redondeado (negativa adentro).
function distancia(px, py, cx, cy, mitadX, mitadY, radio) {
  const qx = Math.abs(px - cx) - (mitadX - radio);
  const qy = Math.abs(py - cy) - (mitadY - radio);
  const afuera = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return afuera + Math.min(Math.max(qx, qy), 0) - radio;
}

const cubrir = (d) => Math.min(1, Math.max(0, 0.5 - d));

// Devuelve los bytes de un TGA del tamaño del cuadro con el recuadro dibujado en `caja`.
function recuadroTGA(anchoCuadro, altoCuadro, caja, relleno, borde, radio, grosor) {
  const [fr, fg, fb] = colorRGB(relleno);
  const [br, bg, bb] = colorRGB(borde);
  const cx = caja.x + caja.ancho / 2;
  const cy = caja.y + caja.alto / 2;
  const mx = caja.ancho / 2;
  const my = caja.alto / 2;
  const partes = [];

  const cabecera = new Uint8Array(18);
  cabecera[2] = 10; // color verdadero con RLE
  cabecera[12] = anchoCuadro & 255;
  cabecera[13] = anchoCuadro >> 8;
  cabecera[14] = altoCuadro & 255;
  cabecera[15] = altoCuadro >> 8;
  cabecera[16] = 32;
  cabecera[17] = 0x28; // origen arriba a la izquierda, 8 bits de alfa
  partes.push(cabecera);

  const fila = new Uint8Array(anchoCuadro * 4);
  const salida = new Uint8Array(anchoCuadro * 5 + 16);
  for (let y = 0; y < altoCuadro; y++) {
    fila.fill(0);
    const py = y + 0.5;
    if (py > caja.y - 2 && py < caja.y + caja.alto + 2) {
      const desde = Math.max(0, Math.floor(caja.x - 2));
      const hasta = Math.min(anchoCuadro, Math.ceil(caja.x + caja.ancho + 2));
      for (let x = desde; x < hasta; x++) {
        const d = distancia(x + 0.5, py, cx, cy, mx, my, radio);
        const exterior = cubrir(d);
        if (exterior <= 0) continue;
        const interior = cubrir(d + grosor);
        const lineaBorde = exterior - interior;
        const i = x * 4;
        fila[i] = Math.round((fb * interior + bb * lineaBorde) / exterior);
        fila[i + 1] = Math.round((fg * interior + bg * lineaBorde) / exterior);
        fila[i + 2] = Math.round((fr * interior + br * lineaBorde) / exterior);
        fila[i + 3] = Math.round(exterior * 255);
      }
    }
    // Compresión RLE de la fila (paquetes de hasta 128 píxeles)
    let n = 0;
    let x = 0;
    while (x < anchoCuadro) {
      let largo = 1;
      while (
        x + largo < anchoCuadro && largo < 128 &&
        fila[(x + largo) * 4] === fila[x * 4] && fila[(x + largo) * 4 + 1] === fila[x * 4 + 1] &&
        fila[(x + largo) * 4 + 2] === fila[x * 4 + 2] && fila[(x + largo) * 4 + 3] === fila[x * 4 + 3]
      ) largo++;
      if (largo > 1) {
        salida[n++] = 0x80 | (largo - 1);
        salida.set(fila.subarray(x * 4, x * 4 + 4), n);
        n += 4;
        x += largo;
      } else {
        let crudos = 1;
        while (x + crudos < anchoCuadro && crudos < 128) {
          const j = (x + crudos) * 4;
          if (x + crudos + 1 < anchoCuadro && fila[j] === fila[j + 4] && fila[j + 1] === fila[j + 5] &&
              fila[j + 2] === fila[j + 6] && fila[j + 3] === fila[j + 7]) break;
          crudos++;
        }
        salida[n++] = crudos - 1;
        salida.set(fila.subarray(x * 4, (x + crudos) * 4), n);
        n += crudos * 4;
        x += crudos;
      }
    }
    partes.push(salida.slice(0, n));
  }

  const total = partes.reduce((suma, p) => suma + p.length, 0);
  const archivo = new Uint8Array(total);
  let pos = 0;
  for (const p of partes) {
    archivo.set(p, pos);
    pos += p.length;
  }
  return archivo;
}

panel.dibujo = { leerBMP, cajaDelTexto, recuadroTGA };
