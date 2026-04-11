import * as path from 'path';
import { listFiles, pathExists } from '../utils/fs.js';
import { parseYaml, readYamlFile } from '../utils/yaml.js';
import { TemplateNotFoundError } from '../utils/errors.js';
import { Template, TemplateSchema } from '../models/template.js';
import { AI_PATHS } from '../config/loader.js';
import { globalTemplatesDir as resolveGlobalDir } from '../config/defaults.js';

// ---------------------------------------------------------------------------
// Template loader
//
// Three-tier resolution order (first match wins):
//   1. Project-local:  .ai/templates/<id>.yaml
//   2. Global user/org: WAIRON_TEMPLATES_DIR | ~/.wairon/templates/<id>.yaml
//   3. Built-in:        <package>/dist/templates/<id>.yaml
//
// This lets organizations ship their own default templates (tier 2) while
// still allowing per-project overrides (tier 1).
// ---------------------------------------------------------------------------

function builtinTemplatesDir(): string {
  return path.resolve(__dirname, '..', 'templates');
}

/**
 * Load a single template by id.
 * Throws TemplateNotFoundError if not found in any tier.
 *
 * @param globalOverride - optional path from project config (globalTemplatesDir field)
 */
export function loadTemplate(id: string, globalOverride?: string): Template {
  const dirs = templateSearchDirs(globalOverride);
  for (const dir of dirs) {
    const filePath = path.join(dir, `${id}.yaml`);
    if (pathExists(filePath)) {
      const raw = readYamlFile(filePath);
      return TemplateSchema.parse(raw);
    }
  }
  throw new TemplateNotFoundError(id);
}

/**
 * List all available template ids across all tiers, deduplicated.
 * Earlier tiers shadow later ones.
 */
export function listTemplateIds(globalOverride?: string): string[] {
  const seen = new Set<string>();
  for (const dir of templateSearchDirs(globalOverride)) {
    for (const file of listFiles(dir, '.yaml')) {
      seen.add(path.basename(file, '.yaml'));
    }
  }
  return Array.from(seen).sort();
}

/**
 * Return the ordered list of directories to search for templates.
 */
function templateSearchDirs(globalOverride?: string): string[] {
  return [
    AI_PATHS.templatesDir(),                  // 1. project-local
    resolveGlobalDir(globalOverride),          // 2. global user/org
    builtinTemplatesDir(),                     // 3. built-in fallback
  ];
}

/**
 * Render a template's instruction body by substituting {{variable}} placeholders.
 */
export function renderTemplateInstructions(
  template: Template,
  vars: Record<string, string>,
): string {
  return template.instructions.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    return key in vars ? vars[key] : `{{${key}}}`;
  });
}

/**
 * Parse a template from a raw YAML string (used for testing / one-off loading).
 */
export function parseTemplate(yamlContent: string): Template {
  return TemplateSchema.parse(parseYaml(yamlContent));
}
