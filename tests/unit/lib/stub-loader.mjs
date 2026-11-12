// Resolve hook mínimo: mapeia `base44:runtime` (especifier do Deno, inexistente
// no Node) para um stub local. Todo o resto usa o loader padrão do Node — o
// stripping de tipos dos arquivos .ts continua sendo o nativo.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "base44:runtime") {
    return {
      url: new URL("./base44-runtime-stub.mjs", import.meta.url).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}