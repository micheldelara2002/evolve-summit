import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { pollId, personId, selectedOptionIds } = await req.json();

    if (!pollId || !personId || !Array.isArray(selectedOptionIds)) {
      return Response.json({ error: 'Parâmetros obrigatórios ausentes.' }, { status: 400 });
    }

    // Fetch the poll fresh from DB
    const polls = await base44.asServiceRole.entities.SessionPoll.filter({
      id: pollId,
      is_deleted: false,
    });
    if (!polls.length) {
      return Response.json({ error: 'Enquete não encontrada.' }, { status: 404 });
    }
    const poll = polls[0];

    // Validate poll is live
    if (poll.status !== 'live') {
      return Response.json({ error: 'Esta enquete não está mais aberta para votação.' }, { status: 400 });
    }

    // Validate not expired
    if (poll.live_ends_at && new Date(poll.live_ends_at) < new Date()) {
      // Auto-close expired poll
      await base44.asServiceRole.entities.SessionPoll.update(pollId, {
        status: 'closed',
        closed_at: new Date().toISOString(),
      });
      return Response.json({ error: 'Esta enquete já foi encerrada.' }, { status: 400 });
    }

    // Verify the person belongs to the calling user (by email match)
    const persons = await base44.asServiceRole.entities.Person.filter({ id: personId });
    if (!persons.length) {
      return Response.json({ error: 'Pessoa não encontrada.' }, { status: 404 });
    }
    const person = persons[0];
    if (person.contact_email?.toLowerCase() !== user.email?.toLowerCase() && user.role !== 'admin') {
      return Response.json({ error: 'Sem permissão para responder por esta pessoa.' }, { status: 403 });
    }

    // Check if already answered (idempotency)
    const existingAnswers = await base44.asServiceRole.entities.SessionPollAnswer.filter({
      poll_id: pollId,
      person_id: personId,
      is_deleted: false,
    });
    if (existingAnswers && existingAnswers.length > 0) {
      return Response.json({ error: 'Você já respondeu esta enquete.', alreadyAnswered: true }, { status: 409 });
    }

    // Validate selected options belong to this poll
    const pollOptions = await base44.asServiceRole.entities.SessionPollOption.filter({
      poll_id: pollId,
      is_deleted: false,
    });
    const validOptionIds = new Set(pollOptions.map(o => o.id));
    const validSelections = selectedOptionIds.filter(id => validOptionIds.has(id));

    if (validSelections.length === 0) {
      return Response.json({ error: 'Nenhuma opção válida selecionada.' }, { status: 400 });
    }

    // Enforce max_options for multiple_choice
    if (poll.answer_type === 'multiple_choice' && poll.max_options) {
      if (validSelections.length > poll.max_options) {
        return Response.json({ error: `Você pode selecionar no máximo ${poll.max_options} opção(ões).` }, { status: 400 });
      }
    } else if (poll.answer_type !== 'multiple_choice') {
      // single_choice / yes_no: only 1 option allowed
      if (validSelections.length > 1) {
        return Response.json({ error: 'Apenas uma opção é permitida.' }, { status: 400 });
      }
    }

    // Create the answer
    const answer = await base44.asServiceRole.entities.SessionPollAnswer.create({
      poll_id: pollId,
      person_id: personId,
      selected_option_ids: JSON.stringify(validSelections),
      answered_at: new Date().toISOString(),
    });

    return Response.json({ answer });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});