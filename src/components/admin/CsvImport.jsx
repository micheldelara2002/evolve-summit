import { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import { useQueryClient } from "@tanstack/react-query";
import { t } from "@/lib/i18n";
import { logAudit } from "@/lib/audit";
import { Button } from "@/components/ui/button";
import { Upload, FileText, CheckCircle, XCircle, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

function normalizeCpf(cpf) {
  if (!cpf) return "";
  return cpf.replace(/\D/g, "");
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
  const separator = lines[0].includes(";") ? ";" : ",";
  const headers = lines[0].split(separator).map((h) => h.trim().toLowerCase().replace(/['"]/g, ""));
  const rows = lines.slice(1).map((line) => {
    const values = line.split(separator).map((v) => v.trim().replace(/^["']|["']$/g, ""));
    const obj = {};
    headers.forEach((h, i) => { obj[h] = values[i] || ""; });
    return obj;
  });
  return { headers, rows };
}

export default function CsvImport({ eventId, existingParticipants = [], onComplete }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [step, setStep] = useState("upload"); // upload, preview, result
  const [parsed, setParsed] = useState(null);
  const [errors, setErrors] = useState([]);
  const [validRows, setValidRows] = useState([]);
  const [duplicates, setDuplicates] = useState([]);
  const [result, setResult] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [fileName, setFileName] = useState("");

  const handleFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target.result;
      const { headers, rows } = parseCsv(text);
      setParsed({ headers, rows });
      validateRows(rows);
      setStep("preview");
    };
    reader.readAsText(file, "UTF-8");
  };

  const validateRows = (rows) => {
    const errs = [];
    const valid = [];
    const dupes = [];
    const existingKeys = new Set();

    existingParticipants.forEach((p) => {
      const cpfKey = p.cpf ? `cpf:${normalizeCpf(p.cpf)}` : null;
      const emailKey = `email:${normalizeEmail(p.email)}`;
      if (cpfKey) existingKeys.add(cpfKey);
      existingKeys.add(emailKey);
    });

    const batchKeys = new Set();

    rows.forEach((row, idx) => {
      const lineNum = idx + 2;
      const name = (row.nome || row.full_name || row.name || "").trim();
      const email = normalizeEmail(row.email || row["e-mail"] || "");
      const cpf = normalizeCpf(row.cpf || "");

      if (!name) {
        errs.push({ line: lineNum, error: t("import.requiredFields"), data: row });
        return;
      }
      if (!email) {
        errs.push({ line: lineNum, error: t("import.requiredFields"), data: row });
        return;
      }
      if (!validateEmail(email)) {
        errs.push({ line: lineNum, error: t("import.invalidEmail"), data: row });
        return;
      }

      // Idempotency check
      const primaryKey = cpf ? `cpf:${cpf}` : `email:${email}`;
      if (existingKeys.has(primaryKey) || batchKeys.has(primaryKey)) {
        dupes.push({ line: lineNum, data: row, key: primaryKey });
        return;
      }
      batchKeys.add(primaryKey);

      valid.push({
        event_id: eventId,
        full_name: name,
        email,
        cpf,
        phone: (row.telefone || row.phone || "").trim(),
        company: (row.empresa || row.company || "").trim(),
        role_in_event: "attendee",
        registration_status: "registered",
        is_deleted: false,
      });
    });

    setErrors(errs);
    setValidRows(valid);
    setDuplicates(dupes);
  };

  const confirmImport = async () => {
    setProcessing(true);
    let successCount = 0;
    let errorCount = 0;

    // Create import record
    const importRecord = await base44.entities.Import.create({
      event_id: eventId,
      file_name: fileName,
      status: "processing",
      total_rows: parsed.rows.length,
    });

    // Bulk create in batches of 50
    for (let i = 0; i < validRows.length; i += 50) {
      const batch = validRows.slice(i, i + 50);
      try {
        await base44.entities.Participant.bulkCreate(
          batch.map((r) => ({ ...r, import_id: importRecord.id }))
        );
        successCount += batch.length;
      } catch {
        errorCount += batch.length;
      }
    }

    const finalResult = {
      total: parsed.rows.length,
      success: successCount,
      errors: errors.length + errorCount,
      duplicates: duplicates.length,
    };

    await base44.entities.Import.update(importRecord.id, {
      status: errorCount > 0 ? "completed" : "completed",
      success_count: successCount,
      error_count: errors.length + errorCount,
      duplicate_count: duplicates.length,
      errors_detail: JSON.stringify(errors.slice(0, 100)),
    });

    logAudit({
      event_id: eventId,
      action: "import",
      entity_type: "Participant",
      entity_id: importRecord.id,
      details: finalResult,
      user,
    });

    setResult(finalResult);
    setStep("result");
    setProcessing(false);
    queryClient.invalidateQueries({ queryKey: ["participants"] });
    toast.success(t("import.completed"));
  };

  if (step === "upload") {
    return (
      <div className="flex flex-col items-center gap-4 py-8">
        <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
          <Upload className="w-8 h-8 text-primary" />
        </div>
        <p className="text-sm text-muted-foreground text-center max-w-xs">
          {t("import.upload")} (CSV com colunas: nome/name, email, cpf, telefone, empresa)
        </p>
        <label className="cursor-pointer">
          <Button variant="outline" className="gap-2" asChild>
            <span><FileText className="w-4 h-4" /> Selecionar arquivo CSV</span>
          </Button>
          <input type="file" accept=".csv" onChange={handleFile} className="hidden" />
        </label>
      </div>
    );
  }

  if (step === "preview") {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-display font-semibold">{t("import.preview")}</h3>
          <Badge variant="secondary">{fileName}</Badge>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Card>
            <CardContent className="pt-4 text-center">
              <p className="text-2xl font-bold text-emerald-600">{validRows.length}</p>
              <p className="text-xs text-muted-foreground">{t("import.success")}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 text-center">
              <p className="text-2xl font-bold text-red-500">{errors.length}</p>
              <p className="text-xs text-muted-foreground">{t("import.errors")}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 text-center">
              <p className="text-2xl font-bold text-amber-500">{duplicates.length}</p>
              <p className="text-xs text-muted-foreground">{t("import.duplicates")}</p>
            </CardContent>
          </Card>
        </div>

        {/* Valid rows preview */}
        {validRows.length > 0 && (
          <div className="space-y-1">
            <p className="text-sm font-medium">{t("import.preview")} ({Math.min(validRows.length, 5)} de {validRows.length})</p>
            {validRows.slice(0, 5).map((r, i) => (
              <div key={i} className="bg-muted/40 rounded p-2 text-xs flex items-center gap-2">
                <CheckCircle className="w-3 h-3 text-emerald-500 shrink-0" />
                <span className="truncate">{r.full_name} · {r.email}</span>
              </div>
            ))}
          </div>
        )}

        {/* Error report */}
        {errors.length > 0 && (
          <div className="space-y-1">
            <p className="text-sm font-medium text-destructive">{t("import.errorReport")}</p>
            <div className="max-h-40 overflow-y-auto space-y-1">
              {errors.map((e, i) => (
                <div key={i} className="bg-red-50 dark:bg-red-900/20 rounded p-2 text-xs flex items-start gap-2">
                  <XCircle className="w-3 h-3 text-red-500 shrink-0 mt-0.5" />
                  <span>{t("import.line")} {e.line}: {e.error}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {duplicates.length > 0 && (
          <div className="space-y-1">
            <p className="text-sm font-medium text-amber-600">{t("import.duplicates")}</p>
            <div className="max-h-32 overflow-y-auto space-y-1">
              {duplicates.slice(0, 10).map((d, i) => (
                <div key={i} className="bg-amber-50 dark:bg-amber-900/20 rounded p-2 text-xs flex items-start gap-2">
                  <AlertTriangle className="w-3 h-3 text-amber-500 shrink-0 mt-0.5" />
                  <span>{t("import.line")} {d.line}: {t("import.duplicateEntry")}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex gap-3">
          <Button variant="outline" onClick={() => { setStep("upload"); setParsed(null); }} className="flex-1">
            {t("common.cancel")}
          </Button>
          <Button onClick={confirmImport} disabled={processing || validRows.length === 0} className="flex-1">
            {processing ? t("import.processing") : `${t("import.confirm")} (${validRows.length})`}
          </Button>
        </div>
      </div>
    );
  }

  // result
  return (
    <div className="space-y-4 text-center py-4">
      <CheckCircle className="w-12 h-12 text-emerald-500 mx-auto" />
      <h3 className="font-display font-semibold">{t("import.completed")}</h3>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <p className="text-xl font-bold">{result.total}</p>
          <p className="text-xs text-muted-foreground">{t("import.totalRows")}</p>
        </div>
        <div>
          <p className="text-xl font-bold text-emerald-600">{result.success}</p>
          <p className="text-xs text-muted-foreground">{t("import.success")}</p>
        </div>
        <div>
          <p className="text-xl font-bold text-red-500">{result.errors}</p>
          <p className="text-xs text-muted-foreground">{t("import.errors")}</p>
        </div>
      </div>
      <Button onClick={() => { setStep("upload"); setParsed(null); setResult(null); onComplete?.(); }}>
        {t("common.back")}
      </Button>
    </div>
  );
}