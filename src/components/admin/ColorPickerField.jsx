import { useState } from "react";
import { Input } from "@/components/ui/input";

const PALETTE = [
  "#4F46E5", "#0D9488", "#F59E0B", "#EF4444", "#10B981",
  "#3B82F6", "#8B5CF6", "#F97316", "#EC4899", "#14B8A6",
  "#6366F1", "#84CC16", "#F43F5E", "#06B6D4", "#A855F7",
  "#22C55E", "#EAB308", "#64748B", "#DC2626", "#2563EB",
];

export default function ColorPickerField({ value, onChange, label }) {
  const [hex, setHex] = useState(value || "#4F46E5");

  const handleHexChange = (v) => {
    setHex(v);
    if (/^#[0-9A-Fa-f]{6}$/.test(v)) onChange(v);
  };

  const handlePick = (color) => {
    setHex(color);
    onChange(color);
  };

  const handleNative = (e) => {
    setHex(e.target.value);
    onChange(e.target.value);
  };

  return (
    <div className="space-y-2">
      {label && <p className="text-xs text-muted-foreground">{label}</p>}
      <div className="flex flex-wrap gap-1.5">
        {PALETTE.map((c) => (
          <button
            key={c}
            type="button"
            title={c}
            onClick={() => handlePick(c)}
            className="w-6 h-6 rounded-full border-2 transition-transform hover:scale-110 focus:outline-none focus:ring-2 focus:ring-ring"
            style={{
              backgroundColor: c,
              borderColor: hex === c ? "#000" : "transparent",
            }}
          />
        ))}
      </div>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={hex}
          onChange={handleNative}
          className="w-8 h-8 rounded cursor-pointer border-0 shrink-0"
        />
        <Input
          value={hex}
          onChange={(e) => handleHexChange(e.target.value)}
          className="text-xs h-8 font-mono w-28"
          maxLength={7}
          placeholder="#000000"
        />
        <div className="w-8 h-8 rounded border" style={{ backgroundColor: hex }} />
      </div>
    </div>
  );
}