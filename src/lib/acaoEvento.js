// Enum único compartilhado entre ScoringRule.acao e Badge.acao_referencia
export const ACAO_EVENTO_LABELS = {
  presenca_sessao:  "Presença em Sessão",
  avaliacao_sessao: "Avaliação de Sessão",
  pergunta_valida:  "Pergunta Válida",
  completude_perfil:"Completude de Perfil",
  conexao_aceita:   "Conexão Aceita",
  visita_estande:   "Visita a Estande",
  resgate_realizado:"Resgate Realizado",
};

export const ACAO_EVENTO_KEYS = Object.keys(ACAO_EVENTO_LABELS);