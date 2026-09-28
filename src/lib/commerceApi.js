import { base44 } from "@/api/base44Client";

// Frontend API wrapper for the commerce backend functions.

async function invoke(name, payload) {
  const res = await base44.functions.invoke(name, payload);
  if (res?.data?.error) throw new Error(res.data.error);
  return res.data;
}

// ===== Admin commerce config =====
export const listCommerce = async (entityName, eventId) => {
  const res = await invoke("manageCommerce", { action: "list", entityName, eventId });
  return Array.isArray(res?.records) ? res.records : [];
};

export const createCommerce = (entityName, eventId, data) =>
  invoke("manageCommerce", { action: "create", entityName, eventId, data });

export const updateCommerce = (entityName, eventId, id, data) =>
  invoke("manageCommerce", { action: "update", entityName, eventId, id, data });

export const deleteCommerce = (entityName, eventId, id) =>
  invoke("manageCommerce", { action: "delete", entityName, eventId, id });

export const getRefundPolicy = (eventId) =>
  invoke("manageCommerce", { action: "getPolicy", eventId });

export const setRefundPolicy = (eventId, data) =>
  invoke("manageCommerce", { action: "setPolicy", eventId, data });

export const setRequiresPayment = (eventId, requires_payment) =>
  invoke("manageCommerce", { action: "setRequiresPayment", eventId, data: { requires_payment } });

// ===== Participant ticket browsing + checkout =====
export const getEventTickets = (eventId) =>
  invoke("getEventTickets", { eventId });

export const getBilheteriaEvents = async () => {
  const res = await invoke("getBilheteriaEvents", {});
  return Array.isArray(res?.events) ? res.events : [];
};

export const createPaymentIntent = (eventId, items, couponCode) =>
  invoke("createPaymentIntent", { eventId, items, couponCode });

export const getPaymentStatus = (paymentId) =>
  invoke("getPaymentStatus", { paymentId });

// ===== Orders / tickets =====
export const getMyOrders = (orderId) =>
  invoke("getMyOrders", orderId ? { orderId } : {});

// PDF do ingresso (QR + recibo) — gera sob demanda se ainda não existir.
export const getTicketPdf = (ticketId) => invoke("getTicketPdf", { ticketId });

// ===== Refund =====
export const requestRefund = (paymentId, reason, refundType = "full", manualApprove = false) =>
  invoke("requestRefund", { paymentId, reason, refundType, manualApprove });

export const requestRefundItems = (paymentId, order_item_ids, reason = "", manualApprove = false) =>
  invoke("requestRefund", { paymentId, reason, refundType: "cancel_item", manualApprove, order_item_ids });

// ===== Fulfillment retry (comprador/gestor/admin) =====
export const retryFulfillment = (paymentId) => invoke("retryFulfillment", { paymentId });

// ===== Sales analytics (admin/gerente) =====
export const getSalesMetrics = (filters) => invoke("getSalesMetrics", filters);
export const getEventSalesSummary = (eventId) => invoke("getEventSalesSummary", { eventId });
// PERF-001 — paginação backend obrigatória: percorre TODAS as páginas dos dois
// fluxos (pedidos e pagamentos) até esgotar, sem truncagem silenciosa. A forma
// do retorno (orders/payments planos + total) preserva os consumidores.
export const getEventOrders = async (eventId, { limit = 200 } = {}) => {
  let orders = [];
  let payments = [];
  let ordersCursor = null;
  let paymentsCursor = null;
  let ordersDone = false;
  let paymentsDone = false;
  let total = 0;
  let pages = 0;
  for (let i = 0; i < 100; i++) {
    const res = await invoke("getEventOrders", {
      eventId,
      limit,
      ordersCursor: ordersDone ? "" : ordersCursor,
      paymentsCursor: paymentsDone ? "" : paymentsCursor,
    });
    if (i === 0) total = res?.total ?? 0;
    orders = orders.concat(res?.orders || []);
    payments = payments.concat(res?.payments || []);
    if (res?.orders_cursor) ordersCursor = res.orders_cursor;
    else ordersDone = true;
    if (res?.payments_cursor) paymentsCursor = res.payments_cursor;
    else paymentsDone = true;
    pages++;
    if (ordersDone && paymentsDone) break;
  }
  return { orders, payments, total, limit, pages };
};
export const checkinTicket = (code) => invoke("checkinTicket", { code });

// ===== Trail de transações (admin — visão do painel de auditoria) =====
export const getTransactionTrail = (query) => invoke("getTransactionTrail", { query });