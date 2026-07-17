/**
 * Dialog de criação/edição de enquete (poll).
 * Campos: pergunta, tipo de resposta, opções (2-4), duração.
 */
import { useState, useEffect } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, Trash2 } from "lucide-react";
import { sanitizeText } from "@/utils/sanitize";

const ANSWER_TYPES = [
  { value: "yes_no", label: "Sim / Não" },
  { value: "single_choice", label: "Simples escolha" },
  { value: "multiple_choice", label: "Múltipla escolha" },
];

export default function PollFormDialog({ open, onClose, onSubmit, editing }) {
  const [question, setQuestion] = useState("");
  const [answerType, setAnswerType] = useState("single_choice");
  const [options, setOptions] = useState(["", ""]);
  const [maxOptions, setMaxOptions] = useState(1);
  const [duration, setDuration] = useState(15);

  useEffect(() => {
    if (open) {
      if (editing) {
        setQuestion(editing.question || "");
        setAnswerType(editing.answer_type || "single_choice");
        setOptions((editing.options || []).map((o) => o.option_text));
        setMaxOptions(editing.max_options || 1);
        setDuration(editing.duration_seconds || 15);
      } else {
        setQuestion("");
        setAnswerType("single_choice");
        setOptions(["", ""]);
        setMaxOptions(1);
        setDuration(15);
      }
    }
  }, [open, editing]);

  // yes_no auto-gerencia opções
  const isYesNo = answerType === "yes_no";
  const effectiveOptions = isYesNo ? ["Sim", "Não"] : options;
  const validOptions = effectiveOptions.filter((o) => o.trim());

  const canSubmit =
    question.trim() &&
    validOptions.length >= 2 &&
    validOptions.length <= 4 &&
    (!isYesNo ? options.every((o) => o.trim() || o === options[options.length - 1]) : true);

  const addOption = () => {
    if (options.length < 4) setOptions([...options, ""]);
  };
  const removeOption = (idx) => {
    if (options.length > 2) setOptions(options.filter((_, i) => i !== idx));
  };
  const updateOption = (idx, val) => {
    setOptions(options.map((o, i) => (i === idx ? val : o)));
  };

  const handleSubmit = () => {
    const cleanOptions = isYesNo
      ? ["Sim", "Não"]
      : options.map((o) => sanitizeText(o.trim())).filter(Boolean);
    if (cleanOptions.length < 2) return;
    onSubmit({
      question: sanitizeText(question.trim()),
      answer_type: answerType,
      options: cleanOptions,
      max_options: answerType === "multiple_choice" ? Math.min(maxOptions, cleanOptions.length) : 1,
      duration_seconds: duration,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? "Editar Enquete" : "Nova Enquete"}</DialogTitle>
          <DialogDescription>
            {editing ? "Altere os campos da enquete." : "Crie uma enquete para sua palestra."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Pergunta */}
          <div className="space-y-1.5">
            <Label>Pergunta *</Label>
            <Input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Ex: Qual tema você quer aprofundar?"
              maxLength={200}
            />
          </div>

          {/* Tipo de resposta */}
          <div className="space-y-1.5">
            <Label>Tipo de resposta *</Label>
            <div className="grid grid-cols-3 gap-2">
              {ANSWER_TYPES.map((t) => (
                <button
                  key={t.value}
                  onClick={() => setAnswerType(t.value)}
                  className={`text-xs px-2 py-2 rounded-lg border text-center transition-colors ${
                    answerType === t.value
                      ? "border-primary bg-primary/10 text-primary font-medium"
                      : "border-border text-muted-foreground hover:bg-muted/40"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Opções */}
          {!isYesNo && (
            <div className="space-y-1.5">
              <Label>Opções de resposta * (mín. 2, máx. 4)</Label>
              <div className="space-y-2">
                {options.map((opt, idx) => (
                  <div key={idx} className="flex gap-2">
                    <Input
                      value={opt}
                      onChange={(e) => updateOption(idx, e.target.value)}
                      placeholder={`Opção ${idx + 1}`}
                      maxLength={80}
                    />
                    {options.length > 2 && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => removeOption(idx)}
                        className="shrink-0 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                ))}
                {options.length < 4 && (
                  <Button variant="outline" size="sm" onClick={addOption} className="gap-1 w-full">
                    <Plus className="w-3.5 h-3.5" /> Adicionar opção
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* Máximo de seleções (múltipla) */}
          {answerType === "multiple_choice" && (
            <div className="space-y-1.5">
              <Label>Máximo de opções selecionáveis</Label>
              <Input
                type="number"
                min={1}
                max={Math.max(validOptions.length, 1)}
                value={maxOptions}
                onChange={(e) => setMaxOptions(Math.max(1, Number(e.target.value)))}
              />
            </div>
          )}

          {/* Duração */}
          <div className="space-y-1.5">
            <Label>Tempo de votação (segundos) *</Label>
            <Input
              type="number"
              min={5}
              max={300}
              value={duration}
              onChange={(e) => setDuration(Math.max(5, Number(e.target.value)))}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button
            disabled={!canSubmit}
            onClick={handleSubmit}
          >
            {editing ? "Salvar" : "Criar rascunho"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}