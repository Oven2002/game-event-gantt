export const EFFECTS_PREFERENCES_KEY = "game-event-gantt.effects.v1";

export interface EffectsPreferences {
  sakuraEnabled: boolean;
  mascotVisible: boolean;
}

export function parseEffectsPreferences(raw: string | null, defaultSakura: boolean): EffectsPreferences {
  const defaults = { sakuraEnabled: defaultSakura, mascotVisible: true };
  if (!raw) return defaults;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)) return defaults;
    return {
      sakuraEnabled: typeof value.sakuraEnabled === "boolean" ? value.sakuraEnabled : defaults.sakuraEnabled,
      mascotVisible: typeof value.mascotVisible === "boolean" ? value.mascotVisible : defaults.mascotVisible,
    };
  } catch {
    return defaults;
  }
}
