// Destacar: la entrada de los recuadros de Joaco.
// El clip entra borroso y semitransparente y en pocos cuadros queda nítido.
// Medido en el video "Astra 6": 2 cuadros a 30 fps.

const ppro = panel.ppro;
const p = panel.premiere;

const DESENFOQUE_INICIAL = 40;
const OPACIDAD_INICIAL = 30;
const OPCIONES_CUADROS = [2, 3, 4];

let cuadrosElegidos = 2;

async function matchNameDesenfoque() {
  const nombres = await ppro.VideoFilterFactory.getMatchNames();
  if (nombres.includes("AE.ADBE Gaussian Blur 2")) return "AE.ADBE Gaussian Blur 2";
  return nombres.find((nombre) => /gaussian blur/i.test(nombre)) || null;
}

async function destacarClip(proyecto, clip, duracion, matchBlur) {
  const nombre = await clip.getName();

  let cadena = await clip.getComponentChain();
  let desenfoque = await p.buscarComponente(cadena, matchBlur);
  if (!desenfoque) {
    const nuevo = await ppro.VideoFilterFactory.createComponent(matchBlur);
    p.transaccion(proyecto, "Destacar: agregar desenfoque", (c) =>
      c.addAction(cadena.createAppendComponentAction(nuevo))
    );
    cadena = await clip.getComponentChain();
    desenfoque = await p.buscarComponente(cadena, matchBlur);
  }

  const opacidad = await p.buscarComponente(cadena, "AE.ADBE Opacity");
  if (!desenfoque || !opacidad) {
    panel.log(`"${nombre}": no encontré ${!desenfoque ? "el desenfoque" : "la opacidad"}.`, "error");
    return false;
  }

  const inicio = await clip.getInPoint();
  const fin = inicio.add(duracion);

  p.animar(proyecto, opacidad.getParam(0), [
    [inicio, OPACIDAD_INICIAL],
    [fin, 100],
  ]);
  p.animar(proyecto, desenfoque.getParam(0), [
    [inicio, DESENFOQUE_INICIAL],
    [fin, 0],
  ]);

  panel.log(`"${nombre}" destacado (keyframes en ${inicio.seconds.toFixed(3)}s y ${fin.seconds.toFixed(3)}s del clip).`, "ok");
  return true;
}

async function destacarSeleccion() {
  const ctx = await p.contexto();
  if (!ctx) return;

  const clips = await p.clipsSeleccionados(ctx.secuencia);
  if (!clips.length) {
    panel.log("Seleccioná uno o más clips en la línea de tiempo.", "error");
    return;
  }

  const matchBlur = await matchNameDesenfoque();
  if (!matchBlur) {
    panel.log("No encontré el efecto Desenfoque gaussiano en este Premiere.", "error");
    return;
  }

  const duracion = await p.cuadros(ctx.secuencia, cuadrosElegidos);
  let hechos = 0;
  for (const clip of clips) {
    try {
      if (await destacarClip(ctx.proyecto, clip, duracion, matchBlur)) hechos++;
    } catch (error) {
      panel.log(`Error en un clip: ${error.message}`, "error");
    }
  }
  panel.log(`Listo: ${hechos} de ${clips.length} clips.`, hechos ? "ok" : "error");
}

panel.registrar({
  nombre: "Destacar",
  descripcion: "Entrada con desenfoque para los clips seleccionados.",

  dibujar(caja) {
    const fila = document.createElement("div");
    fila.className = "fila";

    const etiqueta = document.createElement("span");
    etiqueta.textContent = "Cuadros:";
    fila.appendChild(etiqueta);

    const botones = [];
    for (const cantidad of OPCIONES_CUADROS) {
      const boton = document.createElement("button");
      boton.textContent = String(cantidad);
      boton.className = cantidad === cuadrosElegidos ? "chico elegido" : "chico";
      boton.addEventListener("click", () => {
        cuadrosElegidos = cantidad;
        botones.forEach((b) => (b.className = "chico"));
        boton.className = "chico elegido";
      });
      botones.push(boton);
      fila.appendChild(boton);
    }
    caja.appendChild(fila);

    const accion = document.createElement("button");
    accion.className = "principal";
    accion.textContent = "Destacar lo seleccionado";
    accion.addEventListener("click", () =>
      destacarSeleccion().catch((error) => panel.log(`Error: ${error.message}`, "error"))
    );
    caja.appendChild(accion);
  },
});
