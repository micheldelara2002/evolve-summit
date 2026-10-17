// campaignContent.ts (2026-10-17) — Mecanismo de APROVAÇÃO de conteúdo para
// disparo de campanhas. Um agendamento é uma aprovação do conteúdo NO ESTADO
// em que ele foi aprovado; edições posteriores INVALIDAM a aprovação por
// comparação de hash — nunca apenas por marcadores auxiliares.
//
//   - computeCampaignContentHash(c): hash determinístico dos campos de
//     conteúdo (title/message/type/priority/cta_label/cta_target).
//   - isCampaignDispatchApproved(c): aprovação válida para disparo?
//   - campaignApprovalRefusal(c): motivo de recusa (ou null).
//   - decideScheduledContentUpdate(...): decisão PURA do update (testável sem
//     banco) — usada por manageNotificationCampaign.
//
// Políticas:
//   - create com scheduled_at futuro => aprovação carimbada no hash atual.
//   - update que (re)agenda (scheduled_at futuro) => (re)aprovação implícita
//     (é o fluxo normal de "editar e reagendar").
//   - update que muda conteúdo de campanha agendada SEM reagendar => aprovação
//     anterior invalidada (approved_content_hash = null + content_changed) —
//     o disparo (manual e agendado) RECUSA até a op 'approve_scheduled'
//     carimbar nova aprovação.
//   - LEGADO: campanhas anteriores ao mecanismo (sem approved_content_hash)
//     permanecem aprovadas — comportamento anterior preservado — exceto se
//     content_changed === true (invalidação explícita).
//
// Hash: FNV-1a 32-bit em duas direções + comprimento — determinístico e sem
// dependências. É verificação de integridade semântica de aprovação (o editor
// é sempre o emissor/autorizado), não mecanismo criptográfico anti-adversário.

export function computeCampaignContentHash(c: any): string {
  const parts = JSON.stringify([
    String(c?.title || ''),
    String(c?.message || ''),
    String(c?.type || ''),
    String(c?.priority || ''),
    String(c?.cta_label || ''),
    String(c?.cta_target || ''),
  ]);
  return (
    'h1_' +
    fnv1a32(parts).toString(16).padStart(8, '0') +
    '_' +
    fnv1a32b(parts).toString(16).padStart(8, '0') +
    '_' +
    parts.length.toString(16)
  );
}

function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function fnv1a32b(s: string): number {
  let h = 0x0159a3f1;
  for (let i = s.length - 1; i >= 0; i--) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function isCampaignDispatchApproved(c: any): boolean {
  if (!c) return false;
  if (c.content_changed === true) return false;
  if (c.approved_content_hash) {
    return c.approved_content_hash === computeCampaignContentHash(c);
  }
  return true; // legado sem carimbo — comportamento anterior preservado
}

export function campaignApprovalRefusal(c: any): string | null {
  if (isCampaignDispatchApproved(c)) return null;
  return 'Campanha com conteúdo alterado após o agendamento — reprovação necessária antes do disparo (op approve_scheduled).';
}

// Decisão PURA do update de campanha (testável sem banco).
// schedulingChanged = o chamador está (re)agendando com data futura —
// (re)agendar É a nova aprovação, então não há invalidação separada.
export function decideScheduledContentUpdate(
  campaign: any,
  content: any,
  schedulingChanged: boolean
): { contentChanged: boolean; wasScheduled: boolean; invalidateApproval: boolean } {
  const contentChanged =
    content.title !== campaign.title ||
    content.message !== campaign.message ||
    content.type !== campaign.type ||
    content.priority !== campaign.priority ||
    (content.cta_label || '') !== (campaign.cta_label || '') ||
    (content.cta_target || '') !== (campaign.cta_target || '');
  const wasScheduled = !!(campaign.scheduled_at && campaign.status !== 'draft');
  const invalidateApproval = contentChanged && wasScheduled && !schedulingChanged;
  return { contentChanged, wasScheduled, invalidateApproval };
}