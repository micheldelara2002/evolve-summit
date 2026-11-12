// Registra o resolve hook usado pelos testes unitários dos módulos de produção
// que dependem do runtime do Deno. Uso: `node --import ./tests/unit/lib/register-stub-loader.mjs --test ...`
import { register } from "node:module";

register("./stub-loader.mjs", import.meta.url);