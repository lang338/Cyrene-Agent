export type UiTheme = "pearl-white" | "charcoal-pink";

export function normalizeUiTheme(value: unknown): UiTheme {
  return value === "charcoal-pink" ? "charcoal-pink" : "pearl-white";
}
