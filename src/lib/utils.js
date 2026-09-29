import { clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs) {
  return twMerge(clsx(inputs))
}
// P3 (2026-09-29) — isIframe removido (export morto, remanescente do antigo
// guard de preview removido no OPS-001).