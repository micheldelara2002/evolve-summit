import { useState } from "react";
import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { base44 } from "@/api/base44Client";
import { uploadFile } from "@/lib/apiClient";
import { sanitizeText } from "@/utils/sanitize";
import { Upload, X } from "lucide-react";

const STATUSES = ["draft", "active", "finished", "cancelled"];
const MAX_LOGO_SIZE = 2 * 1024 * 1024; // 2MB
const VALID_TYPES = ["image/png", "image/jpeg", "image/svg+xml", "image/webp"];

export default function EventForm({ event, onSubmit, isSubmitting }) {
  const [form, setForm] = useState({
    name: event?.name || "",
    description: event?.description || "",
    start_date: event?.start_date ? event.start_date.slice(0, 16) : "",
    end_date: event?.end_date ? event.end_date.slice(0, 16) : "",
    location: event?.location || "",
    status: event?.status || "draft",
    manager_id: event?.manager_id || "",
    manager_name: event?.manager_name || "",
    logo_url: event?.logo_url || "",
    color_primary: event?.color_primary || "#4F46E5",
    color_secondary: event?.color_secondary || "#0D9488",
    color_accent: event?.color_accent || "#F59E0B",
    max_participants: event?.max_participants || "",
  });
  const [uploading, setUploading] = useState(false);
  const [logoError, setLogoError] = useState("");

  const update = (field, value) => setForm((p) => ({ ...p, [field]: value }));

  const handleLogoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLogoError("");

    if (!VALID_TYPES.includes(file.type)) {
      setLogoError("Formato inválido. Use PNG, JPG, SVG ou WebP.");
      return;
    }
    if (file.size > MAX_LOGO_SIZE) {
      setLogoError("Arquivo muito grande. Máximo 2MB.");
      return;
    }

    setUploading(true);
    const { file_url } = await uploadFile(file);
    update("logo_url", file_url);
    setUploading(false);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const data = { ...form };
    if (data.max_participants) data.max_participants = Number(data.max_participants);
    else delete data.max_participants;
    // Sanitize free-text fields
    ["name", "description", "location", "manager_name"].forEach((k) => {
      if (typeof data[k] === "string") data[k] = sanitizeText(data[k]);
    });
    onSubmit(data);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="space-y-2">
        <Label>{t("events.name")} *</Label>
        <Input value={form.name} onChange={(e) => update("name", e.target.value)} required />
      </div>

      <div className="space-y-2">
        <Label>{t("events.description")}</Label>
        <Textarea value={form.description} onChange={(e) => update("description", e.target.value)} rows={3} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>{t("events.startDate")} *</Label>
          <Input type="datetime-local" value={form.start_date} onChange={(e) => update("start_date", e.target.value)} required />
        </div>
        <div className="space-y-2">
          <Label>{t("events.endDate")} *</Label>
          <Input type="datetime-local" value={form.end_date} onChange={(e) => update("end_date", e.target.value)} required />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>{t("events.location")}</Label>
          <Input value={form.location} onChange={(e) => update("location", e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>{t("events.status")}</Label>
          <Select value={form.status} onValueChange={(v) => update("status", v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>{t(`status.${s}`)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>{t("events.manager")}</Label>
          <Input value={form.manager_name} onChange={(e) => update("manager_name", e.target.value)} placeholder="Nome do gerente" />
        </div>
        <div className="space-y-2">
          <Label>{t("events.maxParticipants")}</Label>
          <Input type="number" value={form.max_participants} onChange={(e) => update("max_participants", e.target.value)} />
        </div>
      </div>

      {/* Logo */}
      <div className="space-y-2">
        <Label>{t("events.logo")}</Label>
        <div className="flex items-center gap-3">
          {form.logo_url ? (
            <div className="relative">
              <img src={form.logo_url} alt="Logo" className="w-16 h-16 rounded-lg object-cover border" />
              <button
                type="button"
                onClick={() => update("logo_url", "")}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-destructive text-white rounded-full flex items-center justify-center"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ) : (
            <label className="flex items-center gap-2 px-4 py-2 rounded-lg border border-dashed border-border cursor-pointer hover:bg-muted transition-colors">
              <Upload className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                {uploading ? t("common.loading") : "Upload"}
              </span>
              <input type="file" accept="image/*" onChange={handleLogoUpload} className="hidden" />
            </label>
          )}
        </div>
        {logoError && <p className="text-xs text-destructive">{logoError}</p>}
      </div>

      {/* Cores */}
      <div className="space-y-2">
        <Label>{t("events.colors")}</Label>
        <div className="grid grid-cols-3 gap-3">
          {[
            { key: "color_primary", label: t("events.primary") },
            { key: "color_secondary", label: t("events.secondary") },
            { key: "color_accent", label: t("events.accent") },
          ].map(({ key, label }) => (
            <div key={key} className="space-y-1">
              <p className="text-xs text-muted-foreground">{label}</p>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={form[key]}
                  onChange={(e) => update(key, e.target.value)}
                  className="w-8 h-8 rounded cursor-pointer border-0"
                />
                <Input
                  value={form[key]}
                  onChange={(e) => update(key, e.target.value)}
                  className="text-xs h-8 font-mono"
                  maxLength={7}
                />
              </div>
            </div>
          ))}
        </div>
        {/* Preview */}
        <div className="flex gap-2 mt-2">
          <div className="h-6 flex-1 rounded" style={{ backgroundColor: form.color_primary }} />
          <div className="h-6 flex-1 rounded" style={{ backgroundColor: form.color_secondary }} />
          <div className="h-6 flex-1 rounded" style={{ backgroundColor: form.color_accent }} />
        </div>
      </div>

      <div className="flex gap-3 pt-2">
        <Button type="submit" disabled={isSubmitting} className="flex-1">
          {isSubmitting ? t("common.loading") : t("common.save")}
        </Button>
      </div>
    </form>
  );
}