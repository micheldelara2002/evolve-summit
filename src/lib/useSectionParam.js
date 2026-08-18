import { useState, useEffect, useCallback } from "react";

/**
 * useSectionParam — sincroniza a seção ativa com a URL (?section=).
 * Compatibilidade com legado: se ?tab= estiver presente, mapeia via legacyTabMap.
 *
 * @param {object} params
 * @param {string} params.defaultSection seção inicial caso não haja param na URL
 * @param {Record<string, string>} [params.legacyTabMap] mapa { tabValue: sectionValue } para compat
 * @returns [activeSection, setActiveSection]
 */
export function useSectionParam({ defaultSection, legacyTabMap = {} }) {
  const readFromUrl = () => {
    const params = new URLSearchParams(window.location.search);
    const section = params.get("section");
    if (section) return section;
    const tab = params.get("tab");
    if (tab && legacyTabMap[tab]) return legacyTabMap[tab];
    return defaultSection;
  };

  const [section, setSection] = useState(readFromUrl);

  const updateUrl = useCallback((newSection) => {
    const params = new URLSearchParams(window.location.search);
    params.set("section", newSection);
    params.delete("tab");
    const newSearch = params.toString();
    window.history.replaceState(
      {},
      "",
      `${window.location.pathname}${newSearch ? "?" + newSearch : ""}`
    );
  }, []);

  const handleSectionChange = useCallback(
    (newSection) => {
      setSection(newSection);
      updateUrl(newSection);
    },
    [updateUrl]
  );

  useEffect(() => {
    const onPopState = () => setSection(readFromUrl());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  return [section, handleSectionChange];
}