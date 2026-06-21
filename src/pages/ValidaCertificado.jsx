/**
 * Página pública de validação de certificados.
 * Rota: /valida-certificado
 * Simples CAPTCHA matemático para evitar abuso.
 */
import { useState } from "react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Award, CheckCircle2, XCircle, RefreshCw } from "lucide-react";

function genCaptcha() {
  const a = Math.floor(Math.random() * 9) + 1;
  const b = Math.floor(Math.random() * 9) + 1;
  return { a, b, answer: a + b };
}

function formatDate(dt) {
  if (!dt) return "—";
  return new Date(dt).toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });
}

export default function ValidaCertificado() {
  const [hashInput, setHashInput] = useState("");
  const [captcha, setCaptcha] = useState(genCaptcha());
  const [captchaInput, setCaptchaInput] = useState("");
  const [result, setResult] = useState(null); // null | "valid" | "invalid"
  const [certData, setCertData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const refreshCaptcha = () => {
    setCaptcha(genCaptcha());
    setCaptchaInput("");
  };

  const handleValidate = async (e) => {
    e.preventDefault();
    setError("");

    if (!hashInput.trim()) { setError("Informe o código do certificado."); return; }
    if (parseInt(captchaInput) !== captcha.answer) {
      setError("Resposta do CAPTCHA incorreta.");
      refreshCaptcha();
      return;
    }

    setLoading(true);
    try {
      const certs = await base44.entities.Certificate.filter({ hash_code: hashInput.trim().toUpperCase(), is_deleted: false });
      if (!certs || certs.length === 0) {
        setResult("invalid");
        setCertData(null);
      } else {
        const cert = certs[0];
        // Buscar dados do evento
        let eventName = "—";
        try {
          const evts = await base44.entities.Event.filter({ id: cert.event_id });
          eventName = evts[0]?.name || "—";
        } catch {}

        // Buscar nome da person
        let personName = "—";
        try {
          if (cert.person_id) {
            const persons = await base44.entities.Person.filter({ id: cert.person_id });
            personName = persons[0]?.full_name || "—";
          }
        } catch {}

        setResult("valid");
        setCertData({ cert, eventName, personName });
      }
    } catch {
      setError("Erro ao consultar. Tente novamente.");
    } finally {
      setLoading(false);
      refreshCaptcha();
    }
  };

  const reset = () => {
    setHashInput("");
    setResult(null);
    setCertData(null);
    setError("");
    refreshCaptcha();
  };

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-md space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto">
            <Award className="w-7 h-7 text-primary" />
          </div>
          <h1 className="text-2xl font-display font-bold">Validar Certificado</h1>
          <p className="text-sm text-muted-foreground">Informe o código impresso no rodapé do certificado para verificar sua autenticidade.</p>
        </div>

        {/* Form */}
        {result === null && (
          <form onSubmit={handleValidate} className="rounded-2xl border border-border bg-card p-6 space-y-4">
            <div className="space-y-1.5">
              <Label>Código do Certificado</Label>
              <Input
                value={hashInput}
                onChange={(e) => setHashInput(e.target.value.toUpperCase())}
                placeholder="Ex: ABC12345-DEF67890"
                className="font-mono"
              />
            </div>

            {/* CAPTCHA */}
            <div className="space-y-1.5">
              <Label>CAPTCHA: Quanto é {captcha.a} + {captcha.b}?</Label>
              <div className="flex gap-2">
                <Input
                  type="number"
                  value={captchaInput}
                  onChange={(e) => setCaptchaInput(e.target.value)}
                  placeholder="Resultado"
                  className="flex-1"
                />
                <Button type="button" variant="ghost" size="icon" onClick={refreshCaptcha} title="Novo CAPTCHA">
                  <RefreshCw className="w-4 h-4" />
                </Button>
              </div>
            </div>

            {error && (
              <p className="text-sm text-destructive flex items-center gap-1">
                <XCircle className="w-4 h-4 shrink-0" /> {error}
              </p>
            )}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Verificando..." : "Verificar"}
            </Button>
          </form>
        )}

        {/* Resultado válido */}
        {result === "valid" && certData && (
          <div className="rounded-2xl border border-emerald-300 bg-emerald-50 p-6 space-y-4">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="w-8 h-8 text-emerald-600 shrink-0" />
              <div>
                <p className="font-display font-bold text-emerald-800 text-lg">Certificado Válido</p>
                <p className="text-xs text-emerald-600">Documento autêntico verificado</p>
              </div>
            </div>
            <div className="space-y-2 text-sm text-emerald-900 border-t border-emerald-200 pt-4">
              <div className="flex justify-between">
                <span className="text-emerald-700">Titular:</span>
                <span className="font-semibold">{certData.personName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-emerald-700">Evento:</span>
                <span className="font-semibold">{certData.eventName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-emerald-700">Tipo:</span>
                <span className="font-semibold capitalize">{certData.cert.tipo === "palestra" ? "Palestra" : "Participação"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-emerald-700">Emitido em:</span>
                <span className="font-semibold">{formatDate(certData.cert.created_date)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-emerald-700">Código:</span>
                <span className="font-mono text-xs">{certData.cert.hash_code}</span>
              </div>
            </div>
            <Button variant="outline" onClick={reset} className="w-full">Verificar outro</Button>
          </div>
        )}

        {/* Resultado inválido */}
        {result === "invalid" && (
          <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-6 space-y-4">
            <div className="flex items-center gap-3">
              <XCircle className="w-8 h-8 text-destructive shrink-0" />
              <div>
                <p className="font-display font-bold text-destructive text-lg">Certificado Inválido</p>
                <p className="text-xs text-destructive/70">Nenhum certificado encontrado com este código.</p>
              </div>
            </div>
            <Button variant="outline" onClick={reset} className="w-full">Tentar novamente</Button>
          </div>
        )}
      </div>
    </div>
  );
}