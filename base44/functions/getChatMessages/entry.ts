import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { resolveUserPersonId } from "../../shared/eventAuth.ts";

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const { threadId } = await req.json();
    if (!threadId) return Response.json({ error: 'threadId obrigatório.' }, { status: 400 });

    const threads = await base44.asServiceRole.entities.ChatThread.filter({ id: threadId, is_deleted: false });
    const thread = threads?.[0];
    if (!thread) return Response.json({ error: 'Conversa não encontrada.' }, { status: 404 });

    const userPersonId = await resolveUserPersonId(base44, user);
    const isParticipant = !!userPersonId && (thread.person_a_id === userPersonId || thread.person_b_id === userPersonId);
    if (!isParticipant && user.role !== 'admin') {
      return Response.json({ error: 'Sem permissão para ler esta conversa.' }, { status: 403 });
    }

    const messages = await base44.asServiceRole.entities.ChatMessage.filter({ thread_id: threadId }, '-created_date', 200);

    // Marca como lidas as mensagens do outro participante (best-effort, espelha o bulkUpdate do cliente)
    if (isParticipant && userPersonId) {
      const now = new Date().toISOString();
      const unread = messages.filter((m) => m.sender_person_id !== userPersonId && !m.read_at);
      if (unread.length) {
        try {
          await base44.asServiceRole.entities.ChatMessage.bulkUpdate(
            unread.map((m) => ({ id: m.id, read_at: now }))
          );
          for (const m of unread) m.read_at = now;
        } catch (e) {
          console.error('mark-read failed:', e);
        }
      }
    }

    return Response.json({ messages });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});