/**
 * Editor visual de template de certificado personalizado.
 * - Upload da imagem de fundo
 * - Posicionamento de campos por arrastar-e-soltar
 * - Configuração de fonte, cor, tamanho por campo
 * - Preview em tempo real
 */
import { useState, useRef, useEffect } from "react";
import { uploadFile } from "@/lib/apiClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Upload, Save, Image as ImageIcon, Move, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  FIELD_DEFINITIONS,
  DEFAULT_FIELD_CONFIG,
  buildFieldValues,
} from "./CustomCertificatePreview";
import { sanitizeText } from "@/utils/sanitize";

const FONT_FAMILIES = [
  { value: "Arial, sans-serif", label: "Arial" },
  { value: "Georgia, serif", label: "Georgia" },
  { value: "'Times New Roman', serif", label: "Times New Roman" },
  { value: "'Inter', sans-serif", label: "Inter" },
  { value: "'Courier New', monospace", label: "Courier New" },
  { value: "'Space Grotesk', sans-serif", label: "Space Grotesk" },
];

const CANVAS_W = 794;
const CANVAS_H = 562;
const PREVIEW_SCALE = 0.55;
const PREVIEW_W = CANVAS_W * PREVIEW_SCALE;
const PREVIEW_H = CANVAS_H * PREVIEW_SCALE;

