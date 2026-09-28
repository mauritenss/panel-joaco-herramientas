// Funciones comunes para hablar con Premiere. Todas las herramientas las usan vía panel.premiere.
// Se carga primero (ver indice.json).

const ppro = panel.ppro;

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
};
