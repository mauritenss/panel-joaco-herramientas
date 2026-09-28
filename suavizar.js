// Suavizar: lo que Joaco hace a mano con los keyframes (Ease In / Ease Out y estirar los tiradores
// del bezier en el gráfico de velocidad), en un clic. Se elige la influencia (25, 50, 75, 90) y se
// aplica a todos los parámetros animados de los clips seleccionados: escala, posición, rotación...
//
// Premiere no deja mover los tiradores del bezier por código (API UXP 26.5: solo deja elegir el tipo
// de keyframe). Por eso se calcula la curva con esa influencia, igual que en After Effects, y entre
// cada par de keyframes de Joaco se escribe un keyframe lineal por cuadro. Se ve igual.
//
// Cada vez que se toca un número se recalcula desde el primer y el último keyframe de cada
// movimiento, aunque haya otros en el medio: Joaco puede estirar el último y volver a tocar 90.
// "Limpiar" borra los del medio y deja solo los de Joaco, para moverlos cómodo.

const ppro = panel.ppro;
const p = panel.premiere;

const INFLUENCIAS = [25, 50, 75, 90];
const MAX_ACCIONES = 40; // Premiere no acepta más de ~50 acciones por transacción

// Cuánto del cambio va hecho (0 a 1) en el momento u (0 a 1) del tramo. Es la curva de After
// Effects con velocidad 0 en las dos puntas: un bezier con los tiradores planos y de largo
// "influencia" (0 a 1). Se busca por mitades el punto de la curva que cae en u.
function curva(u, influencia) {
  const tiempo = (s) => 3 * (1 - s) * (1 - s) * s * influencia + 3 * (1 - s) * s * s * (1 - influencia) + s * s * s;
  let bajo = 0;
  let alto = 1;
  for (let i = 0; i < 40; i++) {
    const medio = (bajo + alto) / 2;
    if (tiempo(medio) < u) bajo = medio;
    else alto = medio;
  }
  const s = (bajo + alto) / 2;
  return 3 * (1 - s) * s * s + s * s * s;
}

// Premiere devuelve los puntos como [x, y] o como {x, y}. Se trabaja siempre con una lista de números.
// Lo que no es número ni punto (casillas, colores, textos) devuelve null y no se toca.
function aNumeros(valor) {
  if (typeof valor === "number") return [valor];
  if (Array.isArray(valor) && valor.length === 2 && valor.every((n) => typeof n === "number")) return valor.slice();
  if (valor && typeof valor.x === "number" && typeof valor.y === "number") return [valor.x, valor.y];
  return null;
}

function desdeNumeros(numeros) {
  return numeros.length === 1 ? numeros[0] : new ppro.PointF(numeros[0], numeros[1]);
}

function leerClaves(parametro) {
  return parametro.getKeyframeListAsTickTimes().map((tiempo) => ({
    tiempo,
    ticks: Number(tiempo.ticks),
    valor: aNumeros(parametro.getKeyframePtr(tiempo).value.value),
  }));
}

// Un keyframe es intermedio si su valor está entre el de sus vecinos: el movimiento sigue para el
// mismo lado. Quedan el primero y el último de cada movimiento, los picos y las partes quietas.
function esIntermedio(claves, i) {
  const antes = claves[i - 1];
  const este = claves[i];
  const despues = claves[i + 1];
  if (!antes || !despues) return false;

  let seMueve = false;
  for (let k = 0; k < este.valor.length; k++) {
    const a = antes.valor[k];
    const b = este.valor[k];
    const c = despues.valor[k];
    if (a === b && b === c) continue;
    if (!((a < b && b < c) || (a > b && b > c))) return false;
    seMueve = true;
  }
  return seMueve;
}

// Aplica las acciones de a tandas. Cada una se arma adentro de la transacción.
function enTandas(proyecto, nombre, armadores) {
  for (let i = 0; i < armadores.length; i += MAX_ACCIONES) {
    const tanda = armadores.slice(i, i + MAX_ACCIONES);
    const ok = p.transaccion(proyecto, nombre, (c) => {
      for (const armar of tanda) c.addAction(armar());
    });
    if (!ok) throw new Error(`Premiere no aceptó "${nombre}".`);
  }
}

// Separa los keyframes de Joaco (principales) de los del medio. Null si no hay nada que tocar.
function separar(parametro) {
  const todas = leerClaves(parametro);
  if (todas.length < 2 || todas.some((clave) => !clave.valor)) return null;
  const principales = todas.filter((clave, i) => !esIntermedio(todas, i));
  const intermedias = todas.filter((clave) => !principales.includes(clave));
  return { principales, intermedias };
}

function borrarIntermedias(proyecto, parametro, intermedias) {
  enTandas(proyecto, "Suavizar: limpiar", intermedias.map((clave) => () => parametro.createRemoveKeyframeAction(clave.tiempo)));
}

// Devuelve cuántos keyframes del medio borró en este parámetro.
function limpiarParametro(proyecto, parametro) {
  const partes = separar(parametro);
  if (!partes || !partes.intermedias.length) return 0;
  borrarIntermedias(proyecto, parametro, partes.intermedias);
  return partes.intermedias.length;
}

