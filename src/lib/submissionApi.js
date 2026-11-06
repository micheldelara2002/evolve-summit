import { base44 } from "@/api/base44Client";

/**
 * Porta única das submissões de Call for Papers no cliente.
 * O autor só grava conteúdo; curadoria decide. Toda validação é do servidor.
 */
async function invoke(payload) {
  const res = await base44.functions.invoke("manageSubmission", payload);
  return res.data ?? res;
}

export function submissionErrorMessage(err) {
  return (
    err?.response?.data?.error ||
    err?.data?.error ||
    err?.message ||
    "Não foi possível concluir a operação."
  );
}

export async function saveSubmission({ cfpId, editId, title, summary, proposedType, answers }) {
  const out = await invoke(
    editId
      ? {
          action: "update",
          submission_id: editId,
          title,
          summary,
          proposed_type: proposedType,
          custom_answers: answers,
        }
      : {
          action: "create",
          call_for_papers_id: cfpId,
          title,
          summary,
          proposed_type: proposedType,
          custom_answers: answers,
        }
  );
  return out.submission;
}

export async function deleteSubmission(submissionId) {
  return invoke({ action: "delete", submission_id: submissionId });
}

export async function reuseSubmission(sourceId, targetCfpId) {
  return invoke({ action: "clone", submission_id: sourceId, target_cfp_id: targetCfpId });
}

export async function listReviewQueue(eventId) {
  const out = await invoke({ action: "list", event_id: eventId || "" });
  return {
    events: out.events || [],
    cfps: out.cfps || [],
    submissions: out.submissions || [],
  };
}

export async function decideSubmission({ submissionId, action, notes }) {
  return invoke({ submission_id: submissionId, action, review_notes: notes });
}