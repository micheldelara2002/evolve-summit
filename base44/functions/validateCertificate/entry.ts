import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const hashCode = typeof body.hashCode === 'string' ? body.hashCode.trim().toUpperCase() : '';

    if (!hashCode) {
      return Response.json({ error: 'Código do certificado é obrigatório.' }, { status: 400 });
    }

    const certs = await base44.asServiceRole.entities.Certificate.filter({
      hash_code: hashCode,
      is_deleted: false,
    });

    if (!certs.length) {
      return Response.json({ valid: false });
    }

    const cert = certs[0];

    let eventName = '—';
    if (cert.event_id) {
      const events = await base44.asServiceRole.entities.Event.filter({ id: cert.event_id });
      eventName = events[0]?.name || '—';
    }

    let personName = '—';
    if (cert.person_id) {
      const persons = await base44.asServiceRole.entities.Person.filter({ id: cert.person_id });
      personName = persons[0]?.full_name || '—';
    }

    return Response.json({
      valid: true,
      certificate: {
        hash_code: cert.hash_code,
        tipo: cert.tipo,
        created_date: cert.created_date,
        event_name: eventName,
        person_name: personName,
      },
    });
  } catch (error) {
    return Response.json({ error: error?.message || 'Erro ao validar certificado.' }, { status: 500 });
  }
});
