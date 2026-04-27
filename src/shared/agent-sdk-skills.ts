export const DEFAULT_DISABLED_SKILLS = ['claude-api'] as const;

export function disabledSkillOverrides(skills: readonly string[]): Record<string, 'off'> {
  const uniqueSkills = [...new Set(skills)];
  return Object.fromEntries(uniqueSkills.map((skill) => [skill, 'off'])) as Record<string, 'off'>;
}
