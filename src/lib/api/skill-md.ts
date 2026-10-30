import type { SkillDef } from "@/lib/catalog/skills";

/** YAML-safe scalar for front matter - quotes whenever the value could be
 *  read as something other than a plain string (colons, quotes, leading/trailing
 *  space, YAML keywords, numbers…). */
function yamlScalar(v: string): string {
  return JSON.stringify(v);
}

/** Render a SKILL.md document for a catalog skill - front matter, what the
 *  pipeline does, the intake questions it asks, and the job endpoints its
 *  steps call. Generated from the data definition so it can't drift. */

export function skillMd(skill: SkillDef): string {
  const steps = skill.steps("", {}) ?? [];
  const endpoints = [...new Set(steps.map((s) => s.endpoint))];
  const lines: string[] = [
    "---",
    // name is the slug - skill ids are already lowercase slugs, which keeps
    // the front matter valid and matches the URL clients fetched.
    `name: ${yamlScalar(skill.id)}`,
    `description: ${yamlScalar(skill.blurb)}`,
    "---",
    "",
    `# ${skill.name}`,
    "",
    skill.blurb,
    "",
    "## What it does",
    `Runs an ordered ${steps.length}-step generation pipeline on your behalf:`,
    ...steps.map((s, i) => `${i + 1}. ${s.label}`),
    "",
    "## Endpoints it calls",
    ...endpoints.map((e) => `- \`${e}\``),
  ];
  if (skill.refSlots?.length) {
    lines.push("", "## Inputs it accepts");
    for (const r of skill.refSlots)
      lines.push(`- ${r.label} - ${r.accept}, up to ${r.max}`);
  }
  if (skill.intake.length) {
    lines.push("", "## Intake questions");
    for (const q of skill.intake)
      lines.push(`- ${q.key}: ${q.ask}${q.options?.length ? ` (options: ${q.options.join(", ")})` : ""}`);
  }
  return lines.join("\n") + "\n";
}
