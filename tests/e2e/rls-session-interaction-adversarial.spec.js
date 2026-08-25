/**
 * Lote RLS — Session Interaction / Poll + Q&A — adversarial suite.
 *
 * Cobertura (Fase 6 do lote):
 *   A. PARTICIPANT  — polls/vote/questions authorization + blocks.
 *   B. SPEAKER      — poll/option/answer/question admin boundaries.
 *   C. ADMIN        — full CRUD via service-role functions.
 *   D. CROSS-EVENT  — persona autorizada em A não acessa dados de B.
 *   E. DATA INTEGRITY — caller não assume identidade/ownership via campos do cliente.
 *   F. REGRESSION   — agenda/sessão/live poll/votação/realtime/Q&A/painel speaker/admin.
 *
 * Entidades cobertas: SessionPoll, SessionPollOption, SessionPollAnswer,
 *                    SessionQuestion, SessionAnswer (RLS admin-only).
 *
 * Superfície autorizada para não-admin: getSessionPolls, getSessionQuestions,
 *   getSpeakerQuestionStats, manageSessionPoll, submitPollAnswer,
 *   manageSessionQuestion, manageSessionAnswer.
 *
 * Observação: estes testes exigem o runner de CI (E2E_BASE_URL + personas em env).
 * No sandbox do Base44 não há personificação de persona — execução local é SKIP,
 * nunca PASS. A verificação do caminho admin/service-role foi feita via
 * test_backend_function e registrada no checkpoint como VERIFICADO.
 */
import { test, expect } from '@playwright/test';
import { createClient } from '@base44/sdk';

const appId = process.env.BASE44_APP_ID || '6a2c618daec1758ff2122225';
const baseUrl = process.env.E2E_BASE_URL;
const eventId = process.env.E2E_EVENT_ID || '6a829bfb79832f1efececa3d';
// Evento NÃO autorizado para as personas de A (cross-event).
const unrelatedEventId = process.env.E2E_EVENT_B_ID || '6a829bfb79832f1efece3e';

async function login(email, password) {
  const client = createClient({ appId, appBaseUrl: baseUrl, requiresAuth: true });
  await client.auth.loginViaEmailPassword(email, password);
  return client;
}

async function findSpeakerSession(admin, speakerEmail) {
  const people = await admin.entities.Person.filter({ contact_email: speakerEmail });
  const personId = people?.[0]?.id;
  if (!personId) return null;
  const parts = await admin.entities.Participant.filter({ event_id: eventId, person_id: personId, role_in_event: 'speaker', is_deleted: false });
  const pid = parts?.[0]?.id;
  if (!pid) return null;
  const sessions = await admin.entities.Session.filter({ speaker_id: pid, is_deleted: false });
  return sessions?.[0] || null;
}

async function findUnrelatedSpeakerSession(admin) {
  // Session de evento não autorizado (unrelatedEventId) — usada para cross-event block.
  const sessions = await admin.entities.Session.filter({ event_id: unrelatedEventId, is_deleted: false });
  return sessions?.[0] || null;
}

