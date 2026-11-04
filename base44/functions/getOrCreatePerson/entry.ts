import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { incPersons } from "../../shared/businessMetrics.ts";
import { normalizeEmail, emailMatchVariants } from "../../shared/identity.ts";
import { deterministicCompare } from "../../shared/deterministicSurvivor.ts";
import { linkPendingInvites, linkPendingPartnerReps } from "../../shared/eventInvites.ts";

// CADASTRO ÚNICO E ATÔMICO (2026-11-04) — User e Person nascem juntos.
//
// Regra: NENHUMA conta usa o app sem Person vinculada. Esta função é a única
// porta que cria/vincula a Person e ela só devolve sucesso depois de CONFIRMAR
// a gravação de User.person_id. Nada é engolido: qualquer falha vira erro e o
// acesso permanece bloqueado (o chamador NÃO recebe person_id).
//
// Atomicidade lógica (a plataforma é dona da criação do User e não oferece
// transação entre entidades — updateMany é recusado em User):
//   1. Person única por e-mail normalizado. Mais de uma correspondência
//      PRÉ-EXISTENTE é AMBIGUIDADE: o vínculo é recusado (nunca "pega a primeira").
//   2. Corrida entre cadastros simultâneos: cada chamada converge pelo
//      sobrevivente determinístico (created_date, id). O perdedor desativa a
//      Person que ele mesmo criou e aponta para o sobrevivente — as duas
//      chamadas terminam no MESMO vínculo, sem acesso duplicado.
//   3. Vínculo gravado e RELIDO da base — só então sucesso.
//   4. Falha ao gravar o vínculo desfaz a Person recém-criada (nada de órfã).
//
// Identidade (nunca vinda do cliente): sessão autenticada ou, no gatilho de
// signup, o user_id recém-criado (janela de 5 min).

const NEUTRAL_ERROR = "Não foi possível concluir seu cadastro. Tente novamente.";
const SIGNUP_WINDOW_MINUTES = 5;

