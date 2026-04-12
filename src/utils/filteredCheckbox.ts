// ---------------------------------------------------------------------------
// filteredCheckbox
//
// A custom interactive terminal prompt that renders a scrollable checkbox list
// with live type-filter cycling. Requires a real TTY (falls back to a plain
// inquirer checkbox when stdin is not interactive).
//
// Keybindings:
//   ↑ / ↓          navigate
//   Space           toggle item
//   f               cycle filter (all → git-only → submodules-only → …)
//   a               toggle-select all visible items
//   Page Up/Down    jump a full page
//   Home / End      jump to first / last
//   Enter           confirm selection
//   Ctrl+C          abort
// ---------------------------------------------------------------------------

import chalk from 'chalk';

export interface FilterableItem<T> {
  /** Short display label (e.g. suggestedId) */
  label: string;
  /** Secondary display text shown after the label (e.g. path) */
  subtext: string;
  /** The value returned when this item is selected */
  value: T;
  /** Domain type string used for filtering */
  itemType: string;
}

interface FilterMode {
  label: string;
  includes: (type: string) => boolean;
}

const PAGE_SIZE = 15;

// ANSI helpers
const ESC = '\x1B';
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const PAGE_UP = `${ESC}[5~`;
const PAGE_DOWN = `${ESC}[6~`;
const HOME1 = `${ESC}[H`;
const HOME2 = `${ESC}[1~`;
const END1 = `${ESC}[F`;
const END2 = `${ESC}[4~`;
const CTRL_C = '\x03';

function clearLines(n: number): void {
  if (n > 0) process.stdout.write(`${ESC}[${n}A${ESC}[0J`);
}

