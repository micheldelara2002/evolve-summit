/**
 * Templates de certificado — renderiza SVG/HTML para exibição e impressão.
 * Props: event, person, session (nullable), tipo, template, hashCode, issuedByName
 */

function fmt(dt) {
  if (!dt) return "—";
  return new Date(dt).toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });
}

function buildText({ tipo, person, event, session }) {
  if (tipo === "palestra") {
    const dt = session?.start_time ? fmt(session.start_time) : "—";
    return `Certificamos que ${person?.full_name || "—"} ministrou a palestra "${session?.title || "—"}" no evento ${event?.name || "—"}, em ${dt}.`;
  }
  const start = fmt(event?.start_date);
  const end = fmt(event?.end_date);
  return `Certificamos que ${person?.full_name || "—"} participou do evento ${event?.name || "—"}, realizado de ${start} a ${end}.`;
}

// ── Template Clássico ─────────────────────────────────────────────────────────
function ClassicoTemplate({ event, person, session, tipo, hashCode, issuedByName }) {
  const text = buildText({ tipo, person, event, session });
  return (
    <div
      id="cert-render"
      className="bg-white relative overflow-hidden"
      style={{ width: "794px", minHeight: "562px", fontFamily: "Georgia, serif", border: "8px double #1e3a5f", padding: "40px 56px" }}
    >
      {/* Borda interna decorativa */}
      <div style={{ position: "absolute", inset: "16px", border: "1px solid #1e3a5f", pointerEvents: "none" }} />

      {/* Logo + Nome evento */}
      <div style={{ display: "flex", alignItems: "center", gap: "16px", marginBottom: "24px" }}>
        {event?.logo_url ? (
          <img src={event.logo_url} alt="" style={{ height: "56px", objectFit: "contain" }} />
        ) : (
          <div style={{ width: "56px", height: "56px", borderRadius: "8px", backgroundColor: event?.color_primary || "#1e3a5f", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: "bold", fontSize: "20px" }}>
            {event?.name?.[0]}
          </div>
        )}
        <div>
          <p style={{ fontSize: "11px", color: "#6b7280", letterSpacing: "2px", textTransform: "uppercase", marginBottom: "2px" }}>Certificado de {tipo === "palestra" ? "Palestra" : "Participação"}</p>
          <p style={{ fontSize: "18px", fontWeight: "bold", color: "#1e3a5f" }}>{event?.name}</p>
        </div>
      </div>

      <hr style={{ borderColor: "#1e3a5f", borderWidth: "1px", margin: "0 0 32px 0" }} />

      {/* Título */}
      <p style={{ fontSize: "13px", color: "#6b7280", textAlign: "center", letterSpacing: "3px", textTransform: "uppercase", marginBottom: "8px" }}>Certificado de {tipo === "palestra" ? "Palestra" : "Participação"}</p>
      <p style={{ fontSize: "32px", fontWeight: "bold", textAlign: "center", color: "#1e3a5f", marginBottom: "24px" }}>{person?.full_name}</p>

      {/* Texto */}
      <p style={{ fontSize: "15px", color: "#374151", textAlign: "center", lineHeight: "1.8", maxWidth: "600px", margin: "0 auto 40px" }}>{text}</p>

      {/* Assinatura */}
      <div style={{ display: "flex", justifyContent: "center", marginBottom: "32px" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ width: "200px", borderBottom: "1px solid #374151", marginBottom: "8px" }} />
          <p style={{ fontSize: "12px", color: "#374151" }}>{issuedByName || "Gerente do Evento"}</p>
          <p style={{ fontSize: "11px", color: "#9ca3af" }}>Organizador</p>
        </div>
      </div>

      {/* Hash no rodapé */}
      <div style={{ position: "absolute", bottom: "28px", left: "56px", right: "56px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <p style={{ fontSize: "10px", color: "#9ca3af" }}>Emitido em {fmt(new Date().toISOString())}</p>
        <p style={{ fontSize: "10px", color: "#9ca3af", fontFamily: "monospace" }}>ID: {hashCode}</p>
      </div>
    </div>
  );
}

// ── Template Moderno ──────────────────────────────────────────────────────────
function ModernoTemplate({ event, person, session, tipo, hashCode, issuedByName }) {
  const text = buildText({ tipo, person, event, session });
  const primary = event?.color_primary || "#4F46E5";
  return (
    <div
      id="cert-render"
      className="bg-white relative"
      style={{ width: "794px", minHeight: "562px", fontFamily: "'Inter', sans-serif", display: "flex", overflow: "hidden" }}
    >
      {/* Barra lateral colorida */}
      <div style={{ width: "12px", backgroundColor: primary, flexShrink: 0 }} />

      <div style={{ flex: 1, padding: "48px 56px" }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "36px" }}>
          <div>
            <p style={{ fontSize: "11px", color: "#6b7280", letterSpacing: "2px", textTransform: "uppercase", marginBottom: "4px" }}>
              Certificado de {tipo === "palestra" ? "Palestra" : "Participação"}
            </p>
            <p style={{ fontSize: "22px", fontWeight: "800", color: "#111827" }}>{event?.name}</p>
          </div>
          {event?.logo_url && <img src={event.logo_url} alt="" style={{ height: "48px", objectFit: "contain" }} />}
        </div>

        {/* Nome */}
        <div style={{ marginBottom: "24px" }}>
          <p style={{ fontSize: "13px", color: "#6b7280", marginBottom: "4px" }}>Este certificado é concedido a</p>
          <p style={{ fontSize: "38px", fontWeight: "800", color: primary, lineHeight: 1.1 }}>{person?.full_name}</p>
        </div>

        {/* Linha decorativa */}
        <div style={{ height: "3px", width: "80px", backgroundColor: primary, borderRadius: "2px", marginBottom: "24px" }} />

        {/* Texto */}
        <p style={{ fontSize: "14px", color: "#4b5563", lineHeight: "1.8", maxWidth: "520px", marginBottom: "40px" }}>{text}</p>

        {/* Footer */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
          <div>
            <div style={{ width: "160px", borderBottom: "1px solid #d1d5db", marginBottom: "6px" }} />
            <p style={{ fontSize: "12px", color: "#374151", fontWeight: "600" }}>{issuedByName || "Gerente do Evento"}</p>
            <p style={{ fontSize: "11px", color: "#9ca3af" }}>Organizador</p>
          </div>
          <p style={{ fontSize: "10px", color: "#9ca3af", fontFamily: "monospace" }}>ID: {hashCode}</p>
        </div>
      </div>
    </div>
  );
}

// ── Template Minimalista ──────────────────────────────────────────────────────
function MinimalistaTemplate({ event, person, session, tipo, hashCode, issuedByName }) {
  const text = buildText({ tipo, person, event, session });
  return (
    <div
      id="cert-render"
      className="bg-white"
      style={{ width: "794px", minHeight: "562px", fontFamily: "'Inter', sans-serif", padding: "64px 80px", display: "flex", flexDirection: "column", justifyContent: "space-between" }}
    >
      <div>
        {/* Logo */}
        {event?.logo_url ? (
          <img src={event.logo_url} alt="" style={{ height: "40px", objectFit: "contain", marginBottom: "48px" }} />
        ) : (
          <p style={{ fontSize: "14px", fontWeight: "700", color: "#111827", marginBottom: "48px" }}>{event?.name}</p>
        )}

        {/* Label */}
        <p style={{ fontSize: "10px", letterSpacing: "4px", textTransform: "uppercase", color: "#9ca3af", marginBottom: "12px" }}>
          Certificado de {tipo === "palestra" ? "Palestra" : "Participação"}
        </p>

        {/* Nome */}
        <p style={{ fontSize: "44px", fontWeight: "300", color: "#111827", lineHeight: 1.1, marginBottom: "32px" }}>{person?.full_name}</p>

        {/* Texto */}
        <p style={{ fontSize: "14px", color: "#6b7280", lineHeight: "1.9", maxWidth: "560px" }}>{text}</p>
      </div>

      {/* Footer */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", borderTop: "1px solid #e5e7eb", paddingTop: "24px" }}>
        <div>
          <div style={{ width: "120px", borderBottom: "1px solid #d1d5db", marginBottom: "6px" }} />
          <p style={{ fontSize: "12px", color: "#374151" }}>{issuedByName || "Gerente do Evento"}</p>
        </div>
        <p style={{ fontSize: "9px", color: "#d1d5db", fontFamily: "monospace" }}>ID: {hashCode}</p>
      </div>
    </div>
  );
}

// ── Exported component ────────────────────────────────────────────────────────
export default function CertificatePreview({ template = "classico", ...props }) {
  if (template === "moderno") return <ModernoTemplate {...props} />;
  if (template === "minimalista") return <MinimalistaTemplate {...props} />;
  return <ClassicoTemplate {...props} />;
}