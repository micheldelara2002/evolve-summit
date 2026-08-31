/**
 * Scanner de QR Code usando a BarcodeDetector API nativa do navegador.
 * Fallback: entrada manual do código do parceiro (para navegadores sem suporte).
 */
import { useState, useRef, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScanLine, CameraOff, Keyboard } from "lucide-react";

export default function QRScanner({ open, onClose, onScan, title = "Ler QR Code", codeLabel = "Digite o código:", codePlaceholder = "Código", hint = "Aponte a câmera para o QR Code.", confirmLabel = "Confirmar código" }) {
  const videoRef = useRef(null);
  const detectorRef = useRef(null);
  const streamRef = useRef(null);
  const timeoutRef = useRef(null);
  const [error, setError] = useState("");
  const [supported, setSupported] = useState(true);
  const [manualMode, setManualMode] = useState(false);
  const [manualCode, setManualCode] = useState("");

  useEffect(() => {
    if (!open) {
      setError("");
      setManualMode(false);
      setManualCode("");
      return;
    }

    if (!("BarcodeDetector" in window) || !navigator.mediaDevices?.getUserMedia) {
      setSupported(false);
      return;
    }

    let cancelled = false;

    const start = async () => {
      try {
        detectorRef.current = new window.BarcodeDetector({ formats: ["qr_code"] });
        streamRef.current = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });

        if (cancelled) {
          streamRef.current.getTracks().forEach((t) => t.stop());
          return;
        }

        if (videoRef.current) {
          videoRef.current.srcObject = streamRef.current;
          await videoRef.current.play();
          detectLoop();
        }
      } catch (err) {
        setError("Não foi possível acessar a câmera. Verifique as permissões do navegador.");
      }
    };

    const detectLoop = async () => {
      if (!videoRef.current || cancelled) return;
      try {
        const barcodes = await detectorRef.current.detect(videoRef.current);
        if (barcodes.length > 0) {
          onScan(barcodes[0].rawValue);
          return;
        }
      } catch (e) { /* ignore detection errors */ }
      if (!cancelled) {
        timeoutRef.current = setTimeout(detectLoop, 200);
      }
    };

    start();

    return () => {
      cancelled = true;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, [open, onScan]);

  const handleManualSubmit = () => {
    if (manualCode.trim()) {
      onScan(manualCode.trim());
    }
  };

  const showFallback = !supported || !!error;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScanLine className="w-5 h-5" /> {title}
          </DialogTitle>
        </DialogHeader>

        {showFallback ? (
          <div className="space-y-4">
            <div className="flex flex-col items-center gap-3 py-4 text-center">
              <CameraOff className="w-10 h-10 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {error || "Seu navegador não suporta leitura de QR pela câmera."}
              </p>
            </div>
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{codeLabel}</p>
              <input
                type="text"
                value={manualCode}
                onChange={(e) => setManualCode(e.target.value)}
                placeholder={codePlaceholder}
                className="w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onKeyDown={(e) => e.key === "Enter" && handleManualSubmit()}
              />
              <Button className="w-full" onClick={handleManualSubmit} disabled={!manualCode.trim()}>
                {confirmLabel}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="relative aspect-square rounded-xl overflow-hidden bg-black">
              <video ref={videoRef} className="w-full h-full object-cover" playsInline muted />
              <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                <div className="w-2/3 h-2/3 border-2 border-white/70 rounded-xl" />
              </div>
            </div>
            <p className="text-xs text-muted-foreground text-center">
              {hint}
            </p>
            <Button variant="outline" size="sm" className="w-full gap-1.5" onClick={() => setManualMode(true)}>
              <Keyboard className="w-3.5 h-3.5" /> Digitar código manualmente
            </Button>
            {manualMode && (
              <div className="space-y-2">
                <input
                  type="text"
                  value={manualCode}
                  onChange={(e) => setManualCode(e.target.value)}
                  placeholder={codePlaceholder}
                  className="w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  onKeyDown={(e) => e.key === "Enter" && handleManualSubmit()}
                />
                <Button className="w-full" onClick={handleManualSubmit} disabled={!manualCode.trim()}>
                  {confirmLabel}
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}