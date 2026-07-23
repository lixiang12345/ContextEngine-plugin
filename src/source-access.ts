import type {
  SourcePathPolicy,
  SourcePathRule,
} from "./types.js";

/**
 * Evaluate one workspace-relative path against a source access policy.
 * The most-specific matching prefix wins; deny wins equal-specificity ties.
 */
export function sourcePathAllowed(
  policy: SourcePathPolicy | null | undefined,
  sourcePath: string,
): boolean {
  if (!policy) return true;
  let selected: SourcePathRule | null = null;
  for (const rule of policy.rules) {
    if (
      sourcePath !== rule.pathPrefix &&
      !sourcePath.startsWith(`${rule.pathPrefix}/`)
    ) {
      continue;
    }
    if (
      !selected ||
      rule.pathPrefix.length > selected.pathPrefix.length ||
      (rule.pathPrefix.length === selected.pathPrefix.length &&
        rule.effect === "deny")
    ) {
      selected = rule;
    }
  }
  return (selected?.effect ?? policy.defaultAccess) === "allow";
}
