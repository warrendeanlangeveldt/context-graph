import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INSTRUCTION_BLOCK, appendInstructionBlock, instructionBlockState } from './instructions.js';

describe('instruction block', () => {
  it('appends once to AGENTS.md, through a CLAUDE.md symlink, and reports when nothing can carry it', () => {
    const root = mkdtempSync(join(tmpdir(), 'ctx-ins-'));
    expect(appendInstructionBlock(root)).toEqual({ status: 'missing' });
    writeFileSync(join(root, 'AGENTS.md'), '# Rules\n\n- Keep it small.\n');
    symlinkSync('AGENTS.md', join(root, 'CLAUDE.md'));
    expect(appendInstructionBlock(root)).toEqual({ file: 'AGENTS.md', status: 'appended' });
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe(`# Rules\n\n- Keep it small.\n\n${INSTRUCTION_BLOCK}`);
    expect(appendInstructionBlock(root)).toEqual({ file: 'AGENTS.md', status: 'present' });
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8').split('## Context Graph')).toHaveLength(2);
  });

  it('CARDW-7 brings an older block up to date in place, keeping what comes after it', () => {
    const root = mkdtempSync(join(tmpdir(), 'ctx-ins-'));
    const old = '## Context Graph\n\nAfter the edit, write or update the file\'s card with the `card` tool.\n';
    writeFileSync(join(root, 'CLAUDE.md'), `# Project\n\n${old}\n## code-kit\n\nLanes.\n`);
    expect(instructionBlockState(readFileSync(join(root, 'CLAUDE.md'), 'utf8'))).toBe('outdated');
    expect(appendInstructionBlock(root)).toEqual({ file: 'CLAUDE.md', status: 'updated' });
    const now = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    expect(now).toBe(`# Project\n\n${INSTRUCTION_BLOCK}\n## code-kit\n\nLanes.\n`);
    expect(instructionBlockState(now)).toBe('current');
    expect(appendInstructionBlock(root)).toEqual({ file: 'CLAUDE.md', status: 'present' });
  });
});
