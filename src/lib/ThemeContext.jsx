import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";

const ThemeContext = createContext(null);

const STORAGE_KEY = "es-theme";
const VALID_THEMES = ["dark", "light", "system"];

function getSystemPreference() {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme) {
  const isDark = theme === "dark" || (theme === "system" && getSystemPreference() === "dark");
  document.documentElement.classList.toggle("dark", isDark);
}

export function ThemeProvider({ children }) {
  const { user } = useAuth();
  const [theme, setThemeState] = useState(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return VALID_THEMES.includes(stored) ? stored : "dark";
    } catch {
      return "dark";
    }
  });

  // Apply to DOM + persist locally
  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch { /* ignore */ }
  }, [theme]);

  // Listen to system preference changes when in 'system' mode
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyTheme("system");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  // Sync from user profile on login
  useEffect(() => {
    const saved = user?.theme_preference;
    if (VALID_THEMES.includes(saved)) {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored !== saved) {
          setThemeState(saved);
        }
      } catch { /* ignore */ }
    }
  }, [user?.theme_preference]);

  const setTheme = useCallback(async (next) => {
    if (!VALID_THEMES.includes(next)) return;
    setThemeState(next);
    // Persist to user profile (fire-and-forget)
    try {
      await base44.auth.updateMe({ theme_preference: next });
    } catch { /* ignore — not logged in or network error */ }
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
};