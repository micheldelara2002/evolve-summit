// Extração de IP do cliente + gravação best-effort no log de auditoria —
// compartilhado entre as funções de comércio e o log genérico.

// IP do cliente a partir dos cabeçalhos de proxy padrão
// (mesmo padrão usado antes inline no logAuditEvent).
export function extractClientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  return (forwarded ? forwarded.split(",")[0].trim() : "")
    || req.headers.get("x-real-ip")
    || req.headers.get("cf-connecting-ip")
    || "";
}

// Grava uma entrada no log de auditoria — best-effort: falhas de auditoria
// NUNCA interrompem o fluxo transacional (padrão já usado no comércio).
export async function writeAudit(svc: any, entry: Record<string, any>): Promise<void> {
  try {
    await svc.entities.AuditLog.create(entry);
  } catch (err: any) {
    console.error("[writeAudit] falha ao gravar auditoria:", err?.message || err);
  }
}