/**
 * Modelo da matriz de badges (conquistas): constantes, seeds padrão e geração
 * automática de descrição a partir do critério.
 */
import { ACAO_EVENTO_LABELS } from "@/lib/acaoEvento";

export const COLUNAS = ["partindo", "aquecendo", "acelerando", "voando"];
export const CATEGORIAS = ["engajamento", "conteudo", "networking"];

export const COL_LABELS = {
  partindo: "🚀 Partindo",
  aquecendo: "🔥 Aquecendo",
  acelerando: "⚡ Acelerando",
  voando: "🦅 Voando",
};

export const CAT_LABELS = {
  engajamento: "Engajamento",
  conteudo: "Conteúdo",
  networking: "Networking",
};

export const CAT_COLORS = {
  engajamento: { bg: "bg-blue-50", border: "border-blue-200", label: "bg-blue-100 text-blue-700" },
  conteudo:    { bg: "bg-purple-50", border: "border-purple-200", label: "bg-purple-100 text-purple-700" },
  networking: { bg: "bg-emerald-50", border: "border-emerald-200", label: "bg-emerald-100 text-emerald-700" },
};

export const CRITERIO_LABELS = {
  first: "Primeiro(a)",
  count: "Contagem",
  percent: "Percentual (%)",
  points_total: "Pontos acumulados",
};

export const ICONE_SUGESTOES = {
  engajamento: ["🏅", "⭐", "🎯", "💫", "🌟", "🏆", "🎖️", "✨"],
  conteudo:    ["📚", "💡", "🎓", "📖", "🔬", "🎯", "💎", "🧠"],
  networking: ["🤝", "🌐", "💬", "👥", "🔗", "🌍", "💼", "🤜"],
};

export const DEFAULT_SEEDS = [
  // Engajamento
  { codigo: "1A", titulo: "Primeira presença em sessão", categoria: "engajamento", coluna_progresso: "partindo",   criterio_tipo: "first",        acao_referencia: "presenca_sessao",   valor_meta: 1,    icone_emoji: "🏅", icone_cor: "#3B82F6" },
  { codigo: "1B", titulo: "Perfil completo",             categoria: "engajamento", coluna_progresso: "aquecendo",  criterio_tipo: "percent",      acao_referencia: "completude_perfil", valor_meta: 90,   icone_emoji: "⭐", icone_cor: "#60A5FA" },
  { codigo: "1C", titulo: "Presenças acumuladas",        categoria: "engajamento", coluna_progresso: "acelerando", criterio_tipo: "count",        acao_referencia: "presenca_sessao",   valor_meta: 5,    icone_emoji: "🎯", icone_cor: "#2563EB" },
  { codigo: "1D", titulo: "Pontos acumulados",           categoria: "engajamento", coluna_progresso: "voando",     criterio_tipo: "points_total", acao_referencia: null,                valor_meta: 1000, icone_emoji: "🏆", icone_cor: "#1D4ED8" },
  // Conteúdo
  { codigo: "2A", titulo: "Primeira avaliação",          categoria: "conteudo",    coluna_progresso: "partindo",   criterio_tipo: "first",        acao_referencia: "avaliacao_sessao",  valor_meta: 1,  icone_emoji: "📚", icone_cor: "#9333EA" },
  { codigo: "2B", titulo: "Primeiro resgate",            categoria: "conteudo",    coluna_progresso: "aquecendo",  criterio_tipo: "first",        acao_referencia: "resgate_realizado", valor_meta: 1,  icone_emoji: "💡", icone_cor: "#A855F7" },
  { codigo: "2C", titulo: "Avaliações acumuladas",       categoria: "conteudo",    coluna_progresso: "acelerando", criterio_tipo: "count",        acao_referencia: "avaliacao_sessao",  valor_meta: 3,  icone_emoji: "🎓", icone_cor: "#7C3AED" },
  { codigo: "2D", titulo: "Perguntas enviadas",          categoria: "conteudo",    coluna_progresso: "voando",     criterio_tipo: "count",        acao_referencia: "pergunta_valida",   valor_meta: 3,  icone_emoji: "💎", icone_cor: "#6D28D9" },
  // Networking
  { codigo: "3A", titulo: "Primeira conexão",            categoria: "networking",  coluna_progresso: "partindo",   criterio_tipo: "first",        acao_referencia: "conexao_aceita",    valor_meta: 1,  icone_emoji: "🤝", icone_cor: "#059669" },
  { codigo: "3B", titulo: "Primeiro estande visitado",   categoria: "networking",  coluna_progresso: "aquecendo",  criterio_tipo: "first",        acao_referencia: "visita_estande",    valor_meta: 1,  icone_emoji: "🌐", icone_cor: "#10B981" },
  { codigo: "3C", titulo: "Conexões acumuladas",         categoria: "networking",  coluna_progresso: "acelerando", criterio_tipo: "count",        acao_referencia: "conexao_aceita",    valor_meta: 5,  icone_emoji: "💬", icone_cor: "#047857" },
  { codigo: "3D", titulo: "Cobertura de estandes",       categoria: "networking",  coluna_progresso: "voando",     criterio_tipo: "percent",      acao_referencia: "visita_estande",    valor_meta: 90, icone_emoji: "🌍", icone_cor: "#065F46" },
];

