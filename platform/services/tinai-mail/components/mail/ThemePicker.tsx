"use client";

import { useState, useEffect, useRef } from "react";
import { Palette, Check } from "lucide-react";
import {
  themes,
  applyTheme,
  getThemeByName,
  getSavedThemeName,
  saveThemeName,
  type Theme,
} from "@/lib/themes";

export function ThemePicker() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<string>("indigo");
  const ref = useRef<HTMLDivElement>(null);

  // Load saved theme on mount
  useEffect(() => {
    const name = getSavedThemeName();
    setCurrent(name);
    applyTheme(getThemeByName(name));
  }, []);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClick);
      return () => document.removeEventListener("mousedown", handleClick);
    }
  }, [open]);

  function selectTheme(theme: Theme) {
    setCurrent(theme.name);
    saveThemeName(theme.name);
    applyTheme(theme);
    setOpen(false);
  }

  const workThemes = themes.filter((t) => t.context === "work");
  const schoolThemes = themes.filter((t) => t.context === "school");

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="text-white/70 hover:text-white transition p-1.5 rounded-lg hover:bg-white/10"
        title="Change theme"
      >
        <Palette className="w-4 h-4" />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-52 bg-white rounded-xl shadow-xl border border-black/10 py-2 z-50 animate-in fade-in slide-in-from-top-1 duration-150">
          <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
            Work
          </div>
          {workThemes.map((theme) => (
            <ThemeOption
              key={theme.name}
              theme={theme}
              isActive={current === theme.name}
              onSelect={selectTheme}
            />
          ))}

          <div className="mx-3 my-1.5 border-t border-gray-100" />

          <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
            School
          </div>
          {schoolThemes.map((theme) => (
            <ThemeOption
              key={theme.name}
              theme={theme}
              isActive={current === theme.name}
              onSelect={selectTheme}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ThemeOption({
  theme,
  isActive,
  onSelect,
}: {
  theme: Theme;
  isActive: boolean;
  onSelect: (t: Theme) => void;
}) {
  return (
    <button
      onClick={() => onSelect(theme)}
      className={`w-full flex items-center gap-3 px-3 py-2 text-sm transition-colors ${
        isActive
          ? "bg-gray-50 font-medium text-gray-900"
          : "text-gray-600 hover:bg-gray-50"
      }`}
    >
      {/* Color preview circles */}
      <div className="flex -space-x-1">
        <span
          className="w-5 h-5 rounded-full border-2 border-white shadow-sm"
          style={{ background: theme.primary }}
        />
        <span
          className="w-5 h-5 rounded-full border-2 border-white shadow-sm"
          style={{ background: theme.primaryLight }}
        />
      </div>

      <span className="flex-1 text-left">{theme.label}</span>

      {isActive && <Check className="w-3.5 h-3.5 text-gray-900" />}
    </button>
  );
}
