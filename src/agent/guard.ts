/**
 * Recognises the few shell commands an agent must not run directly, because each one goes
 * around the gate:
 *
 *   gh pr merge ...                      merges on the server, where no git hook runs
 *   gh api .../pulls/N/merge (a PUT)     the same merge, asked for in another way
 *   git push --no-verify                 skips the hook that checks the push
 *
 * The list is short on purpose. Stopping a command that is known is reliable. Working out
 * what an arbitrary shell line will do is not, and this code does not pretend to: a script, an
 * alias or a command built at run time is not seen. The git hook and the merge command are the
 * checkpoints. This is the early, friendly "no" before them.
 */

export type GuardRule = 'gh-pr-merge' | 'gh-api-merge' | 'push-no-verify';

/** The quote characters that group words, and the characters that end one command and start the next. */
const SEPARATORS = ';|&(){}`';

/**
 * Splits a shell line into its simple commands, each a list of words.
 * It knows quotes and the usual separators, for bash and for PowerShell. It runs nothing.
 */
export function splitCommands(line: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: string | undefined;

  const endWord = (): void => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? '';
    const next = line[index + 1] ?? '';

    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else if (char === '\\' && quote === '"' && (next === '"' || next === '\\')) {
        word += next;
        index += 1;
      } else word += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      inWord = true;
    } else if (char === '\\' && (next === '\n' || next === ' ' || next === '"' || next === "'")) {
      // A backslash before a line break joins two lines. Before a space or a quote it keeps that character.
      if (next !== '\n') {
        word += next;
        inWord = true;
      }
      index += 1;
    } else if (char === '\n') {
      endCommand();
    } else if (/\s/.test(char)) {
      endWord();
    } else if (SEPARATORS.includes(char)) {
      endCommand();
    } else if (char === '$' && next === '(') {
      endCommand();
      index += 1;
    } else {
      word += char;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

/** The name of a program without its folder and without ".exe", in lower case. */
function programName(word: string): string {
  const base = word.replace(/\\/g, '/').split('/').at(-1) ?? '';
  return base.toLowerCase().replace(/\.exe$/, '');
}

/** The words after a program that are not options. `withValue` lists the options that take the next word. */
function positionals(words: readonly string[], withValue: readonly string[]): string[] {
  const found: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? '';
    if (withValue.includes(word)) index += 1;
    else if (!word.startsWith('-')) found.push(word);
  }
  return found;
}

function isPut(words: readonly string[]): boolean {
  return words.some((word, index) => {
    const lower = word.toLowerCase();
    if (lower === '-xput' || lower === '--method=put') return true;
    return (lower === '-x' || lower === '--method') && (words[index + 1] ?? '').toLowerCase() === 'put';
  });
}

/** The shells that take a whole command line as one word, and the option that introduces it. */
const NESTED: Readonly<Record<string, readonly string[]>> = {
  sh: ['-c'],
  bash: ['-c'],
  zsh: ['-c'],
  dash: ['-c'],
  pwsh: ['-c', '-command'],
  powershell: ['-c', '-command'],
  cmd: ['/c', '/k'],
};

function ruleForCommand(words: readonly string[], depth: number): GuardRule | undefined {
  for (let index = 0; index < words.length; index += 1) {
    const name = programName(words[index] ?? '');
    const rest = words.slice(index + 1);

    if (name === 'gh') {
      const [first, second] = positionals(rest, ['-R', '--repo', '--hostname']);
      if (first === 'pr' && second === 'merge') return 'gh-pr-merge';
      if (first === 'api') {
        if (rest.some((word) => /mergePullRequest/.test(word))) return 'gh-api-merge';
        if (isPut(rest) && rest.some((word) => /\/pulls\/[^/\s]+\/merge$/.test(word))) return 'gh-api-merge';
      }
    }

    if (name === 'git') {
      const [first] = positionals(rest, ['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
      if (first === 'push' && rest.includes('--no-verify')) return 'push-no-verify';
    }

    const nestedOptions = NESTED[name];
    if (nestedOptions !== undefined && depth < 3) {
      const at = rest.findIndex((word) => nestedOptions.includes(word.toLowerCase()));
      // After the option, the rest is the command line: one quoted word for a Unix shell, several for the others.
      const inner = at === -1 ? undefined : rest.slice(at + 1).join(' ');
      if (inner !== undefined && inner !== '') {
        const nested = forbiddenCommand(inner, depth + 1);
        if (nested !== undefined) return nested;
      }
    }
  }
  return undefined;
}

/** Says which rule a shell line breaks, or undefined when it breaks none that this code can see. */
export function forbiddenCommand(line: string, depth = 0): GuardRule | undefined {
  for (const words of splitCommands(line)) {
    const rule = ruleForCommand(words, depth);
    if (rule !== undefined) return rule;
  }
  return undefined;
}

/**
 * What the agent is told when a command is stopped: what to run instead, and not to look for
 * another way. `launcher` is how this tool is started on this machine, for the case that
 * "gotreceipts" is not a known command in the agent's shell.
 */
export function guardMessage(rule: GuardRule, launcher: string): string {
  const fallback = `If "gotreceipts" is not found as a command, start it as: ${launcher}`;
  if (rule === 'push-no-verify') {
    return [
      'gotreceipts: "git push --no-verify" skips the check that runs before a push, so it is not allowed in this repository.',
      'Push without that option. If the push is then refused, the commit has no valid record: run "gotreceipts gate" to make one, and fix what fails.',
      'Do not look for another way to push.',
      fallback,
    ].join(' ');
  }
  return [
    'gotreceipts: merging a pull request directly is not allowed in this repository.',
    'Run "gotreceipts merge <pull request number>" instead. It checks that the commit has a valid record, and then merges exactly that commit.',
    'If it refuses, do what its last lines say. Do not look for another way to merge.',
    fallback,
  ].join(' ');
}