// ── Descrição automática ──────────────────────────────────────────────────────
export function gerarDescricao(criterio_tipo, acao_referencia, valor_meta) {
  const meta = Number(valor_meta);
  const acaoLabel = acao_referencia ? ACAO_EVENTO_LABELS[acao_referencia] : null;

  const verbos = {
    presenca_sessao:   "Registrar presença em pelo menos",
    avaliacao_sessao:  "Avaliar pelo menos",
    pergunta_valida:   "Enviar pelo menos",
    completude_perfil: "Completar pelo menos",
    conexao_aceita:    "Realizar pelo menos",
    visita_estande:    "Visitar pelo menos",
    resgate_realizado: "Resgatar pelo menos",
  };

  const sufixos = {
    presenca_sessao:   meta === 1 ? "sessão." : "sessões.",
    avaliacao_sessao:  meta === 1 ? "sessão." : "sessões.",
    pergunta_valida:   meta === 1 ? "pergunta válida." : "perguntas válidas.",
    completude_perfil: "% do perfil.",
    conexao_aceita:    meta === 1 ? "conexão aceita." : "conexões aceitas.",
    visita_estande:    meta === 1 ? "estande." : "estandes.",
    resgate_realizado: meta === 1 ? "item resgatado." : "itens resgatados.",
  };

  if (criterio_tipo === "points_total") {
    return `Acumular pelo menos ${meta} pontos.`;
  }

  if (criterio_tipo === "first" && acao_referencia) {
    const sufixo = sufixos[acao_referencia] || (acaoLabel ? `${acaoLabel.toLowerCase()}.` : ".");
    const verboFirst = {
      presenca_sessao:   "Registrar a primeira",
      avaliacao_sessao:  "Avaliar a primeira",
      pergunta_valida:   "Enviar a primeira",
      completude_perfil: "Completar o perfil pela primeira vez.",
      conexao_aceita:    "Realizar a primeira",
      visita_estande:    "Visitar o primeiro",
      resgate_realizado: "Realizar o primeiro",
    }[acao_referencia];
    if (acao_referencia === "completude_perfil") return verboFirst;
    return `${verboFirst || "Realizar a primeira"} ${sufixos[acao_referencia] || "."}`;
  }

  if (criterio_tipo === "percent" && acao_referencia) {
    if (acao_referencia === "completude_perfil") return `Completar pelo menos ${meta}% do perfil.`;
    if (acao_referencia === "visita_estande") return `Visitar pelo menos ${meta}% dos estandes.`;
    return `Atingir ${meta}% em ${acaoLabel ? acaoLabel.toLowerCase() : "ação"}.`;
  }

  if (criterio_tipo === "count" && acao_referencia) {
    const verbo = verbos[acao_referencia] || "Realizar pelo menos";
    const sufixo = sufixos[acao_referencia] || ".";
    return `${verbo} ${meta} ${sufixo}`;
  }

  return "";
}