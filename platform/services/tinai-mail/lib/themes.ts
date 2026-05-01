export interface Theme {
  name: string;
  label: string;
  context: "work" | "school";
  primary: string;
  primaryLight: string;
  surface: string;
  surfaceContainer: string;
  onSurface: string;
  outline: string;
  gradient: [string, string];
}

export const themes: Theme[] = [
  {
    name: "indigo",
    label: "Indigo",
    context: "work",
    primary: "#4a40e0",
    primaryLight: "#9795ff",
    surface: "#faf4ff",
    surfaceContainer: "#f3ecf9",
    onSurface: "#32294f",
    outline: "#7b719c",
    gradient: ["#4a40e0", "#9795ff"],
  },
  {
    name: "teal",
    label: "Teal",
    context: "work",
    primary: "#006947",
    primaryLight: "#34d399",
    surface: "#f0fdf4",
    surfaceContainer: "#e2f7ea",
    onSurface: "#1a3a2a",
    outline: "#5f8a72",
    gradient: ["#006947", "#34d399"],
  },
  {
    name: "purple",
    label: "Purple",
    context: "school",
    primary: "#7c3aed",
    primaryLight: "#c084fc",
    surface: "#faf5ff",
    surfaceContainer: "#f3e8ff",
    onSurface: "#3b1a6e",
    outline: "#8b74b2",
    gradient: ["#7c3aed", "#c084fc"],
  },
  {
    name: "ocean",
    label: "Ocean",
    context: "school",
    primary: "#0369a1",
    primaryLight: "#38bdf8",
    surface: "#f0f9ff",
    surfaceContainer: "#e0f2fe",
    onSurface: "#0c3547",
    outline: "#5b8da8",
    gradient: ["#0369a1", "#38bdf8"],
  },
];

export const defaultTheme = themes[0];

const STORAGE_KEY = "tinai-mail-theme";

export function getSavedThemeName(): string {
  if (typeof window === "undefined") return defaultTheme.name;
  return localStorage.getItem(STORAGE_KEY) || defaultTheme.name;
}

export function saveThemeName(name: string): void {
  localStorage.setItem(STORAGE_KEY, name);
}

export function getThemeByName(name: string): Theme {
  return themes.find((t) => t.name === name) || defaultTheme;
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.style.setProperty("--primary", theme.primary);
  root.style.setProperty("--primary-light", theme.primaryLight);
  root.style.setProperty("--surface", theme.surface);
  root.style.setProperty("--surface-container", theme.surfaceContainer);
  root.style.setProperty("--on-surface", theme.onSurface);
  root.style.setProperty("--outline", theme.outline);
}