export default async function(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const { user_id } = body;

    const base44 = createClientFromRequest(req);
    const svc = base44.asServiceRole;

    // ---- 1. Identidade confiável -------------------------------------------
    let accountId = null;
    const authUser = await base44.auth.me().catch((e) => (e.status === 401 || e.status === 403 ? null : Promise.reject(e)));
    if (authUser?.id) {
      accountId = authUser.id;
    } else {
      // Gatilho de signup: user_id recém-criado. Não é possível enumerar contas.
      if (!user_id) return Response.json({ error: 'Unauthorized' }, { status: 401 });
      const candidates = await svc.entities.User.filter({ id: user_id });
      const candidate = candidates?.[0];
      const ageMinutes = candidate ? (Date.now() - new Date(candidate.created_date).getTime()) / 60000 : Infinity;
      if (!candidate || !(ageMinutes <= SIGNUP_WINDOW_MINUTES)) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }
      accountId = candidate.id;
    }

    // Registro autoritativo (o objeto da sessão pode estar em cache).
    const accountRows = await svc.entities.User.filter({ id: accountId });
    const account = accountRows?.[0];
    if (!account) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (account.account_status === 'deleted') {
      return Response.json({ error: 'Conta excluída — operação não permitida.' }, { status: 403 });
    }

    const email = normalizeEmail(account.email);
    if (!email) return Response.json({ error: NEUTRAL_ERROR }, { status: 500 });

    // ---- 2. Vínculo já existente e válido → idempotente ---------------------
    if (account.person_id) {
      const linked = await svc.entities.Person.filter({ id: account.person_id });
      if (linked?.[0]?.id) {
        // Convites de evento pendentes viram vínculo no acesso (idempotente).
        let linkedInvites = 0;
        try {
          const claimed = await linkPendingInvites(svc, {
            personId: linked[0].id,
            userId: account.id,
            email: account.email,
          });
          linkedInvites = claimed.linked;
        } catch (e) { console.error('linkPendingInvites failed:', e?.message || e); }
        // Representantes de parceiro que esperavam conta nascem agora.
        try {
          await linkPendingPartnerReps(svc, { personId: linked[0].id, userId: account.id });
        } catch (e) { console.error('linkPendingPartnerReps failed:', e?.message || e); }
        return Response.json({ status: 'exists', person_id: linked[0].id, linked_invites: linkedInvites });
      }
      // vínculo aponta para Person inexistente → re-resolve abaixo
    }

    // ---- 3. Person única por e-mail ----------------------------------------
    const listByEmail = async () => {
      const rows = await svc.entities.Person.filter({
        contact_email: { $in: emailMatchVariants(account.email) },
        is_active: { $ne: false },
      });
      return (rows || []).filter((p) => normalizeEmail(p.contact_email) === email && !!p.id);
    };

    const candidates = await listByEmail();
    if (candidates.length > 1) {
      return Response.json({
        error: 'Seu cadastro não pôde ser concluído. Mais de um cadastro de pessoa usa este e-mail.',
        reason: 'identity_ambiguous',
        person_ids: candidates.map((p) => p.id),
      }, { status: 409 });
    }

    let person = candidates[0] || null;
    let createdId = null;

    if (!person) {
      person = await svc.entities.Person.create({
        full_name: account.full_name || 'Novo Usuário',
        contact_email: email,
        is_active: true,
        created_day: new Date().toISOString().slice(0, 10),
        metrics_inc: true,
      });
      if (!person?.id) {
        return Response.json({ error: NEUTRAL_ERROR, reason: 'person_not_created' }, { status: 500 });
      }
      createdId = person.id;

      // Corrida entre cadastros simultâneos: as duas chamadas elegem o MESMO
      // sobrevivente e o perdedor sai de cena (nunca fica Person duplicada).
      const afterCreate = await listByEmail();
      if (afterCreate.length > 1) {
        const survivor = [...afterCreate].sort(deterministicCompare)[0];
        for (const extra of afterCreate) {
          if (extra.id === survivor.id) continue;
          try { await svc.entities.Person.update(extra.id, { is_active: false }); } catch { /* converge no próximo */ }
        }
        person = survivor;
      }
    }

    // ---- 4. Vínculo gravado e CONFIRMADO -----------------------------------
    await svc.entities.User.update(account.id, { person_id: person.id });
    const confirmedRows = await svc.entities.User.filter({ id: account.id });
    if (confirmedRows?.[0]?.person_id !== person.id) {
      if (createdId === person.id) {
        try { await svc.entities.Person.delete(person.id); } catch { /* nada a desfazer */ }
      }
      return Response.json({ error: NEUTRAL_ERROR, reason: 'link_not_persisted' }, { status: 500 });
    }

    // Contador de negócio só depois do vínculo confirmado (telemetria).
    if (createdId === person.id) {
      try { await incPersons(svc, person.created_date || new Date().toISOString()); } catch { /* reconcile corrige */ }
    }

    // CONVITES DE EVENTO (2026-11-04) — o admin criou o evento e informou este
    // e-mail como gerente antes de a conta existir. Ao concluir o cadastro o
    // vínculo nasce aqui: a pessoa já abre o evento pronto para gerir.
    let linkedInvites = 0;
    try {
      const claimed = await linkPendingInvites(svc, {
        personId: person.id,
        userId: account.id,
        email: account.email,
      });
      linkedInvites = claimed.linked;
    } catch (e) { console.error('linkPendingInvites failed:', e?.message || e); }

    try {
      await linkPendingPartnerReps(svc, { personId: person.id, userId: account.id });
    } catch (e) { console.error('linkPendingPartnerReps failed:', e?.message || e); }

    return Response.json({
      status: createdId === person.id ? 'created' : 'exists',
      person_id: person.id,
      linked_invites: linkedInvites,
    });
  } catch (error) {
    console.error('getOrCreatePerson error:', error?.message || error);
    return Response.json({ error: NEUTRAL_ERROR }, { status: 500 });
  }
}