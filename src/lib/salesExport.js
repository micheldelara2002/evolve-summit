// Geração de relatório de vendas em CSV (separador ';' + BOM para Excel pt-BR).
// Usado pelo painel "Receber minhas vendas" (organizador) e pela aba Pedidos (admin)
// para que o organizador emita NFs em lote no emissor próprio da empresa.

const CSV_HEADERS = [
  "Data do pedido",
  "Comprador",
  "Email do comprador",
  "Titular do ingresso",
  "Email do titular",
  "Telefone do titular",
  "Tipo de ingresso",
  "Valor unitario (R$)",
  "Valor total do pedido (R$)",
  "Desconto (R$)",
  "Cupom",
  "Forma de pagamento",
  "Status do pedido",
  "Status do ingresso",
  "Estornado",
];

function csvEscape(value) {
  const s = String(value ?? "");
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Recebe o formato devolvido por getEventOrders (array de pedidos com itens).
// Inclui apenas pedidos pagos (paid / partially_refunded) — é o que vira receita/NF.
export function buildSalesCsv(orders) {
  const rows = [CSV_HEADERS.join(";")];
  for (const o of orders || []) {
    if (o.status !== "paid" && o.status !== "partially_refunded") continue;
    for (const it of o.items || []) {
      rows.push(
        [
          o.created_date ? new Date(o.created_date).toLocaleString("pt-BR") : "",
          o.buyer_name || "",
          o.buyer_email || "",
          it.holder_name || "",
          it.holder_email || "",
          it.holder_phone || "",
          it.ticket_type_name || "",
          Number(it.unit_price || 0).toFixed(2).replace(".", ","),
          Number(o.total || 0).toFixed(2).replace(".", ","),
          Number(o.discount || 0).toFixed(2).replace(".", ","),
          o.coupon_code || "",
          o.payment_method || "",
          o.status || "",
          it.ticket_status || "",
          it.refunded ? "Sim" : "Nao",
        ]
          .map(csvEscape)
          .join(";")
      );
    }
  }
  return "\uFEFF" + rows.join("\r\n");
}

export function downloadSalesCsv(name, orders) {
  const blob = new Blob([buildSalesCsv(orders)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const slug = String(name || "evento")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  a.download = `vendas-${slug}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}