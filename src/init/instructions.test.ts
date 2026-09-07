import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INSTRUCTION_BLOCK, appendInstructionBlock } from './instructions.js';

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
});
