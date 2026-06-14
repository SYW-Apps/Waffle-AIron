import * as path from 'path';
import * as fs from 'fs';
import { ensureDir, fromProjectRoot } from '../utils/fs.js';

function builtinSkillsDir(): string {
  return path.resolve(__dirname, '..', 'templates', 'skills');
}

/**
 * Copy the built-in SDD skill templates to the project's local AI tooling directories
 * (.gemini/skills/ and .claude/).
 */
export function exportSddSkills(): void {
  const sourceDir = builtinSkillsDir();
  const skillFiles = ['sdd-architect.md', 'sdd-narrative.md', 'sdd-auditor.md', 'sdd-implement.md'];

  const destinations = [
    fromProjectRoot('.gemini', 'skills'),
    fromProjectRoot('.claude')
  ];

  // Ensure destinations exist
  for (const dest of destinations) {
    ensureDir(dest);
  }

  for (const file of skillFiles) {
    const srcPath = path.join(sourceDir, file);
    if (!fs.existsSync(srcPath)) {
      continue;
    }

    let content = fs.readFileSync(srcPath, 'utf-8');

    const { getCliCommandString } = require('../utils/ai-guide.js') as typeof import('../utils/ai-guide.js');
    const command = getCliCommandString();
    content = content.replace(/\bwairon\b/g, command);

    for (const destDir of destinations) {
      const destPath = path.join(destDir, file);
      fs.writeFileSync(destPath, content, 'utf-8');
    }
  }
}
