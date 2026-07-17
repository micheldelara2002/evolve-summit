import { useState, useEffect } from "react";
import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { sanitizeText } from "@/utils/sanitize";

// Radix Select does not accept empty string as value — use this sentinel instead
const NONE_VALUE = "__none__";

export default function EntityFormDialog({ open, onOpenChange, title, fields, item, onSubmit, isSubmitting }) {
  const [form, setForm] = useState({});

  useEffect(() => {
    if (open) {
      const initial = {};
      fields.forEach((f) => {
        initial[f.key] = item?.[f.key] ?? f.defaultValue ?? "";
      });
      setForm(initial);
    }
  }, [open, item]);

  const update = (key, val) => setForm((p) => ({ ...p, [key]: val }));

  const handleSubmit = (e) => {
    e.preventDefault();
    const data = { ...form };
    fields.forEach((f) => {
      if (f.type === "number" && data[f.key]) data[f.key] = Number(data[f.key]);
      // Convert sentinel back to empty string
      if (f.type === "select" && data[f.key] === NONE_VALUE) data[f.key] = "";
    });
    // Remove null/undefined fields so optional fields don't erase existing values
    Object.keys(data).forEach((k) => { if (data[k] === null || data[k] === undefined) delete data[k]; });
    // Sanitize all string fields (defense-in-depth against XSS)
    Object.keys(data).forEach((k) => { if (typeof data[k] === "string") data[k] = sanitizeText(data[k]); });
    onSubmit(data);
  };

  // Convert stored value to Select display value (sentinel for empty)
  const selectVal = (key) => {
    const v = form[key];
    return v === "" || v === null || v === undefined ? NONE_VALUE : v;
  };

  // Convert Select choice back to form value
  const selectChange = (key, v) => update(key, v === NONE_VALUE ? "" : v);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display">{title}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {fields.filter((f) => !f.hidden).map((f) => (
            <div key={f.key} className="space-y-1.5">
              <Label className="text-sm">{f.label}{f.required && " *"}</Label>
              {f.type === "textarea" ? (
                <Textarea value={form[f.key] || ""} onChange={(e) => update(f.key, e.target.value)} rows={3} required={f.required} />
              ) : f.type === "select" ? (
                <Select value={selectVal(f.key)} onValueChange={(v) => selectChange(f.key, v)} required={f.required}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {f.options?.map((o) => (
                      <SelectItem key={o.value === "" ? NONE_VALUE : o.value} value={o.value === "" ? NONE_VALUE : o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  type={f.type || "text"}
                  value={form[f.key] || ""}
                  onChange={(e) => update(f.key, e.target.value)}
                  required={f.required}
                  placeholder={f.placeholder}
                />
              )}
            </div>
          ))}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? t("common.loading") : t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}