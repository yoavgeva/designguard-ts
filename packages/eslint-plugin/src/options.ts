import { relative } from "node:path";
import type { Finding, Place, Reached } from "@designguard/core";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

/**
 * The options every rule takes. Each is a list of selectors: a path glob, `path#name`, `#name`, or for a package's
 * declarations `package#name`, as `@prisma/client#*PlanDelegate.*`. In paths, `*` stays within a folder and `**`
 * crosses them; in names, `*` matches anything.
 *
 * - `include`: report only findings in matching files or functions;
 * - `exclude`: don't report findings in matching files or functions;
 * - `excludeReaching`: don't report findings whose way leads through a matching function or package declaration.
 */
export interface SharedOptions {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly excludeReaching?: readonly string[];
}

const selectors: JSONSchema4 = { type: "array", items: { type: "string" } };

export const sharedSchema: JSONSchema4 = {
  type: "object",
  properties: { include: selectors, exclude: selectors, excludeReaching: selectors },
  additionalProperties: false,
};

/** Whether the options let a finding be reported, with paths read relative to `root`. */
export function reportable(finding: Finding, options: SharedOptions, root: string): boolean {
  const at = (selector: string): boolean => matches(selector, finding.at, root);
  if (options.include !== undefined && options.include.length > 0 && !options.include.some(at)) return false;
  if (options.exclude?.some(at) === true) return false;
  return !(options.excludeReaching ?? []).some((selector) => finding.reaching.some((step) => matches(selector, step, root)));
}

function matches(selector: string, place: Place | Reached, root: string): boolean {
  const hash = selector.indexOf("#");
  const where = hash < 0 ? selector : selector.slice(0, hash);
  const name = hash < 0 ? undefined : selector.slice(hash + 1);
  const location = "package" in place ? place.package : relative(root, place.file);
  if (where !== "" && !pathGlob(where).test(location)) return false;
  return name === undefined || nameGlob(name).test(place.symbol);
}

function pathGlob(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern.charAt(i);
    if (char === "*" && pattern.charAt(i + 1) === "*") {
      source += pattern.charAt(i + 2) === "/" ? "(?:.*/)?" : ".*";
      i += pattern.charAt(i + 2) === "/" ? 2 : 1;
    } else if (char === "*") source += "[^/]*";
    else source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

function nameGlob(pattern: string): RegExp {
  return new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
}
