// Nota de política de estorno exibida ao comprador no checkout.
// Deriva as janelas da política resolvida (padrão global + override do evento)
// e da data de início do evento.

export default function RefundPolicyNote({ policy, eventStart }) {
  if (!policy) return null;

  const fmt = (date) =>
    date && !isNaN(date.getTime()) ? date.toLocaleDateString("pt-BR") : "";
  const shiftDays = (days) => {
    if (!eventStart) return null;
    const start = new Date(eventStart).getTime();
    if (isNaN(start)) return null;
    return new Date(start - days * 86400000);
  };

  const fullDays = policy.full_refund_until_days ?? 15;
  const partialPct = policy.partial_refund_percent ?? 50;
  const noRefundDays = policy.no_refund_within_days ?? 1;
  const fullUntil = fmt(shiftDays(fullDays));
  const partialUntil = fmt(shiftDays(noRefundDays));

  return (
    <p className="mt-2 pt-2 border-t border-border text-[11px] leading-relaxed text-muted-foreground">
      <span className="font-medium">Política de estorno:</span> integral até {fullDays} dias antes do evento
      {fullUntil ? ` (até ${fullUntil})` : ""}; {partialPct}% até a véspera
      {partialUntil ? ` (até ${partialUntil})` : ""}; após isso, sem estorno.
    </p>
  );
}