// P0 (2026-09-29) — Resolução de audiência de campanhas: fonte ÚNICA usada pelo
// disparo (dispatchNotificationCampaign) e pela contagem exata
// (countCampaignAudience). Extraída do dispatch para eliminar duplicação de
// lógica — qualquer mudança de regra de audiência passa a valer para os dois.
//
// SEMÂNTICA DE IDENTIDADE (herdada do dispatch):
//   recipient_user_id é SEMPRE o ID do User (conta do app). Audiências de
//   participante resolvem Participant → e-mail → User; participante SEM conta
//   de app NÃO gera recipient (regra de negócio). Segmentos de papel resolvem
//   via EventMembership ancorada em user_id.
import { scanBatches } from "./completeScan.ts";

export const AUDIENCE_BATCH_SIZE = 500;

type Recipient = { user_id: string; name: string; email: string; role: string };
type YieldedBatch = { recipients: Recipient[] };

// =============================================================================
// Participant → User (batched $in por e-mail).
// Participante sem conta de app NÃO gera recipient (regra de negócio — o
// inbox e a RLS casam por User ID; um registro por Participant ID seria morto).
// =============================================================================
async function participantsToRecipients(svc: any, parts: any[]): Promise<Recipient[]> {
  const emailVariants = new Set<string>();
  for (const p of parts) {
    const raw = String(p?.email || "").trim();
    if (raw) {
      emailVariants.add(raw);
      emailVariants.add(raw.toLowerCase());
    }
  }
  if (emailVariants.size === 0) return [];

  // Lookup fatiado (chunks de AUDIENCE_BATCH_SIZE): respeita o limite por query
  // quando o batch de participantes traz mais e-mails que o máximo suportado.
  const variants = Array.from(emailVariants);
  const usersByEmail = new Map<string, any>();
  for (let i = 0; i < variants.length; i += AUDIENCE_BATCH_SIZE) {
    const chunk = variants.slice(i, i + AUDIENCE_BATCH_SIZE);
    const users = await svc.entities.User.filter(
      { email: { $in: chunk }, account_status: { $ne: "deleted" } },
      "id", chunk.length
    );
    for (const u of users) {
      if (u.email) {
        const key = String(u.email).toLowerCase();
        if (!usersByEmail.has(key)) usersByEmail.set(key, u);
      }
    }
  }

  const out: Recipient[] = [];
  for (const p of parts) {
    const u = usersByEmail.get(String(p?.email || "").toLowerCase());
    if (!u) continue; // sem conta de app → não cria registro
    out.push({
      user_id: u.id,
      name: p.full_name || u.full_name || "",
      email: u.email || p.email || "",
      role: p.role_in_event || "attendee",
    });
  }
  return out;
}

