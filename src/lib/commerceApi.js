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

// ===== Refund =====
export const requestRefund = (paymentId, reason, refundType = "full", manualApprove = false) =>
  invoke("requestRefund", { paymentId, reason, refundType, manualApprove });

export const requestRefundItems = (paymentId, order_item_ids, reason = "", manualApprove = false) =>
  invoke("requestRefund", { paymentId, reason, refundType: "cancel_item", manualApprove, order_item_ids });

// ===== Sales analytics (admin/gerente) =====
export const getSalesMetrics = (filters) => invoke("getSalesMetrics", filters);
export const getEventSalesSummary = (eventId) => invoke("getEventSalesSummary", { eventId });
export const getEventOrders = (eventId) => invoke("getEventOrders", { eventId });
export const checkinTicket = (code) => invoke("checkinTicket", { code });