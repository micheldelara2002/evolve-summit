import { base44 } from "@/api/base44Client";

// Frontend API wrapper for the commerce backend functions.

async function invoke(name, payload) {
  const res = await base44.functions.invoke(name, payload);
  if (res?.data?.error) throw new Error(res.data.error);
  return res.data;
}

// ===== Admin commerce config =====
export const listCommerce = (entityName, eventId) =>
  invoke("manageCommerce", { action: "list", entityName, eventId });

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