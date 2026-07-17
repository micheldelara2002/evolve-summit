import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { campaign, senderPartnerId } = await req.json();
    if (!campaign?.id) return Response.json({ error: 'Campaign obrigatória.' }, { status: 400 });

    // Mark as processing
    await base44.asServiceRole.entities.NotificationCampaign.update(campaign.id, {
      status: "processing",
    });

    let recipients = [];
    try {
      recipients = await resolveRecipientsServerSide(base44, {
        scopeType: campaign.scope_type,
        scopeEventId: campaign.scope_event_id,
        audienceType: campaign.audience_type,
        audienceSegments: campaign.audience_payload ? JSON.parse(campaign.audience_payload) : [],
        senderUser: user,
        senderPartnerId,
      });
    } catch (e) {
      await base44.asServiceRole.entities.NotificationCampaign.update(campaign.id, {
        status: "failed",
      });
      return Response.json({ ok: false, error: 'Falha ao resolver destinatários: ' + e.message }, { status: 500 });
    }

    // Deduplicate against existing recipients
    const existing = await base44.asServiceRole.entities.NotificationRecipient.filter({ campaign_id: campaign.id });
    const existingIds = new Set(existing.map((r) => r.recipient_user_id));

    const now = new Date().toISOString();
    const toCreate = recipients.filter((r) => !existingIds.has(r.user_id));

    let createdCount = 0;
    if (toCreate.length > 0) {
      try {
        await base44.asServiceRole.entities.NotificationRecipient.bulkCreate(
          toCreate.map((r) => ({
            campaign_id: campaign.id,
            recipient_user_id: r.user_id,
            recipient_name: r.name,
            recipient_email: r.email,
            recipient_role: r.role,
            delivery_status: "sent",
            delivered_at: now,
          }))
        );
        createdCount = toCreate.length;
      } catch (e) {
        await base44.asServiceRole.entities.NotificationCampaign.update(campaign.id, {
          status: "partially_sent",
          sent_at: now,
          recipients_count: existing.length,
          delivered_count: existing.length,
        });
        return Response.json({ ok: false, error: 'Falha parcial ao criar destinatários: ' + e.message }, { status: 500 });
      }
    }

    const totalRecipients = existing.length + createdCount;

    // Mark as sent
    await base44.asServiceRole.entities.NotificationCampaign.update(campaign.id, {
      status: "sent",
      sent_at: now,
      recipients_count: totalRecipients,
      delivered_count: totalRecipients,
    });

    return Response.json({ ok: true, recipients_count: totalRecipients });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});