// =============================================================================
// Async Generator: Resolve audience in batches of up to AUDIENCE_BATCH_SIZE.
// Every recipient's user_id is a real User ID (see identity semantics above).
// =============================================================================
export async function* resolveAudienceBatches(
  svc: any,
  params: {
    scopeType: string;
    scopeEventId: string | null;
    audienceType: string;
    audienceSegments: string[];
    senderUser: any;
    senderPartnerId: string | null;
  }
): AsyncGenerator<YieldedBatch> {
  const { scopeEventId, audienceType, audienceSegments = [], senderUser, senderPartnerId } = params;

  const isAll = audienceType === "all" || (audienceType === "segment" && audienceSegments.includes("all"));

  if (isAll) {
    if (scopeEventId) {
      // --- Evento: todos os participantes do evento com conta de app ---
      // Um único recipient por pessoa (dedup por user_id dentro/cross-batch).
      for await (const parts of scanBatches(
        svc.entities.Participant,
        { event_id: scopeEventId, is_deleted: false, is_eligible: { $ne: false } },
        { pageSize: AUDIENCE_BATCH_SIZE }
      )) {
        const recipients = await participantsToRecipients(svc, parts);
        if (recipients.length > 0) yield { recipients };
      }
    } else {
      // --- Global (sem evento): todos os Users do app (paginado) ---
      for await (const users of scanBatches(svc.entities.User, { account_status: { $ne: "deleted" } }, { pageSize: AUDIENCE_BATCH_SIZE })) {
        yield {
          recipients: users.map((u: any) => ({
            user_id: u.id, name: u.full_name || "", email: u.email || "", role: u.role || "",
          })),
        };
      }
    }
  } else if (audienceType === "segment") {
    // --- Segmentos globais via User.role (apenas admin; attendee sem evento) ---
    const userRoleMap: Record<string, string> = {};
    for (const seg of audienceSegments) {
      if (seg === "admin") userRoleMap["admin"] = "admin";
      if (seg === "attendee" && !scopeEventId) userRoleMap["user"] = "user";
    }

    const userRoles = Object.keys(userRoleMap);
    if (userRoles.length > 0) {
      for await (const users of scanBatches(svc.entities.User, { account_status: { $ne: "deleted" } }, { pageSize: AUDIENCE_BATCH_SIZE })) {
        const batch: Recipient[] = users
          .filter((u: any) => userRoles.includes(u.role))
          .map((u: any) => ({
            user_id: u.id, name: u.full_name || "", email: u.email || "",
            role: userRoleMap[u.role] || u.role || "",
          }));
        if (batch.length > 0) yield { recipients: batch };
      }
    }

    if (scopeEventId) {
      // --- Segmentos de papel do evento via EventMembership (P0) ---
      // Mestre de papéis, ancorada em user_id — sem lookup de e-mail. Apenas
      // membros com conta vinculada (user_id preenchido) geram recipient.
      const membershipSegMap: Record<string, string> = {
        gerente: "manager",
        staff: "team",
        palestrante: "speaker",
        representante: "partner_rep",
      };

      for (const seg of audienceSegments) {
        const role = membershipSegMap[seg];
        if (!role) continue;
        for await (const memberships of scanBatches(
          svc.entities.EventMembership,
          {
            event_id: scopeEventId,
            role,
            is_active: true,
            is_deleted: false,
            user_id: { $ne: "" },
          },
          { pageSize: AUDIENCE_BATCH_SIZE }
        )) {
          yield {
            recipients: memberships.map((m: any) => ({
              user_id: m.user_id,
              name: m.person_name || m.user_email || "",
              email: m.user_email || "",
              role: m.role,
            })),
          };
        }
      }

      // --- Segmento 'attendee' do evento: todos os participantes com conta ---
      if (audienceSegments.includes("attendee")) {
        for await (const parts of scanBatches(
          svc.entities.Participant,
          { event_id: scopeEventId, is_deleted: false, is_eligible: { $ne: false } },
          { pageSize: AUDIENCE_BATCH_SIZE }
        )) {
          const recipients = await participantsToRecipients(svc, parts);
          if (recipients.length > 0) yield { recipients };
        }
      }
    }
  } else if (audienceType === "my_leads" && senderUser && senderPartnerId && scopeEventId) {
    // Leads do parceiro → participantes elegíveis → User por e-mail
    for await (const leads of scanBatches(
      svc.entities.Lead,
      { event_id: scopeEventId, partner_id: senderPartnerId },
      { pageSize: AUDIENCE_BATCH_SIZE }
    )) {
      const leadPartIds = new Set<string>();
      for (const l of leads) if (l.participant_id) leadPartIds.add(l.participant_id);
      if (leadPartIds.size > 0) {
        const eligibleParts = await svc.entities.Participant.filter(
          { id: { $in: Array.from(leadPartIds) }, is_eligible: { $ne: false }, is_deleted: false },
          "id", leadPartIds.size, 0
        );
        const recipients = await participantsToRecipients(svc, eligibleParts);
        if (recipients.length > 0) yield { recipients };
      }
    }
  } else if (audienceType === "partner_all_event" && scopeEventId) {
    for await (const parts of scanBatches(
      svc.entities.Participant,
      { event_id: scopeEventId, is_deleted: false, is_eligible: { $ne: false } },
      { pageSize: AUDIENCE_BATCH_SIZE }
    )) {
      const recipients = await participantsToRecipients(svc, parts);
      if (recipients.length > 0) yield { recipients };
    }
  } else if (audienceType === "partner_leads" && scopeEventId && senderPartnerId) {
    for await (const leads of scanBatches(
      svc.entities.Lead,
      { event_id: scopeEventId, partner_id: senderPartnerId },
      { pageSize: AUDIENCE_BATCH_SIZE }
    )) {
      const leadPartIds = new Set<string>();
      for (const l of leads) if (l.participant_id) leadPartIds.add(l.participant_id);
      if (leadPartIds.size > 0) {
        const eligibleParts = await svc.entities.Participant.filter(
          { id: { $in: Array.from(leadPartIds) }, is_eligible: { $ne: false }, is_deleted: false },
          "id", leadPartIds.size, 0
        );
        const recipients = await participantsToRecipients(svc, eligibleParts);
        if (recipients.length > 0) yield { recipients };
      }
    }
  } else if (audienceType === "my_attendees" && senderUser && scopeEventId) {
    // Paginated resolution: Sender → Person → Speaker Participant → Sessions →
    // Attendance → Participants → User (por e-mail). O(batch) memory em todas as etapas.

    // Step 1: senderUser → Person (O(1) result)
    const persons = await svc.entities.Person.filter({ contact_email: senderUser.email, is_active: true });
    const speakerPerson = persons?.[0];
    if (speakerPerson) {
      // Step 2: Person → Speaker's Participant records (paginated, collect IDs)
      const speakerPartIds: string[] = [];
      for await (const speakerParts of scanBatches(
        svc.entities.Participant,
        { event_id: scopeEventId, person_id: speakerPerson.id, is_deleted: false },
        { pageSize: AUDIENCE_BATCH_SIZE }
      )) {
        for (const p of speakerParts) speakerPartIds.push(p.id);
      }

      if (speakerPartIds.length > 0) {
        // Step 3: Speaker's Participant IDs → Sessions (paginated by speaker_id $in)
        const speakerSessionIds: string[] = [];
        for await (const sessions of scanBatches(
          svc.entities.Session,
          { event_id: scopeEventId, speaker_id: { $in: speakerPartIds }, is_deleted: false },
          { pageSize: AUDIENCE_BATCH_SIZE }
        )) {
          for (const s of sessions) speakerSessionIds.push(s.id);
        }

        if (speakerSessionIds.length > 0) {
          // Step 4+5: Sessions → Attendance (paginado) → Participants → User
          for await (const attendance of scanBatches(
            svc.entities.SessionAttendance,
            { event_id: scopeEventId, is_present: true, session_id: { $in: speakerSessionIds } },
            { pageSize: AUDIENCE_BATCH_SIZE }
          )) {
            const batchPartIds = new Set<string>();
            for (const a of attendance) {
              if (a.participant_id) batchPartIds.add(a.participant_id);
            }

            if (batchPartIds.size > 0) {
              const parts = await svc.entities.Participant.filter(
                { id: { $in: Array.from(batchPartIds) }, is_deleted: false, is_eligible: { $ne: false } },
                "id", AUDIENCE_BATCH_SIZE, 0
              );
              const recipients = await participantsToRecipients(svc, parts);
              if (recipients.length > 0) yield { recipients };
            }
          }
        }
      }
    }
  }

  // --- Sender always receives their own message (business rule) ---
  if (senderUser) {
    yield {
      recipients: [{
        user_id: senderUser.id,
        name: senderUser.full_name || "",
        email: senderUser.email || "",
        role: senderUser.role || "",
      }],
    };
  }
}