/**
 * Renderiza um certificado com template personalizado (imagem de fundo + campos posicionados).
 * Props: event, person, session, tipo, hashCode, issuedByName, customTemplate
 */
function fmtBR(dt) {
  if (!dt) return "—";
  return new Date(dt).toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });
}

export function buildFieldValues({ event, person, session, tipo, hashCode, issuedByName }) {
  const start = fmtBR(event?.start_date);
  const end = fmtBR(event?.end_date);
  const dates = start === end ? start : `${start} a ${end}`;
  return {
    participant_name: person?.full_name || "—",
    event_name: event?.name || "—",
    event_dates: dates,
    issued_by_name: issuedByName || "—",
    session_title: session?.title || "—",
    hash_code: hashCode || "—",
    issue_date: fmtBR(new Date().toISOString()),
  };
}

export const FIELD_DEFINITIONS = [
  { key: "participant_name", label: "Nome do Participante", sample: "João da Silva" },
  { key: "event_name", label: "Nome do Evento", sample: "Congresso Tech 2025" },
  { key: "event_dates", label: "Datas do Evento", sample: "15 a 17 de março de 2025" },
  { key: "issued_by_name", label: "Assinatura do Gerente", sample: "Maria Santos" },
  { key: "session_title", label: "Título da Palestra", sample: "Inovação Digital" },
  { key: "hash_code", label: "Código de Validação", sample: "AB12-CD34" },
  { key: "issue_date", label: "Data de Emissão", sample: "02 de julho de 2026" },
];

export const DEFAULT_FIELD_CONFIG = {
  enabled: false,
  x: 50,
  y: 50,
  font_size: 20,
  font_color: "#000000",
  font_family: "Arial, sans-serif",
  text_align: "center",
};

export default function CustomCertificatePreview({ event, person, session, tipo, hashCode, issuedByName, customTemplate, id = "cert-render" }) {
  let fieldConfigs = {};
  if (customTemplate?.field_configs) {
    try {
      fieldConfigs = JSON.parse(customTemplate.field_configs);
    } catch {
      fieldConfigs = {};
    }
  }

  const values = buildFieldValues({ event, person, session, tipo, hashCode, issuedByName });

  const transformForAlign = (align) => {
    if (align === "center") return "translate(-50%, -50%)";
    if (align === "right") return "translate(-100%, -50%)";
    return "translate(0, -50%)";
  };

  return (
    <div
      id={id}
      className="bg-white relative overflow-hidden"
      style={{ width: "794px", minHeight: "562px" }}
    >
      {customTemplate?.background_url && (
        <img
          src={customTemplate.background_url}
          alt=""
          crossOrigin="anonymous"
          style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", objectFit: "cover" }}
        />
      )}
      {Object.entries(fieldConfigs).map(([key, config]) => {
        if (!config?.enabled) return null;
        const isCustom = key.startsWith("custom_text_");
        const value = isCustom ? config.custom_text : values[key];
        if (!value) return null;
        return (
          <div
            key={key}
            style={{
              position: "absolute",
              left: `${config.x}%`,
              top: `${config.y}%`,
              transform: transformForAlign(config.text_align),
              fontSize: `${config.font_size}px`,
              color: config.font_color,
              fontFamily: config.font_family,
              textAlign: config.text_align,
              whiteSpace: "pre-wrap",
              zIndex: 10,
              maxWidth: "90%",
            }}
          >
            {value}
          </div>
        );
      })}
    </div>
  );
}