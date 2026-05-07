export const teacherClassThemeColors = ["purple", "indigo", "blue", "teal", "emerald", "rose"] as const;
export const teacherClassAppearances = ["light", "dark"] as const;

export type TeacherClassThemeColor = (typeof teacherClassThemeColors)[number];
export type TeacherClassAppearance = (typeof teacherClassAppearances)[number];

export const defaultTeacherClassThemeColor: TeacherClassThemeColor = "purple";
export const defaultTeacherClassAppearance: TeacherClassAppearance = "light";

export const teacherClassThemeColorOptions: Array<{
  color: string;
  id: TeacherClassThemeColor;
  label: string;
}> = [
  { id: "purple", label: "Purple", color: "#5634c7" },
  { id: "indigo", label: "Indigo", color: "#3949ab" },
  { id: "blue", label: "Blue", color: "#0b66a0" },
  { id: "teal", label: "Teal", color: "#075b60" },
  { id: "emerald", label: "Emerald", color: "#167c3d" },
  { id: "rose", label: "Rose", color: "#b94e55" }
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
