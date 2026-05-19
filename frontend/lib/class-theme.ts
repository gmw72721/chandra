export const teacherClassThemeColors = ["purple", "indigo", "blue", "teal", "cyan", "emerald", "amber", "coral", "rose"] as const;
export const teacherClassAppearances = ["light", "dark"] as const;
export const teacherClassThemeMoods = ["calm", "focused", "warm", "highContrast"] as const;

export type TeacherClassThemeColor = (typeof teacherClassThemeColors)[number];
export type TeacherClassAppearance = (typeof teacherClassAppearances)[number];
export type TeacherClassThemeMood = (typeof teacherClassThemeMoods)[number];

export const defaultTeacherClassThemeColor: TeacherClassThemeColor = "emerald";
export const defaultTeacherClassAppearance: TeacherClassAppearance = "light";
export const defaultTeacherClassThemeMood: TeacherClassThemeMood = "focused";

export const teacherClassThemeColorOptions: Array<{
  color: string;
  darkColor: string;
  id: TeacherClassThemeColor;
  label: string;
}> = [
  { id: "purple", label: "Purple", color: "#5634c7", darkColor: "#8f6cff" },
  { id: "indigo", label: "Indigo", color: "#3949ab", darkColor: "#7f91ff" },
  { id: "blue", label: "Blue", color: "#0b66a0", darkColor: "#55b5f2" },
  { id: "teal", label: "Teal", color: "#075b60", darkColor: "#32c0c6" },
  { id: "cyan", label: "Cyan", color: "#087487", darkColor: "#2bb8ce" },
  { id: "emerald", label: "Forest", color: "#346048", darkColor: "#48d17b" },
  { id: "amber", label: "Amber", color: "#a05f00", darkColor: "#f0b450" },
  { id: "coral", label: "Coral", color: "#c4512c", darkColor: "#e0774f" },
  { id: "rose", label: "Rose", color: "#b94e55", darkColor: "#ff8992" }
];

export const teacherClassThemeMoodOptions: Array<{
  description: string;
  id: TeacherClassThemeMood;
  label: string;
}> = [
  {
    id: "calm",
    label: "Calm",
    description: "Soft surfaces, quiet borders, and lower visual pressure."
  },
  {
    id: "focused",
    label: "Focused",
    description: "Clean contrast, compact rhythm, and minimal decoration."
  },
  {
    id: "warm",
    label: "Warm",
    description: "Softer neutral tones and a more welcoming classroom feel."
  },
  {
    id: "highContrast",
    label: "High contrast",
    description: "Stronger borders, clearer focus states, and brighter text."
  }
];

export function normalizeTeacherClassThemeColor(value: unknown): TeacherClassThemeColor {
  return teacherClassThemeColors.includes(value as TeacherClassThemeColor)
    ? (value as TeacherClassThemeColor)
    : defaultTeacherClassThemeColor;
}

export function normalizeTeacherClassAppearance(value: unknown): TeacherClassAppearance {
  return teacherClassAppearances.includes(value as TeacherClassAppearance)
    ? (value as TeacherClassAppearance)
    : defaultTeacherClassAppearance;
}

export function normalizeTeacherClassThemeMood(value: unknown): TeacherClassThemeMood {
  return teacherClassThemeMoods.includes(value as TeacherClassThemeMood)
    ? (value as TeacherClassThemeMood)
    : defaultTeacherClassThemeMood;
}
