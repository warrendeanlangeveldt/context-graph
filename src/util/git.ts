import { execFileSync } from 'node:child_process';

export function git(root: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

export function currentBranch(root: string): string {
  return git(root, ['branch', '--show-current']) || 'detached';
}

/** The person half of a `person/agent` identity: the local part of the git email, else the name. */
export function gitPerson(root: string): string {
  const email = git(root, ['config', 'user.email']);
  if (email && email.includes('@')) return email.split('@')[0] ?? email;
  const name = git(root, ['config', 'user.name']);
  if (name) return name.trim().toLowerCase().replace(/\s+/g, '-');
  return process.env.USER ?? 'unknown';
}

export function headSha(root: string): string | undefined {
  return git(root, ['rev-parse', '--short', 'HEAD']);
}
