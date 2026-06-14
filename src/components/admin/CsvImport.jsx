import { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import { useQueryClient } from "@tanstack/react-query";
import { t } from "@/lib/i18n";
import { logAudit } from "@/lib/audit";
import { Button } from "@/components/ui/button";
import { Upload, FileText, CheckCircle, XCircle, AlertTriangle, Info } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

function normalizeCpf(cpf) {
  return (cpf || "").replace(/\D/g, "");
}
function normalizeEmail(email) {
  return (email || "").trim().toLowerCase();
}
function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };
  // Only comma separator per spec
  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/['"]/g, ""));
  const rows = lines.slice(1).map((line) => {
    const values = line.split(",").map((v) => v.trim().replace(/^["']|["']$/g, ""));
    const obj = {};
    headers.forEach((h, i) => { obj[h] = values[i] || ""; });
    return obj;
  });
  return { headers, rows };
}

const REQUIRED_HEADERS = ["nome", "email", "cpf", "telefone"];

// Categorias possíveis por linha
const CAT = {
  NEW: "new",
  EXISTING_UNLINKED: "existing_unlinked",
  ALREADY_LINKED: "already_linked",
  INVALID: "invalid",
};

export default function CsvImport({ eventId, existingParticipants = [], onComplete }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [step, setStep] = useState("upload"); // upload | dryrun | result
  const [fileName, setFileName] = useState("");
  const [parsed, setParsed] = useState(null);

  // Dry run categories
  const [newRows, setNewRows] = useState([]);
  const [existingUnlinked, setExistingUnlinked] = useState([]); // { row, globalParticipant }
  const [alreadyLinked, setAlreadyLinked] = useState([]);
  const [invalidRows, setInvalidRows] = useState([]); // { line, field, reason, data }

  // Decision for existing_unlinked
  const [existingDecision, setExistingDecision] = useState("link_all"); // link_all | ignore_all

  const [processing, setProcessing] = useState(false);
  const [result, setResult] = useState(null);

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const text = ev.target.result;
      const { headers, rows } = parseCsv(text);
      setParsed({ headers, rows });

      // Validate headers
      const missingHeaders = REQUIRED_HEADERS.filter((h) => !headers.includes(h));
      if (missingHeaders.length > 0) {
        toast.error(`CSV sem cabeçalhos obrigatórios: ${missingHeaders.join(", ")}`);
        return;
      }

      // Fetch ALL participants globally (by CPF) to detect EXISTING_UNLINKED
      let globalParticipants = [];
      try {
        globalParticipants = await base44.entities.Participant.filter({ is_deleted: false });
      } catch {}

      // Build lookup maps
      const eventCpfSet = new Set(existingParticipants.map((p) => normalizeCpf(p.cpf)).filter(Boolean));
      const eventEmailSet = new Set(existingParticipants.map((p) => normalizeEmail(p.email)).filter(Boolean));
      const globalByCpf = new Map(globalParticipants.map((p) => [normalizeCpf(p.cpf), p]).filter(([k]) => k));
      const globalByEmail = new Map(globalParticipants.map((p) => [normalizeEmail(p.email), p]).filter(([k]) => k));

      const batchCpfSet = new Set();
      const batchEmailSet = new Set();

      const _new = [], _unlinked = [], _linked = [], _invalid = [];

      rows.forEach((row, idx) => {
        const lineNum = idx + 2;
        const name = (row.nome || "").trim();
        const email = normalizeEmail(row.email || "");
        const cpf = normalizeCpf(row.cpf || "");
        const phone = (row.telefone || "").trim();

        // Validate required
        if (!name) { _invalid.push({ line: lineNum, field: "nome", reason: "Campo obrigatório", data: row }); return; }
        if (!email) { _invalid.push({ line: lineNum, field: "email", reason: "Campo obrigatório", data: row }); return; }
        if (!validateEmail(email)) { _invalid.push({ line: lineNum, field: "email", reason: "E-mail inválido", data: row }); return; }
        if (!cpf) { _invalid.push({ line: lineNum, field: "cpf", reason: "Campo obrigatório", data: row }); return; }
        if (!phone) { _invalid.push({ line: lineNum, field: "telefone", reason: "Campo obrigatório", data: row }); return; }

        // Check already linked (idempotent) - check by cpf first, then email
        const linkedByCpf = cpf && eventCpfSet.has(cpf);
        const linkedByEmail = eventEmailSet.has(email);
        if (linkedByCpf || linkedByEmail) {
          _linked.push({ line: lineNum, data: row });
          return;
        }

        // Batch duplicate within this CSV
        if ((cpf && batchCpfSet.has(cpf)) || batchEmailSet.has(email)) {
          _invalid.push({ line: lineNum, field: "cpf/email", reason: "Duplicado no arquivo CSV", data: row });
          return;
        }
        if (cpf) batchCpfSet.add(cpf);
        batchEmailSet.add(email);

        // Check existing in global base but not linked to this event
        const globalP = (cpf && globalByCpf.get(cpf)) || globalByEmail.get(email);
        if (globalP) {
          _unlinked.push({
            line: lineNum,
            data: row,
            globalParticipant: globalP,
          });
          return;
        }

        // Truly new
        _new.push({
          line: lineNum,
          payload: {
            event_id: eventId,
            full_name: name,
            email,
            cpf,
            phone,
            company: (row.empresa || "").trim(),
            job_title: (row.cargo || "").trim(),
            linkedin: (row.linkedin || "").trim(),
            instagram: (row.instagram || "").trim(),
            youtube: (row.youtube || "").trim(),
            website: (row.site || "").trim(),
            bio: (row.sobre_mim || "").trim(),
            role_in_event: "attendee",
            registration_status: "registered",
            is_deleted: false,
          },
        });
      });

      setNewRows(_new);
      setExistingUnlinked(_unlinked);
      setAlreadyLinked(_linked);
      setInvalidRows(_invalid);
      setExistingDecision("link_all");
      setStep("dryrun");
    };
    reader.readAsText(file, "UTF-8");
  };

  const confirmImport = async () => {
    setProcessing(true);

    const importRecord = await base44.entities.Import.create({
      event_id: eventId,
      file_name: fileName,
      status: "processing",
      total_rows: parsed.rows.length,
    });

    let novosCriados = 0;
    let existentesVinculados = 0;
    let jaVinculadosIgnorados = alreadyLinked.length;
    let errosCriacao = 0;

    // Create NEW in batches of 50
    const newPayloads = newRows.map((r) => ({ ...r.payload, import_id: importRecord.id }));
    for (let i = 0; i < newPayloads.length; i += 50) {
      const batch = newPayloads.slice(i, i + 50);
      try {
        await base44.entities.Participant.bulkCreate(batch);
        novosCriados += batch.length;
      } catch {
        errosCriacao += batch.length;
      }
    }

    // Link EXISTING if decision is link_all
    if (existingDecision === "link_all") {
      for (const item of existingUnlinked) {
        const gp = item.globalParticipant;
        // Create a new event-linked record reusing data, or just update event_id if needed
        // Since participant is per-event, create a new record with same person data + this event
        try {
          await base44.entities.Participant.create({
            event_id: eventId,
            full_name: gp.full_name,
            email: gp.email,
            cpf: gp.cpf,
            phone: gp.phone,
            company: gp.company || "",
            job_title: gp.job_title || "",
            linkedin: gp.linkedin || "",
            instagram: gp.instagram || "",
            youtube: gp.youtube || "",
            website: gp.website || "",
            bio: gp.bio || "",
            role_in_event: "attendee",
            registration_status: "registered",
            is_deleted: false,
            import_id: importRecord.id,
          });
          existentesVinculados++;
        } catch {
          errosCriacao++;
        }
      }
    }

    await base44.entities.Import.update(importRecord.id, {
      status: "completed",
      success_count: novosCriados + existentesVinculados,
      error_count: invalidRows.length + errosCriacao,
      duplicate_count: jaVinculadosIgnorados,
      errors_detail: JSON.stringify(invalidRows.slice(0, 100)),
    });

    logAudit({
      event_id: eventId,
      action: "import",
      entity_type: "Participant",
      entity_id: importRecord.id,
      details: { novosCriados, existentesVinculados, jaVinculadosIgnorados, invalidos: invalidRows.length },
      user,
    });

    setResult({
      total_linhas: parsed.rows.length,
      novos_criados: novosCriados,
      existentes_vinculados: existentesVinculados,
      ja_vinculados_ignorados: jaVinculadosIgnorados,
      invalidos: invalidRows.length,
      erros_por_linha: invalidRows,
    });

    setStep("result");
    setProcessing(false);
    queryClient.invalidateQueries({ queryKey: ["participants", eventId] });
    toast.success(t("import.completed"));
  };

  // ── STEP: upload ──────────────────────────────────────────────────────────
  if (step === "upload") {
    return (
      <div className="flex flex-col items-center gap-4 py-8">
        <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
          <Upload className="w-8 h-8 text-primary" />
        </div>
        <div className="text-center space-y-1">
          <p className="text-sm font-medium">Importar participantes via CSV</p>
          <p className="text-xs text-muted-foreground max-w-xs">
            Cabeçalhos obrigatórios: <code className="font-mono">nome, email, cpf, telefone</code>
          </p>
          <p className="text-xs text-muted-foreground">Opcionais: empresa, cargo, linkedin, instagram, youtube, site, sobre_mim</p>
        </div>
        <label className="cursor-pointer">
          <Button variant="outline" className="gap-2" asChild>
            <span><FileText className="w-4 h-4" /> Selecionar arquivo CSV</span>
          </Button>
          <input type="file" accept=".csv" onChange={handleFile} className="hidden" />
        </label>
        <Button variant="ghost" size="sm" onClick={onComplete}>Cancelar</Button>
      </div>
    );
  }

  // ── STEP: dryrun ──────────────────────────────────────────────────────────
  if (step === "dryrun") {
    const total = parsed.rows.length;
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-display font-semibold">Pré-visualização da importação</h3>
          <Badge variant="secondary" className="text-xs truncate max-w-[150px]">{fileName}</Badge>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <SummaryCard count={newRows.length} label="Novos" color="emerald" />
          <SummaryCard count={existingUnlinked.length} label="Existentes não vinculados" color="sky" />
          <SummaryCard count={alreadyLinked.length} label="Já vinculados (ignorar)" color="amber" />
          <SummaryCard count={invalidRows.length} label="Inválidos" color="red" />
        </div>

        {/* Decision for existing unlinked */}
        {existingUnlinked.length > 0 && (
          <div className="rounded-xl border border-sky-200 bg-sky-50 p-4 space-y-3">
            <div className="flex items-start gap-2">
              <Info className="w-4 h-4 text-sky-600 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-sky-800">
                  {existingUnlinked.length} pessoa(s) já existem na base mas não estão neste evento.
                </p>
                <p className="text-xs text-sky-600">Como deseja proceder?</p>
              </div>
            </div>
            <div className="flex gap-2 flex-wrap">
              <Button
                size="sm"
                variant={existingDecision === "link_all" ? "default" : "outline"}
                className="text-xs"
                onClick={() => setExistingDecision("link_all")}
              >
                Vincular todos automaticamente (recomendado)
              </Button>
              <Button
                size="sm"
                variant={existingDecision === "ignore_all" ? "default" : "outline"}
                className="text-xs"
                onClick={() => setExistingDecision("ignore_all")}
              >
                Ignorar todos
              </Button>
            </div>
            {existingDecision === "link_all" && (
              <div className="max-h-28 overflow-y-auto space-y-1">
                {existingUnlinked.slice(0, 5).map((item, i) => (
                  <div key={i} className="text-xs bg-white/60 rounded px-2 py-1 flex gap-2">
                    <CheckCircle className="w-3 h-3 text-sky-500 shrink-0 mt-0.5" />
                    <span>{item.globalParticipant.full_name} · {item.globalParticipant.email}</span>
                  </div>
                ))}
                {existingUnlinked.length > 5 && (
                  <p className="text-xs text-sky-500 pl-2">…e mais {existingUnlinked.length - 5}</p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Invalid rows */}
        {invalidRows.length > 0 && (
          <div className="space-y-1">
            <p className="text-sm font-medium text-destructive">Linhas inválidas (não serão importadas)</p>
            <div className="max-h-36 overflow-y-auto space-y-1">
              {invalidRows.map((e, i) => (
                <div key={i} className="bg-red-50 dark:bg-red-900/20 rounded p-2 text-xs flex items-start gap-2">
                  <XCircle className="w-3 h-3 text-red-500 shrink-0 mt-0.5" />
                  <span>Linha {e.line} · campo <strong>{e.field}</strong>: {e.reason}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Already linked */}
        {alreadyLinked.length > 0 && (
          <div className="bg-amber-50 rounded-lg p-3 text-xs text-amber-700 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {alreadyLinked.length} linha(s) já vinculadas a este evento serão ignoradas automaticamente.
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <Button variant="outline" className="flex-1" onClick={() => setStep("upload")}>
            Voltar
          </Button>
          <Button
            className="flex-1"
            disabled={processing || (newRows.length === 0 && existingUnlinked.length === 0)}
            onClick={confirmImport}
          >
            {processing ? "Importando…" : `Confirmar (${newRows.length + (existingDecision === "link_all" ? existingUnlinked.length : 0)} registros)`}
          </Button>
        </div>
      </div>
    );
  }

  // ── STEP: result ──────────────────────────────────────────────────────────
  return (
    <div className="space-y-4 py-4">
      <div className="text-center">
        <CheckCircle className="w-12 h-12 text-emerald-500 mx-auto mb-2" />
        <h3 className="font-display font-semibold">Importação concluída</h3>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <ResultStat label="Total de linhas" value={result.total_linhas} />
        <ResultStat label="Novos criados" value={result.novos_criados} color="text-emerald-600" />
        <ResultStat label="Vinculados" value={result.existentes_vinculados} color="text-sky-600" />
        <ResultStat label="Já vinculados (ignorados)" value={result.ja_vinculados_ignorados} color="text-amber-600" />
        <ResultStat label="Inválidos" value={result.invalidos} color="text-red-500" />
      </div>

      {result.erros_por_linha.length > 0 && (
        <div className="space-y-1">
          <p className="text-sm font-medium text-destructive">Erros por linha</p>
          <div className="max-h-40 overflow-y-auto space-y-1 rounded-lg border border-red-200 p-2">
            {result.erros_por_linha.map((e, i) => (
              <div key={i} className="text-xs flex items-start gap-2">
                <XCircle className="w-3 h-3 text-red-500 shrink-0 mt-0.5" />
                <span>Linha {e.line} · <strong>{e.field}</strong>: {e.reason}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <Button className="w-full" onClick={() => { setStep("upload"); setParsed(null); setResult(null); onComplete?.(); }}>
        Concluir
      </Button>
    </div>
  );
}

function SummaryCard({ count, label, color }) {
  const colorMap = {
    emerald: "text-emerald-600",
    sky: "text-sky-600",
    amber: "text-amber-500",
    red: "text-red-500",
  };
  return (
    <Card>
      <CardContent className="pt-4 text-center pb-4">
        <p className={`text-2xl font-bold ${colorMap[color] || ""}`}>{count}</p>
        <p className="text-xs text-muted-foreground leading-tight mt-0.5">{label}</p>
      </CardContent>
    </Card>
  );
}

function ResultStat({ label, value, color = "" }) {
  return (
    <div className="text-center p-3 rounded-xl border border-border bg-card">
      <p className={`text-xl font-bold ${color}`}>{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}