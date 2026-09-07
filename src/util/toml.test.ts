import { describe, expect, it } from 'vitest';
import { parseToml, tomlGet } from './toml.js';

describe('parseToml', () => {
  it('reads the subset the plugin uses', () => {
    const t = parseToml(`
# comment
[slice]
enabled = "random:0.5"   # arm
max_tokens = 300
[record]
max_blocks = 2
[observe]
shell_parsing = false
forward = true
[embed]
include = ["docs/adr/**", 'docs/discovery/**']
[init.packs]
"ports-and-adapters.domain" = "L:platform-core"
`);
    expect(tomlGet(t, 'slice', 'enabled', true)).toBe('random:0.5');
    expect(tomlGet(t, 'slice', 'max_tokens', 0)).toBe(300);
    expect(tomlGet(t, 'record', 'max_blocks', 0)).toBe(2);
    expect(tomlGet(t, 'observe', 'shell_parsing', true)).toBe(false);
    expect(tomlGet(t, 'embed', 'include', [])).toEqual(['docs/adr/**', 'docs/discovery/**']);
    expect(tomlGet(t, 'init.packs', 'ports-and-adapters.domain', '')).toBe('L:platform-core');
    expect(tomlGet(t, 'slice', 'missing', 7)).toBe(7);
  });
});