// Devuelve cuántos tramos suavizó en este parámetro.
function suavizarParametro(proyecto, parametro, influencia, cuadro) {
  const partes = separar(parametro);
  if (!partes) return 0;
  const { principales, intermedias } = partes;

  const nuevas = [];
  let tramos = 0;
  for (let i = 0; i + 1 < principales.length; i++) {
    const a = principales[i];
    const b = principales[i + 1];
    if (a.valor.every((v, k) => v === b.valor[k])) continue;
    const pasos = Math.round((b.ticks - a.ticks) / cuadro);
    for (let n = 1; n < pasos; n++) {
      const avance = curva(n / pasos, influencia);
      nuevas.push({
        tiempo: ppro.TickTime.createWithTicks(String(Math.round(a.ticks + ((b.ticks - a.ticks) * n) / pasos))),
        valor: a.valor.map((v, k) => v + (b.valor[k] - v) * avance),
      });
    }
    tramos++;
  }
  if (!tramos) return 0;

  borrarIntermedias(proyecto, parametro, intermedias);
  enTandas(
    proyecto,
    "Suavizar: curva",
    nuevas.map((clave) => () => {
      const nueva = parametro.createKeyframe(desdeNumeros(clave.valor));
      nueva.position = clave.tiempo;
      return parametro.createAddKeyframeAction(nueva);
    })
  );
  const lineal = ppro.Constants.InterpolationMode.LINEAR;
  enTandas(
    proyecto,
    "Suavizar: lineal",
    [...principales, ...nuevas].map((clave) => () => parametro.createSetInterpolationAtKeyframeAction(clave.tiempo, lineal))
  );
  return tramos;
}

// Pasa por cada parámetro animado de los clips seleccionados. "hacer" devuelve cuánto cambió.
// Devuelve { total, tocados } o null si no había nada seleccionado.
async function recorrerAnimados(hacer) {
  const ctx = await p.contexto();
  if (!ctx) return null;

  const clips = await p.clipsSeleccionados(ctx.secuencia);
  if (!clips.length) {
    panel.log("Seleccioná uno o más clips con keyframes.", "error");
    return null;
  }

  const cuadro = Number(await ctx.secuencia.getTimebase());
  let total = 0;
  const tocados = new Set();
  for (const clip of clips) {
    const cadena = await clip.getComponentChain();
    for (let i = 0; i < cadena.getComponentCount(); i++) {
      const componente = cadena.getComponentAtIndex(i);
      for (let j = 0; j < componente.getParamCount(); j++) {
        const parametro = componente.getParam(j);
        try {
          if (!parametro.isTimeVarying()) continue;
          const hechos = hacer(ctx.proyecto, parametro, cuadro);
          if (hechos) {
            total += hechos;
            tocados.add(parametro.displayName);
          }
        } catch (error) {
          panel.log(`${parametro.displayName}: ${error.message}`, "error");
        }
      }
    }
  }
  return { total, tocados: [...tocados].join(", ") };
}

async function suavizar(porcentaje) {
  const r = await recorrerAnimados((proyecto, parametro, cuadro) =>
    suavizarParametro(proyecto, parametro, porcentaje / 100, cuadro)
  );
  if (!r) return;
  if (!r.total) {
    panel.log("No encontré keyframes para suavizar (hacen falta dos con valores distintos).", "error");
    return;
  }
  panel.log(`Influencia ${porcentaje}: ${r.total} tramo${r.total === 1 ? "" : "s"} (${r.tocados}).`, "ok");
}

async function limpiar() {
  const r = await recorrerAnimados((proyecto, parametro) => limpiarParametro(proyecto, parametro));
  if (!r) return;
  if (!r.total) {
    panel.log("No había keyframes en el medio para borrar.", "ok");
    return;
  }
  panel.log(`Limpio: borré ${r.total} keyframes del medio (${r.tocados}).`, "ok");
}

panel.suavizar = suavizar;
panel.limpiarSuavizado = limpiar;

function crearBoton(texto, ancho, accion) {
  const boton = document.createElement("div");
  boton.className = "boton-color";
  boton.textContent = texto;
  boton.style.flex = ancho;
  boton.style.backgroundColor = "#2d2d2d";
  boton.style.borderColor = "#4a4a4a";
  boton.addEventListener("click", async () => {
    boton.classList.add("trabajando");
    try {
      await accion();
    } catch (error) {
      panel.log(`Error: ${error.message}`, "error");
    } finally {
      boton.classList.remove("trabajando");
    }
  });
  return boton;
}

panel.registrar({
  nombre: "Suavizar",
  descripcion: "Seleccioná los clips con keyframes y tocá la influencia. Para cambiar el tiempo, estirá el último keyframe y volvé a tocarla.",

  dibujar(caja) {
    const fila = document.createElement("div");
    fila.className = "colores";
    for (const porcentaje of INFLUENCIAS) {
      fila.appendChild(crearBoton(String(porcentaje), "1 1 40px", () => suavizar(porcentaje)));
    }
    fila.appendChild(crearBoton("Limpiar", "1 1 100%", limpiar));
    caja.appendChild(fila);
  },
});