export default function TemplateEditor({ open, onClose, onSave, eventId, event, editingTemplate }) {
  const [name, setName] = useState(editingTemplate?.name || "");
  const [tipo, setTipo] = useState(editingTemplate?.tipo || "participacao");
  const [backgroundUrl, setBackgroundUrl] = useState(editingTemplate?.background_url || "");
  const [fieldConfigs, setFieldConfigs] = useState(() => {
    if (editingTemplate?.field_configs) {
      try { return JSON.parse(editingTemplate.field_configs); } catch { return {}; }
    }
    return {};
  });
  const [uploading, setUploading] = useState(false);
  const [draggingField, setDraggingField] = useState(null);
  const [selectedField, setSelectedField] = useState(null);
  const [saving, setSaving] = useState(false);
  const previewRef = useRef(null);

  // Reset state when opening with a different template
  useEffect(() => {
    if (open) {
      setName(editingTemplate?.name || "");
      setTipo(editingTemplate?.tipo || "participacao");
      setBackgroundUrl(editingTemplate?.background_url || "");
      try {
        setFieldConfigs(editingTemplate?.field_configs ? JSON.parse(editingTemplate.field_configs) : {});
      } catch {
        setFieldConfigs({});
      }
    }
  }, [open, editingTemplate]);

  // Dragging logic
  useEffect(() => {
    if (!draggingField) return;
    const handleMove = (e) => {
      if (!previewRef.current) return;
      const rect = previewRef.current.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      setFieldConfigs(prev => ({
        ...prev,
        [draggingField]: {
          ...(prev[draggingField] || DEFAULT_FIELD_CONFIG),
          x: Math.max(0, Math.min(100, Math.round(x * 10) / 10)),
          y: Math.max(0, Math.min(100, Math.round(y * 10) / 10)),
        }
      }));
    };
    const handleUp = () => setDraggingField(null);
    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
    return () => {
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
    };
  }, [draggingField]);

  const handleUpload = async (file) => {
    if (!file) return;
    setUploading(true);
    try {
      const { file_url } = await uploadFile(file);
      setBackgroundUrl(file_url);
      toast.success("Imagem carregada!");
    } catch {
      toast.error("Erro ao carregar imagem.");
    } finally {
      setUploading(false);
    }
  };

  const getConfig = (key) => fieldConfigs[key] || DEFAULT_FIELD_CONFIG;

  const updateConfig = (key, patch) => {
    setFieldConfigs(prev => ({
      ...prev,
      [key]: { ...(prev[key] || DEFAULT_FIELD_CONFIG), ...patch },
    }));
  };

  const handleSave = async () => {
    if (!name.trim()) { toast.error("Dê um nome ao template."); return; }
    if (!backgroundUrl) { toast.error("Carregue uma imagem de fundo."); return; }
    setSaving(true);
    try {
      const sanitizedConfigs = Object.fromEntries(
        Object.entries(fieldConfigs).map(([key, cfg]) => [
          key,
          cfg.custom_text != null
            ? { ...cfg, custom_text: sanitizeText(cfg.custom_text) }
            : cfg,
        ])
      );
      await onSave({
        name: name.trim(),
        tipo,
        background_url: backgroundUrl,
        field_configs: JSON.stringify(sanitizedConfigs),
      });
      onClose();
    } catch {
      toast.error("Erro ao salvar template.");
    } finally {
      setSaving(false);
    }
  };

  // Sample values for preview
  const sampleValues = buildFieldValues({
    event,
    person: { full_name: "João da Silva" },
    session: { title: "Inovação Digital", start_time: event?.start_date },
    tipo,
    hashCode: "AB12-CD34",
    issuedByName: "Maria Santos",
  });

  const visibleFields = FIELD_DEFINITIONS.filter(f => f.key !== "session_title" || tipo === "palestra");

  const customFields = Object.entries(fieldConfigs)
    .filter(([key]) => key.startsWith("custom_text_"))
    .map(([key, cfg]) => ({ key, ...cfg }));

  const addCustomField = () => {
    const newKey = `custom_text_${Date.now()}`;
    updateConfig(newKey, { enabled: true, custom_text: "", x: 50, y: 50, font_size: 16, font_color: "#000000", font_family: "Arial, sans-serif", text_align: "center" });
    setSelectedField(newKey);
  };

  const removeCustomField = (key) => {
    setFieldConfigs(prev => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    if (selectedField === key) setSelectedField(null);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-6xl w-full max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display">
            {editingTemplate ? "Editar Template" : "Novo Template de Certificado"}
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
          {/* ── Preview canvas ── */}
          <div className="space-y-3">
            {/* Upload + nome */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Nome do template</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex: Certificado Padrão 2025" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Tipo</Label>
                <Select value={tipo} onValueChange={setTipo} disabled={!!editingTemplate}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="participacao">Participação</SelectItem>
                    <SelectItem value="palestra">Palestra</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Canvas preview */}
            <div
              ref={previewRef}
              className="relative border border-border rounded-lg overflow-hidden bg-muted select-none"
              style={{ width: PREVIEW_W, height: PREVIEW_H, cursor: draggingField ? "grabbing" : "default" }}
            >
              {backgroundUrl ? (
                <img src={backgroundUrl} alt="" className="absolute inset-0 w-full h-full object-cover pointer-events-none" />
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground gap-2">
                  <ImageIcon className="w-8 h-8" />
                  <span className="text-xs">Carregue uma imagem de fundo</span>
                </div>
              )}

              {/* Draggable field markers */}
              {visibleFields.map(({ key, label, sample }) => {
                const cfg = getConfig(key);
                if (!cfg.enabled) return null;
                const transform = cfg.text_align === "center"
                  ? "translate(-50%, -50%)"
                  : cfg.text_align === "right"
                  ? "translate(-100%, -50%)"
                  : "translate(0, -50%)";
                const isActive = draggingField === key;
                const isSelected = selectedField === key;
                return (
                  <div
                    key={key}
                    onMouseDown={(e) => { e.preventDefault(); setDraggingField(key); setSelectedField(key); }}
                    onClick={() => setSelectedField(key)}
                    style={{
                      position: "absolute",
                      left: `${cfg.x}%`,
                      top: `${cfg.y}%`,
                      transform,
                      fontSize: `${cfg.font_size * PREVIEW_SCALE}px`,
                      color: cfg.font_color,
                      fontFamily: cfg.font_family,
                      textAlign: cfg.text_align,
                      cursor: "grab",
                      whiteSpace: "pre-wrap",
                      zIndex: 10,
                      outline: isSelected ? "2px solid hsl(var(--primary))" : "none",
                      outlineOffset: "2px",
                    }}
                  >
                    {sampleValues[key] || sample}
                  </div>
                );
              })}

              {/* Custom free-text fields */}
              {customFields.map(({ key, custom_text, ...rest }) => {
                const cfg = { ...(fieldConfigs[key] || DEFAULT_FIELD_CONFIG) };
                if (!cfg.enabled) return null;
                const transform = cfg.text_align === "center"
                  ? "translate(-50%, -50%)"
                  : cfg.text_align === "right"
                  ? "translate(-100%, -50%)"
                  : "translate(0, -50%)";
                const isActive = draggingField === key;
                const isSelected = selectedField === key;
                return (
                  <div
                    key={key}
                    onMouseDown={(e) => { e.preventDefault(); setDraggingField(key); setSelectedField(key); }}
                    onClick={() => setSelectedField(key)}
                    style={{
                      position: "absolute",
                      left: `${cfg.x}%`,
                      top: `${cfg.y}%`,
                      transform,
                      fontSize: `${cfg.font_size * PREVIEW_SCALE}px`,
                      color: cfg.font_color,
                      fontFamily: cfg.font_family,
                      textAlign: cfg.text_align,
                      cursor: "grab",
                      whiteSpace: "pre-wrap",
                      zIndex: 10,
                      outline: isSelected ? "2px solid hsl(var(--primary))" : "none",
                      outlineOffset: "2px",
                    }}
                  >
                    {custom_text || "Texto livre..."}
                  </div>
                );
              })}
            </div>

            {/* Upload button */}
            <div className="flex items-center gap-3">
              <label className="cursor-pointer">
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/jpg"
                  className="hidden"
                  onChange={(e) => e.target.files?.[0] && handleUpload(e.target.files[0])}
                />
                <Button variant="outline" size="sm" className="gap-2 pointer-events-none" disabled={uploading}>
                  <Upload className="w-4 h-4" />
                  {uploading ? "Carregando..." : "Carregar imagem de fundo"}
                </Button>
              </label>
              {backgroundUrl && (
                <span className="text-xs text-muted-foreground flex items-center gap-1">
                  <ImageIcon className="w-3 h-3" /> Imagem carregada
                </span>
              )}
            </div>

            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Move className="w-3 h-3" />
              Arraste os campos ativados sobre a imagem para posicioná-los.
            </p>
          </div>

          {/* ── Field config panel ── */}
          <div className="space-y-2 max-h-[60vh] overflow-y-auto pr-1">
            <h3 className="text-sm font-semibold sticky top-0 bg-card pb-1">Campos / Variáveis</h3>
            <Button variant="outline" size="sm" className="w-full gap-2 mb-2" onClick={addCustomField}>
              <Plus className="w-4 h-4" />
              Adicionar Texto Livre
            </Button>
            {visibleFields.map(({ key, label, sample }) => {
              const cfg = getConfig(key);
              const isSelected = selectedField === key;
              return (
                <div
                  key={key}
                  className={`rounded-xl border p-3 space-y-2 transition-colors cursor-pointer ${
                    isSelected ? "border-primary bg-primary/5" : "border-border"
                  }`}
                  onClick={() => setSelectedField(key)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <Label className="text-xs font-medium cursor-pointer">{label}</Label>
                    <Switch
                      checked={cfg.enabled}
                      onCheckedChange={(v) => updateConfig(key, { enabled: v })}
                    />
                  </div>
                  {cfg.enabled && (
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-0.5">
                        <Label className="text-[10px] text-muted-foreground">Tamanho</Label>
                        <Input
                          type="number"
                          min="8"
                          max="80"
                          value={cfg.font_size}
                          onChange={(e) => updateConfig(key, { font_size: parseInt(e.target.value) || 20 })}
                          className="h-8 text-xs"
                        />
                      </div>
                      <div className="space-y-0.5">
                        <Label className="text-[10px] text-muted-foreground">Cor</Label>
                        <input
                          type="color"
                          value={cfg.font_color}
                          onChange={(e) => updateConfig(key, { font_color: e.target.value })}
                          className="w-full h-8 rounded-md border border-border cursor-pointer"
                        />
                      </div>
                      <div className="space-y-0.5">
                        <Label className="text-[10px] text-muted-foreground">Fonte</Label>
                        <Select value={cfg.font_family} onValueChange={(v) => updateConfig(key, { font_family: v })}>
                          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {FONT_FAMILIES.map(f => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-0.5">
                        <Label className="text-[10px] text-muted-foreground">Alinhamento</Label>
                        <Select value={cfg.text_align} onValueChange={(v) => updateConfig(key, { text_align: v })}>
                          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="left">Esquerda</SelectItem>
                            <SelectItem value="center">Centro</SelectItem>
                            <SelectItem value="right">Direita</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-0.5">
                        <Label className="text-[10px] text-muted-foreground">Posição X (%)</Label>
                        <Input
                          type="number"
                          min="0"
                          max="100"
                          step="0.5"
                          value={cfg.x}
                          onChange={(e) => updateConfig(key, { x: parseFloat(e.target.value) || 0 })}
                          className="h-8 text-xs"
                        />
                      </div>
                      <div className="space-y-0.5">
                        <Label className="text-[10px] text-muted-foreground">Posição Y (%)</Label>
                        <Input
                          type="number"
                          min="0"
                          max="100"
                          step="0.5"
                          value={cfg.y}
                          onChange={(e) => updateConfig(key, { y: parseFloat(e.target.value) || 0 })}
                          className="h-8 text-xs"
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {/* Custom free-text fields config */}
            {customFields.length > 0 && (
              <div className="space-y-1 pt-2">
                <h3 className="text-sm font-semibold sticky top-0 bg-card pb-1">Textos Livres</h3>
                {customFields.map(({ key, custom_text }) => {
                  const cfg = getConfig(key);
                  const isSelected = selectedField === key;
                  return (
                    <div
                      key={key}
                      className={`rounded-xl border p-3 space-y-2 transition-colors cursor-pointer ${
                        isSelected ? "border-primary bg-primary/5" : "border-border"
                      }`}
                      onClick={() => setSelectedField(key)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <Label className="text-xs font-medium cursor-pointer">Texto personalizado</Label>
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={cfg.enabled}
                            onCheckedChange={(v) => updateConfig(key, { enabled: v })}
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-destructive"
                            onClick={(e) => { e.stopPropagation(); removeCustomField(key); }}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </div>
                      {cfg.enabled && (
                        <div className="space-y-2">
                          <div className="space-y-0.5">
                            <Label className="text-[10px] text-muted-foreground">Conteúdo do texto</Label>
                            <textarea
                              value={custom_text || ""}
                              onChange={(e) => updateConfig(key, { custom_text: e.target.value })}
                              placeholder="Digite o texto que deseja exibir no certificado..."
                              className="w-full min-h-[60px] rounded-md border border-input bg-transparent px-3 py-1.5 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y"
                            />
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <div className="space-y-0.5">
                              <Label className="text-[10px] text-muted-foreground">Tamanho</Label>
                              <Input
                                type="number"
                                min="8"
                                max="80"
                                value={cfg.font_size}
                                onChange={(e) => updateConfig(key, { font_size: parseInt(e.target.value) || 20 })}
                                className="h-8 text-xs"
                              />
                            </div>
                            <div className="space-y-0.5">
                              <Label className="text-[10px] text-muted-foreground">Cor</Label>
                              <input
                                type="color"
                                value={cfg.font_color}
                                onChange={(e) => updateConfig(key, { font_color: e.target.value })}
                                className="w-full h-8 rounded-md border border-border cursor-pointer"
                              />
                            </div>
                            <div className="space-y-0.5">
                              <Label className="text-[10px] text-muted-foreground">Fonte</Label>
                              <Select value={cfg.font_family} onValueChange={(v) => updateConfig(key, { font_family: v })}>
                                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  {FONT_FAMILIES.map(f => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
                                </SelectContent>
                              </Select>
                            </div>
                            <div className="space-y-0.5">
                              <Label className="text-[10px] text-muted-foreground">Alinhamento</Label>
                              <Select value={cfg.text_align} onValueChange={(v) => updateConfig(key, { text_align: v })}>
                                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="left">Esquerda</SelectItem>
                                  <SelectItem value="center">Centro</SelectItem>
                                  <SelectItem value="right">Direita</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                            <div className="space-y-0.5">
                              <Label className="text-[10px] text-muted-foreground">Posição X (%)</Label>
                              <Input
                                type="number"
                                min="0"
                                max="100"
                                step="0.5"
                                value={cfg.x}
                                onChange={(e) => updateConfig(key, { x: parseFloat(e.target.value) || 0 })}
                                className="h-8 text-xs"
                              />
                            </div>
                            <div className="space-y-0.5">
                              <Label className="text-[10px] text-muted-foreground">Posição Y (%)</Label>
                              <Input
                                type="number"
                                min="0"
                                max="100"
                                step="0.5"
                                value={cfg.y}
                                onChange={(e) => updateConfig(key, { y: parseFloat(e.target.value) || 0 })}
                                className="h-8 text-xs"
                              />
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button onClick={handleSave} disabled={saving || uploading} className="gap-2">
            <Save className="w-4 h-4" />
            {saving ? "Salvando..." : "Salvar Template"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}