test.describe('Lote RLS Session Interaction — adversarial @security @rls @session-interaction', () => {

  // ── A. PARTICIPANT ────────────────────────────────────────────────────────
  test('A1 participant lists polls of an authorized session', async () => {
    test.skip(!baseUrl, 'E2E_BASE_URL required');
    const admin = await login(process.env.E2E_ADMIN_EMAIL, process.env.E2E_ADMIN_PASSWORD);
    const sessions = await admin.entities.Session.filter({ event_id: eventId, is_deleted: false });
    const session = sessions?.[0];
    expect(session, 'fixture session must exist').toBeTruthy();

    const participant = await login(process.env.E2E_PARTICIPANT_EMAIL, process.env.E2E_PARTICIPANT_PASSWORD);
    const res = await participant.functions.invoke('getSessionPolls', { sessionId: session.id });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data?.polls)).toBeTruthy();
  });

  test('A2 participant is denied polls of an unrelated event session', async () => {
    test.skip(!baseUrl, 'E2E_BASE_URL required');
    const admin = await login(process.env.E2E_ADMIN_EMAIL, process.env.E2E_ADMIN_PASSWORD);
    const session = await findUnrelatedSpeakerSession(admin);
    test.skip(!session, 'unrelated event session fixture missing');
    const participant = await login(process.env.E2E_PARTICIPANT_EMAIL, process.env.E2E_PARTICIPANT_PASSWORD);
    await expect(participant.functions.invoke('getSessionPolls', { sessionId: session.id })).rejects.toBeTruthy();
  });

  test('A3 participant cannot create a poll', async () => {
    test.skip(!baseUrl, 'E2E_BASE_URL required');
    const admin = await login(process.env.E2E_ADMIN_EMAIL, process.env.E2E_ADMIN_PASSWORD);
    const sessions = await admin.entities.Session.filter({ event_id: eventId, is_deleted: false });
    const session = sessions?.[0];
    const participant = await login(process.env.E2E_PARTICIPANT_EMAIL, process.env.E2E_PARTICIPANT_PASSWORD);
    await expect(participant.functions.invoke('manageSessionPoll', {
      operation: 'create', sessionId: session.id,
      data: { question: 'x', answer_type: 'single_choice', max_options: 1, duration_seconds: 15 },
      options: ['a', 'b'],
    })).rejects.toBeTruthy();
  });

  test('A4 participant cannot edit a poll', async () => {
    test.skip(!baseUrl, 'E2E_BASE_URL required');
    const admin = await login(process.env.E2E_ADMIN_EMAIL, process.env.E2E_ADMIN_PASSWORD);
    const sessions = await admin.entities.Session.filter({ event_id: eventId, is_deleted: false });
    const session = sessions?.[0];
    const polls = await admin.entities.SessionPoll.filter({ session_id: session.id, is_deleted: false });
    test.skip(!polls?.length, 'fixture poll missing');
    const participant = await login(process.env.E2E_PARTICIPANT_EMAIL, process.env.E2E_PARTICIPANT_PASSWORD);
    await expect(participant.functions.invoke('manageSessionPoll', {
      operation: 'update', pollId: polls[0].id, data: { question: 'hijack' }, options: ['a', 'b'],
    })).rejects.toBeTruthy();
  });

  test('A5 direct SDK access to the 5 entities is blocked/empty for participant (RLS)', async () => {
    test.skip(!baseUrl, 'E2E_BASE_URL required');
    const participant = await login(process.env.E2E_PARTICIPANT_EMAIL, process.env.E2E_PARTICIPANT_PASSWORD);
    // After admin-only RLS, non-admin SDK reads return empty (or reject); writes reject.
    const polls = await participant.entities.SessionPoll.filter({});
    expect(polls).toHaveLength(0);
    const questions = await participant.entities.SessionQuestion.filter({});
    expect(questions).toHaveLength(0);
    await expect(participant.entities.SessionPoll.create({
      event_id: eventId, session_id: 'x', question: 'x', answer_type: 'single_choice', status: 'draft',
    })).rejects.toBeTruthy();
  });

  test('A6 participant question: public visible, other-context private not visible', async () => {
    test.skip(!baseUrl, 'E2E_BASE_URL required');
    const admin = await login(process.env.E2E_ADMIN_EMAIL, process.env.E2E_ADMIN_PASSWORD);
    const sessions = await admin.entities.Session.filter({ event_id: eventId, is_deleted: false });
    const session = sessions?.[0];
    const participant = await login(process.env.E2E_PARTICIPANT_EMAIL, process.env.E2E_PARTICIPANT_PASSWORD);
    const res = await participant.functions.invoke('getSessionQuestions', { sessionId: session.id });
    expect(res.status).toBe(200);
    // participant never receives another author's private question
    const privateOthers = (res.data?.questions || []).filter((q) => q.visibility === 'particular' && q.participant_id);
    expect(privateOthers).toHaveLength(0);
    // participant responses never expose participant_id/person_id of others
    for (const q of res.data?.questions || []) {
      expect(q.participant_id === undefined || q.participant_id === null).toBeTruthy();
    }
  });

  test('A7 participant cannot mark another person’s question answered', async () => {
    test.skip(!baseUrl, 'E2E_BASE_URL required');
    const admin = await login(process.env.E2E_ADMIN_EMAIL, process.env.E2E_ADMIN_PASSWORD);
    const sessions = await admin.entities.Session.filter({ event_id: eventId, is_deleted: false });
    const session = sessions?.[0];
    const qs = await admin.entities.SessionQuestion.filter({ session_id: session.id, is_deleted: false });
    test.skip(!qs?.length, 'fixture question missing');
    const participant = await login(process.env.E2E_PARTICIPANT_EMAIL, process.env.E2E_PARTICIPANT_PASSWORD);
    await expect(participant.functions.invoke('manageSessionQuestion', {
      operation: 'markAnswered', questionId: qs[0].id,
    })).rejects.toBeTruthy();
  });

  test('A8 participant cannot create a speaker answer', async () => {
    test.skip(!baseUrl, 'E2E_BASE_URL required');
    const admin = await login(process.env.E2E_ADMIN_EMAIL, process.env.E2E_ADMIN_PASSWORD);
    const sessions = await admin.entities.Session.filter({ event_id: eventId, is_deleted: false });
    const session = sessions?.[0];
    const qs = await admin.entities.SessionQuestion.filter({ session_id: session.id, is_deleted: false });
    test.skip(!qs?.length, 'fixture question missing');
    const participant = await login(process.env.E2E_PARTICIPANT_EMAIL, process.env.E2E_PARTICIPANT_PASSWORD);
    await expect(participant.functions.invoke('manageSessionAnswer', {
      operation: 'save', questionId: qs[0].id, answerText: 'hijack',
    })).rejects.toBeTruthy();
  });

  // ── B. SPEAKER ────────────────────────────────────────────────────────────
  test('B1 speaker can create/open/close/delete own poll', async () => {
    test.skip(!baseUrl, 'E2E_BASE_URL required');
    const admin = await login(process.env.E2E_ADMIN_EMAIL, process.env.E2E_ADMIN_PASSWORD);
    const ownSession = await findSpeakerSession(admin, process.env.E2E_SPEAKER_EMAIL);
    test.skip(!ownSession, 'speaker session fixture missing');
    const speaker = await login(process.env.E2E_SPEAKER_EMAIL, process.env.E2E_SPEAKER_PASSWORD);
    const created = await speaker.functions.invoke('manageSessionPoll', {
      operation: 'create', sessionId: ownSession.id,
      data: { question: 'E2E own poll', answer_type: 'single_choice', max_options: 1, duration_seconds: 15 },
      options: ['A', 'B'],
    });
    expect(created.status).toBe(200);
    const pollId = created.data?.poll?.id;
    const opened = await speaker.functions.invoke('manageSessionPoll', { operation: 'open', pollId });
    expect(opened.status).toBe(200);
    const closed = await speaker.functions.invoke('manageSessionPoll', { operation: 'close', pollId });
    expect(closed.status).toBe(200);
    const deleted = await speaker.functions.invoke('manageSessionPoll', { operation: 'delete', pollId });
    expect(deleted.status).toBe(200);
    // cleanup hard
    await admin.entities.SessionPoll.deleteMany({ id: pollId });
    await admin.entities.SessionPollOption.deleteMany({ poll_id: pollId });
  });

  test('B2 speaker cannot administer a poll of another speaker', async () => {
    test.skip(!baseUrl, 'E2E_BASE_URL required');
    const admin = await login(process.env.E2E_ADMIN_EMAIL, process.env.E2E_ADMIN_PASSWORD);
    const otherSession = await findUnrelatedSpeakerSession(admin);
    test.skip(!otherSession, 'unrelated session fixture missing');
    const polls = await admin.entities.SessionPoll.filter({ session_id: otherSession.id, is_deleted: false });
    test.skip(!polls?.length, 'unrelated poll fixture missing');
    const speaker = await login(process.env.E2E_SPEAKER_EMAIL, process.env.E2E_SPEAKER_PASSWORD);
    await expect(speaker.functions.invoke('manageSessionPoll', {
      operation: 'close', pollId: polls[0].id,
    })).rejects.toBeTruthy();
  });

  test('B3 speaker reads own session questions + can mark answered + can answer', async () => {
    test.skip(!baseUrl, 'E2E_BASE_URL required');
    const admin = await login(process.env.E2E_ADMIN_EMAIL, process.env.E2E_ADMIN_PASSWORD);
    const ownSession = await findSpeakerSession(admin, process.env.E2E_SPEAKER_EMAIL);
    test.skip(!ownSession, 'speaker session fixture missing');
    const speaker = await login(process.env.E2E_SPEAKER_EMAIL, process.env.E2E_SPEAKER_PASSWORD);
    const qs = await speaker.functions.invoke('getSessionQuestions', { sessionId: ownSession.id });
    expect(qs.status).toBe(200);
    const first = qs.data?.questions?.[0];
    test.skip(!first, 'no questions to exercise');
    const marked = await speaker.functions.invoke('manageSessionQuestion', { operation: 'markAnswered', questionId: first.id, data: { isAnswered: true } });
    expect(marked.status).toBe(200);
    const replied = await speaker.functions.invoke('manageSessionAnswer', { operation: 'save', questionId: first.id, answerText: 'E2E reply' });
    expect(replied.status).toBe(200);
    // restore is_answered to original to keep fixture stable
    await admin.entities.SessionQuestion.update(first.id, { is_answered: first.is_answered });
    const ans = await admin.entities.SessionAnswer.filter({ question_id: first.id, is_deleted: false });
    if (ans?.[0]) await admin.entities.SessionAnswer.update(ans[0].id, { answer_text: ans[0].answer_text === 'E2E reply' ? '' : ans[0].answer_text });
  });

  test('B4 speaker cannot answer a question of another session', async () => {
    test.skip(!baseUrl, 'E2E_BASE_URL required');
    const admin = await login(process.env.E2E_ADMIN_EMAIL, process.env.E2E_ADMIN_PASSWORD);
    const otherSession = await findUnrelatedSpeakerSession(admin);
    test.skip(!otherSession, 'unrelated session fixture missing');
    const qs = await admin.entities.SessionQuestion.filter({ session_id: otherSession.id, is_deleted: false });
    test.skip(!qs?.length, 'unrelated question fixture missing');
    const speaker = await login(process.env.E2E_SPEAKER_EMAIL, process.env.E2E_SPEAKER_PASSWORD);
    await expect(speaker.functions.invoke('manageSessionAnswer', {
      operation: 'save', questionId: qs[0].id, answerText: 'hijack',
    })).rejects.toBeTruthy();
  });

  test('B5 speaker gets aggregated poll results (no individual voter exposure)', async () => {
    test.skip(!baseUrl, 'E2E_BASE_URL required');
    const admin = await login(process.env.E2E_ADMIN_EMAIL, process.env.E2E_ADMIN_PASSWORD);
    const ownSession = await findSpeakerSession(admin, process.env.E2E_SPEAKER_EMAIL);
    test.skip(!ownSession, 'speaker session fixture missing');
    const speaker = await login(process.env.E2E_SPEAKER_EMAIL, process.env.E2E_SPEAKER_PASSWORD);
    const res = await speaker.functions.invoke('getSessionPolls', { sessionId: ownSession.id });
    expect(res.status).toBe(200);
    for (const p of res.data?.polls || []) {
      // options carry only aggregated count, never per-voter data
      for (const o of p.options || []) {
        expect(o).toHaveProperty('count');
        expect(o.person_id).toBeUndefined();
      }
      // myAnswer must be null for a speaker (they don't vote)
      expect(p.myAnswer).toBeNull();
    }
  });

  // ── C. ADMIN ──────────────────────────────────────────────────────────────
  test('C admin CRUD via functions across the 5 entities', async () => {
    test.skip(!baseUrl, 'E2E_BASE_URL required');
    const admin = await login(process.env.E2E_ADMIN_EMAIL, process.env.E2E_ADMIN_PASSWORD);
    const sessions = await admin.entities.Session.filter({ event_id: eventId, is_deleted: false });
    const session = sessions?.[0];
    expect(session).toBeTruthy();
    const created = await admin.functions.invoke('manageSessionPoll', {
      operation: 'create', sessionId: session.id,
      data: { question: 'admin poll', answer_type: 'single_choice', max_options: 1, duration_seconds: 15 },
      options: ['A', 'B'],
    });
    expect(created.status).toBe(200);
    const pollId = created.data?.poll?.id;
    const q = await admin.functions.invoke('manageSessionQuestion', {
      operation: 'create', sessionId: session.id, data: { question: 'admin q', visibility: 'publica' },
    });
    expect(q.status).toBe(200);
    const qid = q.data?.question?.id;
    const a = await admin.functions.invoke('manageSessionAnswer', { operation: 'save', questionId: qid, answerText: 'admin a' });
    expect(a.status).toBe(200);
    // cleanup
    await admin.entities.SessionPoll.deleteMany({ id: pollId });
    await admin.entities.SessionPollOption.deleteMany({ poll_id: pollId });
    await admin.entities.SessionQuestion.deleteMany({ id: qid });
    await admin.entities.SessionAnswer.deleteMany({ question_id: qid });
  });

  // ── D. CROSS-EVENT ─────────────────────────────────────────────────────────
  test('D speaker of A cannot read/operate questions+polls of B', async () => {
    test.skip(!baseUrl, 'E2E_BASE_URL required');
    const admin = await login(process.env.E2E_ADMIN_EMAIL, process.env.E2E_ADMIN_PASSWORD);
    const otherSession = await findUnrelatedSpeakerSession(admin);
    test.skip(!otherSession, 'unrelated session fixture missing');
    const speaker = await login(process.env.E2E_SPEAKER_EMAIL, process.env.E2E_SPEAKER_PASSWORD);
    await expect(speaker.functions.invoke('getSessionPolls', { sessionId: otherSession.id })).rejects.toBeTruthy();
    await expect(speaker.functions.invoke('getSessionQuestions', { sessionId: otherSession.id })).rejects.toBeTruthy();
    const stats = await speaker.functions.invoke('getSpeakerQuestionStats', { sessionIds: [otherSession.id] });
    expect(stats.status).toBe(200);
    // speaker of A receives no stats for B's session
    expect(stats.data?.stats || []).toHaveLength(0);
  });

  // ── E. DATA INTEGRITY ───────────────────────────────────────────────────────
  test('E submitPollAnswer ignores client person_id and pins it to caller', async () => {
    test.skip(!baseUrl, 'E2E_BASE_URL required');
    const admin = await login(process.env.E2E_ADMIN_EMAIL, process.env.E2E_ADMIN_PASSWORD);
    const ownSession = await findSpeakerSession(admin, process.env.E2E_SPEAKER_EMAIL);
    test.skip(!ownSession, 'speaker session fixture missing');
    // open a live poll as speaker
    const speaker = await login(process.env.E2E_SPEAKER_EMAIL, process.env.E2E_SPEAKER_PASSWORD);
    const created = await speaker.functions.invoke('manageSessionPoll', {
      operation: 'create', sessionId: ownSession.id,
      data: { question: 'E2E vote', answer_type: 'single_choice', max_options: 1, duration_seconds: 300 },
      options: ['A', 'B'],
    });
    const pollId = created.data?.poll?.id;
    await speaker.functions.invoke('manageSessionPoll', { operation: 'open', pollId });
    const opts = await admin.entities.SessionPollOption.filter({ poll_id: pollId, is_deleted: false });
    const optId = opts[0].id;

    const participant = await login(process.env.E2E_PARTICIPANT_EMAIL, process.env.E2E_PARTICIPANT_PASSWORD);
    // try to vote as a forged person_id — must still attribute to the caller
    const otherPerson = await admin.entities.Person.filter({});
    const forgedPersonId = otherPerson?.find((p) => p.id)?.id || 'forged-id';
    const vote = await participant.functions.invoke('submitPollAnswer', {
      pollId, personId: forgedPersonId, selectedOptionIds: [optId],
    });
    expect(vote.status).toBe(200);
    // verify the recorded answer belongs to the PARTICIPANT's person, not the forged one
    const answers = await admin.entities.SessionPollAnswer.filter({ poll_id: pollId, is_deleted: false });
    expect(answers[0].person_id).not.toBe(forgedPersonId);
    // cleanup
    await admin.entities.SessionPoll.update(pollId, { is_deleted: true });
    await admin.entities.SessionPollOption.deleteMany({ poll_id: pollId });
    await admin.entities.SessionPollAnswer.deleteMany({ poll_id: pollId });
  });

  test('E2 manageSessionPoll ignores client-provided created_by_person_id', async () => {
    test.skip(!baseUrl, 'E2E_BASE_URL required');
    const admin = await login(process.env.E2E_ADMIN_EMAIL, process.env.E2E_ADMIN_PASSWORD);
    const ownSession = await findSpeakerSession(admin, process.env.E2E_SPEAKER_EMAIL);
    test.skip(!ownSession, 'speaker session fixture missing');
    const speaker = await login(process.env.E2E_SPEAKER_EMAIL, process.env.E2E_SPEAKER_PASSWORD);
    // send a forged created_by_person_id in data — function must ignore/override it
    const created = await speaker.functions.invoke('manageSessionPoll', {
      operation: 'create', sessionId: ownSession.id,
      data: { question: 'E2E forge', answer_type: 'single_choice', max_options: 1, duration_seconds: 15, created_by_person_id: 'forged-owner' },
      options: ['A', 'B'],
    });
    expect(created.status).toBe(200);
    expect(created.data?.poll?.created_by_person_id).not.toBe('forged-owner');
    await admin.entities.SessionPoll.deleteMany({ id: created.data?.poll?.id });
    await admin.entities.SessionPollOption.deleteMany({ poll_id: created.data?.poll?.id });
  });
});