async function resolveRecipientsServerSide(base44, { scopeType, scopeEventId, audienceType, audienceSegments = [], senderUser, senderPartnerId }) {
  const recipients = [];
  const seen = new Set();

  const addRecipient = (userId, name, email, role) => {
    if (!userId || seen.has(userId)) return;
    seen.add(userId);
    recipients.push({ user_id: userId, name: name || "", email: email || "", role: role || "" });
  };

  let _allUsers = null;
  const getAllUsers = async () => {
    if (!_allUsers) _allUsers = await base44.asServiceRole.entities.User.list();
    return _allUsers;
  };

  if (audienceType === "all" || (audienceType === "segment" && audienceSegments.includes("all"))) {
    const users = await getAllUsers();
    users.forEach((u) => addRecipient(u.id, u.full_name, u.email, u.role));

    if (scopeEventId) {
      const parts = await base44.asServiceRole.entities.Participant.filter({ event_id: scopeEventId, is_deleted: false });
      parts.forEach((p) => {
        const key = p.email?.toLowerCase();
        if (!key || seen.has(key)) return;
        seen.add(key);
        recipients.push({ user_id: p.id, name: p.full_name, email: p.email, role: p.role_in_event || "attendee" });
      });
    }
  } else if (audienceType === "segment") {
    const roleMap = {
      admin: async () => {
        const users = await getAllUsers();
        users.filter((u) => u.role === "admin").forEach((u) => addRecipient(u.id, u.full_name, u.email, "admin"));
      },
      gerente: async () => {
        const users = await getAllUsers();
        users.filter((u) => u.role === "gerente" || u.role === "manager").forEach((u) => addRecipient(u.id, u.full_name, u.email, u.role));
        if (scopeEventId) {
          const parts = await base44.asServiceRole.entities.Participant.filter({ event_id: scopeEventId, role_in_event: "manager", is_deleted: false });
          parts.forEach((p) => addRecipient(p.id, p.full_name, p.email, "manager"));
        }
      },
      staff: async () => {
        if (scopeEventId) {
          const parts = await base44.asServiceRole.entities.Participant.filter({ event_id: scopeEventId, role_in_event: "team", is_deleted: false });
          parts.forEach((p) => addRecipient(p.id, p.full_name, p.email, "team"));
        }
      },
      palestrante: async () => {
        if (scopeEventId) {
          const parts = await base44.asServiceRole.entities.Participant.filter({ event_id: scopeEventId, role_in_event: "speaker", is_deleted: false });
          parts.forEach((p) => addRecipient(p.id, p.full_name, p.email, "speaker"));
        }
      },
      representante: async () => {
        if (scopeEventId) {
          const reps = await base44.asServiceRole.entities.PartnerRepresentative.filter({ event_id: scopeEventId, is_deleted: false });
          reps.forEach((r) => addRecipient(r.id, r.full_name, r.email, "representante"));
        }
      },
      attendee: async () => {
        if (scopeEventId) {
          const parts = await base44.asServiceRole.entities.Participant.filter({ event_id: scopeEventId, role_in_event: "attendee", is_deleted: false });
          parts.forEach((p) => addRecipient(p.id, p.full_name, p.email, "attendee"));
        } else {
          const users = await getAllUsers();
          users.filter((u) => u.role === "user").forEach((u) => addRecipient(u.id, u.full_name, u.email, "user"));
        }
      },
    };

    for (const seg of audienceSegments) {
      if (roleMap[seg]) await roleMap[seg]();
    }
  } else if (audienceType === "my_leads" && senderUser) {
    if (senderPartnerId && scopeEventId) {
      const leads = await base44.asServiceRole.entities.Lead.filter({ event_id: scopeEventId, partner_id: senderPartnerId });
      leads.forEach((l) => addRecipient(l.participant_id, l.participant_name, l.participant_email, "attendee"));
    }
  } else if (audienceType === "partner_all_event" && scopeEventId) {
    const parts = await base44.asServiceRole.entities.Participant.filter({ event_id: scopeEventId, is_deleted: false });
    parts.forEach((p) => addRecipient(p.id, p.full_name, p.email, p.role_in_event || "attendee"));
  } else if (audienceType === "partner_leads" && scopeEventId && senderPartnerId) {
    const leads = await base44.asServiceRole.entities.Lead.filter({ event_id: scopeEventId, partner_id: senderPartnerId });
    leads.forEach((l) => addRecipient(l.participant_id, l.participant_name, l.participant_email, "attendee"));
  } else if (audienceType === "my_attendees" && senderUser) {
    if (scopeEventId) {
      const persons = await base44.asServiceRole.entities.Person.filter({ contact_email: senderUser.email, is_active: true });
      const speakerPerson = persons?.[0];
      if (speakerPerson) {
        const speakerParts = await base44.asServiceRole.entities.Participant.filter({ event_id: scopeEventId, person_id: speakerPerson.id, is_deleted: false });
        const speakerPartIds = speakerParts.map((p) => p.id);
        if (speakerPartIds.length > 0) {
          const allSessions = await base44.asServiceRole.entities.Session.filter({ event_id: scopeEventId, is_deleted: false });
          const speakerSessionIds = allSessions
            .filter((s) => speakerPartIds.includes(s.speaker_id))
            .map((s) => s.id);
          if (speakerSessionIds.length > 0) {
            const attendance = await base44.asServiceRole.entities.SessionAttendance.filter({
              event_id: scopeEventId, is_present: true, session_id: { $in: speakerSessionIds },
            });
            const attendedParticipantIds = new Set(attendance.map((a) => a.participant_id));
            const parts = await base44.asServiceRole.entities.Participant.filter({ event_id: scopeEventId, is_deleted: false });
            parts.forEach((p) => {
              if (attendedParticipantIds.has(p.id)) {
                addRecipient(p.id, p.full_name, p.email, p.role_in_event || "attendee");
              }
            });
          }
        }
      }
    }
  }

  // Sender always receives their own message
  if (senderUser) {
    addRecipient(senderUser.id, senderUser.full_name, senderUser.email, senderUser.role);
  }

  return recipients;
}