import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin' && user.role !== 'manager') {
      return Response.json({ error: 'Apenas administradores e gerentes podem realizar sorteios.' }, { status: 403 });
    }

    const { eligiblePool, winnerCount, excludeIds = [] } = await req.json();

    if (!Array.isArray(eligiblePool) || eligiblePool.length === 0) {
      return Response.json({ error: 'Pool de elegíveis inválido.' }, { status: 400 });
    }

    const count = Math.max(1, parseInt(winnerCount) || 1);
    const excludeSet = new Set(excludeIds);
    const pool = eligiblePool.filter((p) => p?.id && !excludeSet.has(p.id));

    if (pool.length === 0) {
      return Response.json({ error: 'Sem elegíveis disponíveis após exclusões.' }, { status: 400 });
    }

    // Fisher-Yates shuffle com aleatoriedade criptograficamente segura
    const arr = [...pool];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = secureRandomInt(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }

    const winners = arr.slice(0, Math.min(count, arr.length)).map((p) => ({
      id: p.id,
      full_name: p.full_name,
      email: p.email,
      company: p.company,
      confirmed: false,
    }));

    return Response.json({ winners, drawnAt: new Date().toISOString() });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});

/**
 * Gera inteiro aleatório [0, max) sem viés de módulo, usando Web Crypto API.
 */
function secureRandomInt(max: number): number {
  const maxUint32 = 0xFFFFFFFF;
  const limit = maxUint32 - (maxUint32 % max);
  const buf = new Uint32Array(1);
  let val: number;
  do {
    crypto.getRandomValues(buf);
    val = buf[0];
  } while (val > limit);
  return val % max;
}