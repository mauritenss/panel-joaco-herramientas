// Inspector: lista qué efectos y parámetros tiene el clip seleccionado.
// Sirve para descubrir qué se puede tocar por código (por ejemplo, el fondo de un texto).

const p = panel.premiere;

function mostrarValor(valor) {
  if (valor === null || valor === undefined) return "—";
  // Los keyframes traen el dato en valor.value.value
  let crudo = valor;
  while (crudo && typeof crudo === "object" && crudo.value !== undefined) crudo = crudo.value;
  let texto;
  try {
    texto = typeof crudo === "object" ? JSON.stringify(crudo) : String(crudo);
  } catch (error) {
    texto = String(crudo);
  }
  return texto.length > 80 ? `${texto.slice(0, 80)}…` : texto;
}

async function inspeccionar() {
  const ctx = await p.contexto();
  if (!ctx) return;

  const clips = await p.clipsSeleccionados(ctx.secuencia);
  if (clips.length !== 1) {
    panel.log("Seleccioná un solo clip para inspeccionar.", "error");
    return;
  }

  const clip = clips[0];
  const inicio = await clip.getStartTime();
  const entrada = await clip.getInPoint();
  const duracion = await clip.getDuration();
  panel.log(`Clip "${await clip.getName()}": empieza en ${inicio.seconds.toFixed(3)}s, in ${entrada.seconds.toFixed(3)}s, dura ${duracion.seconds.toFixed(3)}s.`);

  const cadena = await clip.getComponentChain();
  const total = cadena.getComponentCount();
  for (let i = 0; i < total; i++) {
    const componente = cadena.getComponentAtIndex(i);
    const nombre = await componente.getDisplayName();
    const matchName = await componente.getMatchName();
    panel.log(`[${i}] ${nombre}  (${matchName})`);

    const parametros = componente.getParamCount();
    for (let j = 0; j < parametros; j++) {
      const parametro = componente.getParam(j);
      let valor;
      try {
        valor = mostrarValor(await parametro.getStartValue());
      } catch (error) {
        valor = `(no se puede leer: ${error.message})`;
      }
      const animado = parametro.isTimeVarying() ? " · animado" : "";
      panel.log(`    ${j}. ${parametro.displayName} = ${valor}${animado}`);
    }
  }
  panel.log("Fin de la inspección. Tocá Copiar y pegámelo.", "ok");
}

panel.registrar({
  nombre: "Inspector",
  descripcion: "Diagnóstico: efectos y valores del clip seleccionado.",

  dibujar(caja) {
    const boton = document.createElement("button");
    boton.textContent = "Inspeccionar clip";
    boton.addEventListener("click", () =>
      inspeccionar().catch((error) => panel.log(`Error: ${error.message}`, "error"))
    );
    caja.appendChild(boton);
  },
});
