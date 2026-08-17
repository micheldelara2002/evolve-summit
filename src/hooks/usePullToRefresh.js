import { useRef, useState, useEffect } from "react";

/**
 * Pull-to-refresh controlado, no nível do conteúdo da página (não do documento).
 * - Só dispara quando a página está no topo (window.scrollY <= 0).
 * - Não depende do bounce nativo (compatível com overscroll-behavior: none).
 * - Guarda contra refresh simultâneo via ref.
 * - Ignora toques em campos de formulário (input/textarea/select/contenteditable).
 * - Dead zone para não suprimir taps acidentais.
 *
 * @param {Function} onRefresh callback async (ou void) executado no disparo
 * @param {Object} opts { threshold=60, max=100, disabled=false }
 */
export function usePullToRefresh(onRefresh, { threshold = 60, max = 100, disabled = false } = {}) {
  const containerRef = useRef(null);
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [pulling, setPulling] = useState(false);

  const pullRef = useRef(0);
  const refreshingRef = useRef(false);
  const onRefreshRef = useRef(onRefresh);
  const stateRef = useRef({ startY: 0, active: false });

  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || disabled) return;

    const DEAD = 8;

    const isFormEl = (target) =>
      !!target?.closest?.("input, textarea, select, [contenteditable='true'], [contenteditable='']");

    const onStart = (e) => {
      if (refreshingRef.current) return;
      if (e.touches.length !== 1) return;
      stateRef.current.startY = e.touches[0].clientY;
      const atTop = (window.scrollY ?? window.pageYOffset ?? 0) <= 0;
      stateRef.current.active = atTop && !isFormEl(e.target);
    };

    const onMove = (e) => {
      if (!stateRef.current.active || refreshingRef.current) return;
      const dy = e.touches[0].clientY - stateRef.current.startY;
      if (dy <= 0) {
        if (pullRef.current !== 0) {
          pullRef.current = 0;
          setPull(0);
          setPulling(false);
        }
        return;
      }
      if (dy <= DEAD) return; // dead zone: protege taps
      e.preventDefault();
      if (!pullRef.current) setPulling(true);
      const next = Math.min((dy - DEAD) * 0.5, max);
      pullRef.current = next;
      setPull(next);
    };

    const onEnd = async () => {
      if (!stateRef.current.active) return;
      stateRef.current.active = false;
      setPulling(false);
      if (pullRef.current >= threshold && !refreshingRef.current) {
        refreshingRef.current = true;
        setRefreshing(true);
        pullRef.current = threshold;
        setPull(threshold);
        try {
          await onRefreshRef.current?.();
        } finally {
          refreshingRef.current = false;
          setRefreshing(false);
          pullRef.current = 0;
          setPull(0);
        }
      } else {
        pullRef.current = 0;
        setPull(0);
      }
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [disabled, threshold, max]);

  return { containerRef, pull, refreshing, pulling };
}