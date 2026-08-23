import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { resolveCallerPerson } from "../../shared/sessionAuth.ts";

/**
 * submitPollAnswer — voto de participante em uma enquete (Lote RLS Session Interaction).
 *
 * Evolução do handler original: o person_id é agora RESOLVIDO pelo caller (via
 * auth.me → Person.contact_email) e NÃO confiado do cliente. O client pode enviar
 * personId (compat), mas ele é ignorado como fonte de autorização.
 *
 * Autorização: admin OU participante ativo no evento que possui a enquete.
 *
 * Validações preservadas do comportamento original:
 *   - poll existe e não está deletado;
 *   - poll está live e dentro do prazo (auto-encerra se expirada);
 *   - voter pertence ao evento (Participant ativo, não cancelled);
 *   - 1 resposta por (poll_id, person_id) — idempotência;
 *   - option IDs pertencem ao poll;
 *   - regras de answer_type/max_options.
 *
 * Não permite votar em nome de outra pessoa (person_id sempre = caller).
 */
export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const { pollId, selectedOptionIds } = await req.json();
    if (!pollId || !Array.isArray(selectedOptionIds)) {
      return Response.json({ error: 'Parâmetros obrigatórios ausentes.' }, { status: 400 });
    }

    const svc = base44.asServiceRole;

    // Resolve person_id do caller — nunca do cliente.
    const personId = await resolveCallerPerson(svc, user);
    if (!personId) {
      return Response.json({ error: 'Perfil (Person) não encontrado para o usuário.' }, { status: 403 });
    }

    // Poll existe?
    const polls = await svc.entities.SessionPoll.filter({ id: pollId, is_deleted: false });
    if (!polls.length) return Response.json({ error: 'Enquete não encontrada.' }, { status: 404 });
    const poll = polls[0];

    // Voter pertence ao evento que possui a poll.
    const eventParticipants = await svc.entities.Participant.filter({
      event_id: poll.event_id,
      person_id: personId,
      is_deleted: false,
      registration_status: { $ne: 'cancelled' },
    });
    if (!eventParticipants.length && user.role !== 'admin') {
      return Response.json({ error: 'Você não está inscrito neste evento.' }, { status: 403 });
    }

    // Poll está live?
    if (poll.status !== 'live') {
      return Response.json({ error: 'Esta enquete não está mais aberta para votação.' }, { status: 400 });
    }

    // Expirada → auto-encerra.
    if (poll.live_ends_at && new Date(poll.live_ends_at) < new Date()) {
      await svc.entities.SessionPoll.update(pollId, { status: 'closed', closed_at: new Date().toISOString() });
      return Response.json({ error: 'Esta enquete já foi encerrada.' }, { status: 400 });
    }

    // Idempotência: 1 resposta por (poll, person).
    const existing = await svc.entities.SessionPollAnswer.filter({ poll_id: pollId, person_id: personId, is_deleted: false });
    if (existing && existing.length > 0) {
      return Response.json({ error: 'Você já respondeu esta enquete.', alreadyAnswered: true }, { status: 409 });
    }

    // Valida opções pertencem ao poll.
    const pollOptions = await svc.entities.SessionPollOption.filter({ poll_id: pollId, is_deleted: false });
    const validOptionIds = new Set(pollOptions.map((o: any) => o.id));
    const validSelections = [...new Set(selectedOptionIds.filter((id: any) => validOptionIds.has(id)))];
    if (validSelections.length === 0) {
      return Response.json({ error: 'Nenhuma opção válida selecionada.' }, { status: 400 });
    }

    // max_options / single.
    if (poll.answer_type === 'multiple_choice' && poll.max_options) {
      if (validSelections.length > poll.max_options) {
        return Response.json({ error: `Você pode selecionar no máximo ${poll.max_options} opção(ões).` }, { status: 400 });
      }
    } else if (poll.answer_type !== 'multiple_choice') {
      if (validSelections.length > 1) {
        return Response.json({ error: 'Apenas uma opção é permitida.' }, { status: 400 });
      }
    }

    const answer = await svc.entities.SessionPollAnswer.create({
      poll_id: pollId,
      person_id: personId,
      selected_option_ids: JSON.stringify(validSelections),
      answered_at: new Date().toISOString(),
    });

    return Response.json({ answer });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}