function typeColor(t: string): (s: string) => string {
  if (t === 'git-submodule') return chalk.magenta;
  if (t === 'git-repo') return chalk.blue;
  if (t === 'package-root') return chalk.yellow;
  return chalk.gray;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function filteredCheckbox<T>(config: {
  message: string;
  items: FilterableItem<T>[];
}): Promise<T[]> {
  const { message, items } = config;

  if (items.length === 0) return [];

  // Non-interactive fallback: plain list, select nothing (caller should guard)
  if (!process.stdin.isTTY) {
    process.stderr.write('filteredCheckbox: stdin is not a TTY, returning empty selection\n');
    return [];
  }

  // Build filter modes from the types that actually appear in the data
  const availableTypes = [...new Set(items.map((i) => i.itemType))];

  const filterModes: FilterMode[] = [
    { label: 'all types', includes: () => true },
  ];

  if (availableTypes.some((t) => t === 'git-submodule' || t === 'git-repo') && availableTypes.length > 1) {
    filterModes.push({
      label: 'git only',
      includes: (t) => t === 'git-submodule' || t === 'git-repo',
    });
  }
  if (availableTypes.includes('git-submodule') && availableTypes.length > 1) {
    filterModes.push({
      label: 'submodules only',
      includes: (t) => t === 'git-submodule',
    });
  }
  if (availableTypes.includes('git-repo') && availableTypes.length > 1) {
    filterModes.push({
      label: 'git repos only',
      includes: (t) => t === 'git-repo',
    });
  }
  if (availableTypes.includes('package-root') && availableTypes.length > 1) {
    filterModes.push({
      label: 'packages only',
      includes: (t) => t === 'package-root',
    });
  }

  // Compute max label length for alignment
  const maxLabelLen = Math.min(
    32,
    Math.max(...items.map((i) => i.label.length)),
  );

  return new Promise((resolve) => {
    const checked = new Set<number>();
    let cursor = 0;
    let filterIdx = 0;
    let scrollTop = 0;
    let prevLineCount = 0;

    function getVisible(): Array<{ item: FilterableItem<T>; idx: number }> {
      const mode = filterModes[filterIdx];
      return items
        .map((item, idx) => ({ item, idx }))
        .filter(({ item }) => mode.includes(item.itemType));
    }

    function clamp(visible: Array<{ item: FilterableItem<T>; idx: number }>): void {
      if (visible.length === 0) { cursor = 0; scrollTop = 0; return; }
      if (cursor >= visible.length) cursor = visible.length - 1;
      if (cursor < 0) cursor = 0;
      if (cursor < scrollTop) scrollTop = cursor;
      if (cursor >= scrollTop + PAGE_SIZE) scrollTop = cursor - PAGE_SIZE + 1;
      if (scrollTop < 0) scrollTop = 0;
    }

    function render(): void {
      const visible = getVisible();
      clamp(visible);

      const lines: string[] = [];
      const filterLabel = filterModes[filterIdx].label;
      const selCount = checked.size;

      lines.push(`${chalk.green('?')} ${chalk.bold(message)}`);
      lines.push(
        `  ${chalk.gray('↑↓ navigate')}  ${chalk.gray('Space toggle')}  ` +
        `${chalk.cyan('f')} ${chalk.gray(`filter: ${chalk.yellow(filterLabel)}`)}  ` +
        `${chalk.cyan('a')} ${chalk.gray('select-all')}  ${chalk.cyan('Enter')} ${chalk.gray('confirm')}`,
      );
      lines.push(
        `  ${chalk.gray(`${visible.length} shown`)}  ${chalk.green(`${selCount} selected`)}`,
      );
      lines.push('');

      const page = visible.slice(scrollTop, scrollTop + PAGE_SIZE);

      for (let i = 0; i < page.length; i++) {
        const { item, idx } = page[i];
        const isCursor = cursor === scrollTop + i;
        const isChecked = checked.has(idx);

        const pointer = isCursor ? chalk.cyan('❯') : ' ';
        const box = isChecked ? chalk.green('◉') : chalk.gray('○');
        const col = typeColor(item.itemType);

        const labelPadded = item.label.padEnd(maxLabelLen).slice(0, maxLabelLen + 2);
        const nameStr = isCursor ? chalk.cyan(chalk.bold(labelPadded)) : chalk.bold(labelPadded);
        const pathStr = chalk.gray(item.subtext);
        const typeStr = col(`[${item.itemType}]`);

        lines.push(`${pointer} ${box} ${nameStr}  ${pathStr}  ${typeStr}`);
      }

      if (visible.length > PAGE_SIZE) {
        const end = Math.min(scrollTop + PAGE_SIZE, visible.length);
        lines.push(chalk.gray(`  ── ${scrollTop + 1}–${end} of ${visible.length} ──`));
      }

      clearLines(prevLineCount);
      process.stdout.write(lines.join('\n'));
      prevLineCount = lines.length;
    }

    function finish(): void {
      clearLines(prevLineCount);
      const n = checked.size;
      process.stdout.write(
        `${chalk.green('✔')} ${chalk.bold(message)}  ${chalk.gray(`${n} selected`)}\n`,
      );
      teardown();
      const result = items.filter((_, idx) => checked.has(idx)).map((i) => i.value);
      resolve(result);
    }

    function abort(): void {
      process.stdout.write('\n');
      teardown();
      process.exit(0);
    }

    function teardown(): void {
      try { process.stdin.setRawMode(false); } catch { /* ignore */ }
      process.stdin.pause();
      process.stdin.removeAllListeners('data');
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    render();

    process.stdin.on('data', (key: string) => {
      const visible = getVisible();

      if (key === CTRL_C) {
        abort();
        return;
      }

      if (key === '\r' || key === '\n') {
        finish();
        return;
      }

      switch (key) {
        case ' ': {
          if (visible.length > 0) {
            const { idx } = visible[cursor];
            if (checked.has(idx)) checked.delete(idx);
            else checked.add(idx);
          }
          break;
        }

        case 'f':
        case 'F': {
          filterIdx = (filterIdx + 1) % filterModes.length;
          cursor = 0;
          scrollTop = 0;
          break;
        }

        case 'a':
        case 'A': {
          const allChecked = visible.every(({ idx }) => checked.has(idx));
          for (const { idx } of visible) {
            if (allChecked) checked.delete(idx);
            else checked.add(idx);
          }
          break;
        }

        case UP:
          if (cursor > 0) cursor--;
          break;

        case DOWN:
          if (cursor < visible.length - 1) cursor++;
          break;

        case PAGE_UP:
          cursor = Math.max(0, cursor - PAGE_SIZE);
          break;

        case PAGE_DOWN:
          cursor = Math.min(Math.max(0, visible.length - 1), cursor + PAGE_SIZE);
          break;

        case HOME1:
        case HOME2:
          cursor = 0;
          scrollTop = 0;
          break;

        case END1:
        case END2:
          cursor = Math.max(0, visible.length - 1);
          break;
      }

      render();
    });
  });
}
