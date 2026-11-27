/**
 * Recognises the few shell commands an agent must not run directly, because each one goes
 * around the gate:
 *
 *   gh pr merge ...                      merges on the server, where no git hook runs
 *   gh api .../pulls/N/merge (a PUT)     the same merge, asked for in another way
 *   git push --no-verify                 skips the hook that checks the push
 *   gotreceipts approve ...              the approval is a person's signature, not the agent's
 *
 * The list is short on purpose. Stopping a command that is known is reliable. Working out
 * what an arbitrary shell line will do is not, and this code does not pretend to: a script, an
 * alias or a command built at run time is not seen. The git hook and the merge command are the
 * checkpoints. This is the early, friendly "no" before them.
 *
 * The file has three parts: cutting a shell line into commands, the rules, and what the agent
 * is told when a rule stops a command.
 */

export type GuardRule = 'gh-pr-merge' | 'gh-api-merge' | 'push-no-verify' | 'approve';

// --- a shell line, cut into commands ---

/** The characters that end one command and start the next. */
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

// --- the rules ---

/** One forbidden use of one program. */
interface Rule {
  readonly name: GuardRule;
  /** True for the word that starts the program. `before` is the word in front of it, if any. */
  readonly program: (word: string, before: string | undefined) => boolean;
  /** True when the words after the program are the forbidden use of it. */
  readonly forbidden: (rest: readonly string[]) => boolean;
}

const isProgram =
  (name: string) =>
  (word: string): boolean =>
    programName(word) === name;

/** True for a word that starts this tool: its command name, or its entry file run through node. */
function isThisTool(word: string, before: string | undefined): boolean {
  // "gotreceipts", "gotreceipts.cmd", and "gotreceipts@1.2.3" as a package runner is given it.
  const name = programName(word).replace(/\.(cmd|ps1|bat)$/, '').replace(/@.*$/, '');
  if (name === 'gotreceipts') return true;
  // "node /path/to/gotreceipts/dist/cli.js", which is how the hooks start it.
  return before !== undefined && programName(before) === 'node' && /(^|[\\/])cli\.js$/.test(word);
}

/** What comes after "gh", without its options: "pr merge 12", "api repos/...". */
function ghWords(rest: readonly string[]): string[] {
  return positionals(rest, ['-R', '--repo', '--hostname']);
}

/** What comes after "git", without its options: "push origin main". */
function gitWords(rest: readonly string[]): string[] {
  return positionals(rest, ['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
}

function isPut(words: readonly string[]): boolean {
  return words.some((word, index) => {
    const lower = word.toLowerCase();
    if (lower === '-xput' || lower === '--method=put') return true;
    return (lower === '-x' || lower === '--method') && (words[index + 1] ?? '').toLowerCase() === 'put';
  });
}

/** A merge through the API: by the name of the GraphQL call, or as a PUT to the address of a pull request's merge. */
function isMergeThroughTheApi(rest: readonly string[]): boolean {
  if (rest.some((word) => /mergePullRequest/.test(word))) return true;
  return isPut(rest) && rest.some((word) => /\/pulls\/[^/\s]+\/merge$/.test(word));
}

const RULES: readonly Rule[] = [
  {
    name: 'gh-pr-merge',
    program: isProgram('gh'),
    forbidden: (rest) => {
      const [first, second] = ghWords(rest);
      return first === 'pr' && second === 'merge';
    },
  },
  {
    name: 'gh-api-merge',
    program: isProgram('gh'),
    forbidden: (rest) => ghWords(rest)[0] === 'api' && isMergeThroughTheApi(rest),
  },
  {
    name: 'push-no-verify',
    program: isProgram('git'),
    forbidden: (rest) => gitWords(rest)[0] === 'push' && rest.includes('--no-verify'),
  },
  {
    name: 'approve',
    program: isThisTool,
    // Asking for the help text of the command harms nobody.
    forbidden: (rest) => rest[0] === 'approve' && !rest.includes('--help') && !rest.includes('-h'),
  },
];

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
/** How many shells inside shells are looked into. */
const DEEPEST = 3;

/** The command line a shell is given to run, when `word` starts such a shell: bash -c "...". */
function lineGivenToAShell(word: string, rest: readonly string[]): string | undefined {
  const options = NESTED[programName(word)];
  if (options === undefined) return undefined;
  const at = rest.findIndex((each) => options.includes(each.toLowerCase()));
  // After the option, the rest is the command line: one quoted word for a Unix shell, several for the others.
  const inner = at === -1 ? '' : rest.slice(at + 1).join(' ');
  return inner === '' ? undefined : inner;
}

function ruleForCommand(words: readonly string[], depth: number): GuardRule | undefined {
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? '';
    const rest = words.slice(index + 1);

    const broken = RULES.find((rule) => rule.program(word, words[index - 1]) && rule.forbidden(rest));
    if (broken !== undefined) return broken.name;

    const inner = depth < DEEPEST ? lineGivenToAShell(word, rest) : undefined;
    const nested = inner === undefined ? undefined : forbiddenCommand(inner, depth + 1);
    if (nested !== undefined) return nested;
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

// --- what the agent is told ---

/** What is said about a stopped command. */
interface Told {
  readonly sentences: readonly string[];
  /** True when the sentences name a command of this tool to run. Then the agent is also told how to start the tool. */
  readonly namesACommand: boolean;
}

const MERGED_DIRECTLY: Told = {
  sentences: [
    'gotreceipts: merging a pull request directly is not allowed in this repository.',
    'Run "gotreceipts merge <pull request number>" instead. It checks that the commit has a valid record, and then merges exactly that commit.',
    'If it refuses, do what its last lines say. Do not look for another way to merge.',
  ],
  namesACommand: true,
};

const TOLD: Readonly<Record<GuardRule, Told>> = {
  'gh-pr-merge': MERGED_DIRECTLY,
  'gh-api-merge': MERGED_DIRECTLY,
  'push-no-verify': {
    sentences: [
      'gotreceipts: "git push --no-verify" skips the check that runs before a push, so it is not allowed in this repository.',
      'Push without that option. If the push is then refused, the commit has no valid record: run "gotreceipts gate" to make one, and fix what fails.',
      'Do not look for another way to push.',
    ],
    namesACommand: true,
  },
  approve: {
    sentences: [
      'gotreceipts: an approval is the signature of an owner of this repository, so "gotreceipts approve" is not for a coding agent to run.',
      'Tell the user which commit needs an approval, for which branch, and why. They run the command in their own terminal.',
      'Do not sign in their place, do not make or use a key for it, and do not look for another way.',
    ],
    namesACommand: false,
  },
};

/**
 * What the agent is told when a command is stopped: what to run instead, and not to look for
 * another way. `launcher` is how this tool is started on this machine, for the case that
 * "gotreceipts" is not a known command in the agent's shell.
 */
export function guardMessage(rule: GuardRule, launcher: string): string {
  const { sentences, namesACommand } = TOLD[rule];
  const howToStart = `If "gotreceipts" is not found as a command, start it as: ${launcher}`;
  return [...sentences, ...(namesACommand ? [howToStart] : [])].join(' ');
}
