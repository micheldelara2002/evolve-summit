// Resolve hook mínimo: mapeia `base44:runtime` (especifier do Deno, inexistente
// no Node) para um stub local e `npm:@base44/sdk` para um SDK falso controlado
// pelo teste (caminho HTTP de entry.ts). Todo o resto usa o loader padrão do
// Node — o stripping de tipos dos arquivos .ts continua sendo o nativo.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "base44:runtime") {
    return {
      url: new URL("./base44-runtime-stub.mjs", import.meta.url).href,
      shortCircuit: true,
    };
  }
  if (specifier.startsWith("npm:@base44/sdk")) {
    return {
      url: new URL("./base44-sdk-stub.mjs", import.meta.url).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}