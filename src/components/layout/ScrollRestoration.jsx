import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

/**
 * Minimal scroll preservation for the main mobile tabs.
 *
 * Strategy (React Router stays the single source of navigation):
 *  - A module-level Map<pathname, scrollY> caches the last window scroll position
 *    per route. It holds a single number per pathname — no React state, no re-renders.
 *  - A passive, rAF-throttled scroll listener keeps the entry for the active route
 *    up to date.
 *  - On pathname change:
 *      • flush the outgoing route's last position;
 *      • if the new route is one of the main tabs AND has a saved position,
 *        restore it (so returning to a tab lands where the user left off);
 *      • otherwise scroll to the top (detail/sub routes always open at the top,
 *        fixing the SPA quirk where a new page inherits the previous scroll).
 *
 * Non-tab routes are never restored — only reset to the top — so "Home → Evento"
 * opens the Evento at the top, while "Home → Rede → Home" restores Home's position.
 *
 * The browser's native scroll restoration is set to "manual" so it doesn't fight
 * this logic. Pull-to-refresh (which only fires at scrollY <= 0) is unaffected:
 * restoring to a saved position > 0 simply keeps it inactive, and restoring to 0
 * leaves it ready.
 */

// Main mobile tabs whose scroll position should be restored on return.
const RESTORABLE_TABS = new Set(["/", "/my-events", "/network", "/qr-scan", "/profile"]);

// pathname -> last window.scrollY. Lives outside React (just numbers).
const scrollPositions = new Map();

export default function ScrollRestoration() {
  const { pathname } = useLocation();
  const currentPath = useRef(pathname);

  // Take over scroll restoration from the browser (once).
  useEffect(() => {
    if (typeof window !== "undefined" && "scrollRestoration" in window.history) {
      window.history.scrollRestoration = "manual";
    }
  }, []);

  // Continuously record the active route's scroll position (passive, rAF-throttled).
  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        scrollPositions.set(currentPath.current, window.scrollY);
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
      scrollPositions.set(currentPath.current, window.scrollY);
    };
  }, []);

  // Restore (or reset) scroll whenever the route changes.
  useEffect(() => {
    const prev = currentPath.current;
    // Flush the outgoing route's last position (covers no-scroll navigations).
    scrollPositions.set(prev, window.scrollY);
    currentPath.current = pathname;

    const restore = () => {
      if (RESTORABLE_TABS.has(pathname)) {
        const saved = scrollPositions.get(pathname);
        if (saved != null) {
          window.scrollTo(0, saved);
          return;
        }
      }
      // Detail / non-tab routes always start at the top.
      window.scrollTo(0, 0);
    };

    // Restore after paint so cached / lazy content has a chance to mount before
    // we measure. A second pass catches lazy chunks mounting slightly later.
    const raf = requestAnimationFrame(restore);
    const t = setTimeout(restore, 120);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [pathname]);

  return null;
}