import { describe, expect, it } from 'vitest';
import { parseShellCommand } from './shell.js';

const modes = (cmd: string): string[] => parseShellCommand(cmd).map((t) => `${t.mode} ${t.path}${t.range ? ` ${t.range.join(':')}` : ''}${t.unparsed ? ' ?' : ''}`);

describe('parseShellCommand', () => {
  it('classifies reads', () => {
    expect(modes('cat src/a.ts')).toEqual(['full src/a.ts']);
    expect(modes('cat -n src/a.ts src/b.ts')).toEqual(['full src/a.ts', 'full src/b.ts']);
    expect(modes('head -n 40 src/a.ts')).toEqual(['range src/a.ts 1:40']);
    expect(modes('head -20 src/a.ts')).toEqual(['range src/a.ts 1:20']);
    expect(modes('tail -n 30 src/a.ts')).toEqual(['range src/a.ts -30:-1']);
    expect(modes('tail -n +100 src/a.ts')).toEqual(['range src/a.ts 100:-1']);
    expect(modes("sed -n '340,420p' src/a.ts")).toEqual(['range src/a.ts 340:420']);
    expect(modes('sed -n 12p src/a.ts')).toEqual(['range src/a.ts 12:12']);
    expect(modes("sed -n '/applyEvent/p' src/a.ts")).toEqual(['grep src/a.ts']);
    expect(modes("sed 's/x/y/' src/a.ts")).toEqual(['full src/a.ts']);
    expect(modes("awk '{print $1}' data.csv")).toEqual(['full data.csv']);
  });

  it('classifies greps and listings', () => {
    expect(modes('grep -rn "registerTool" api/src/')).toEqual(['grep api/src/']);
    expect(modes('grep -rn foo')).toEqual(['grep .']);
    expect(modes('rg -e "x" -t ts src/')).toEqual(['grep src/']);
    expect(modes('rg "pattern" src/a.ts src/b.ts')).toEqual(['grep src/a.ts', 'grep src/b.ts']);
    expect(modes('git grep -n foo -- api/')).toEqual(['grep api/']);
    expect(modes('ls -la src/')).toEqual(['name src/']);
    expect(modes('ls')).toEqual(['name .']);
    expect(modes('find . -name "*.ts"')).toEqual(['name .']);
    expect(modes('find api/src web -type f')).toEqual(['name api/src', 'name web']);
    expect(modes('wc -l src/a.ts')).toEqual(['name src/a.ts']);
  });

  it('classifies writes, edits, and deletes', () => {
    expect(modes("sed -i '' 's/a/b/' src/a.ts")).toEqual(['edit src/a.ts']);
    expect(modes('sed -i.bak -e "s/a/b/" src/a.ts')).toEqual(['edit src/a.ts']);
    expect(modes('echo hi > out.txt')).toEqual(['write out.txt']);
    expect(modes('cat src/a.ts >> log.txt')).toEqual(['write log.txt', 'full src/a.ts']);
    expect(modes('cp src/a.ts src/b.ts')).toEqual(['name src/a.ts', 'write src/b.ts']);
    expect(modes('mv old.ts new.ts')).toEqual(['delete old.ts', 'write new.ts']);
    expect(modes('rm -f tmp/x.log')).toEqual(['delete tmp/x.log']);
    expect(modes('touch src/new.ts')).toEqual(['write src/new.ts']);
    expect(modes('git checkout -- src/a.ts')).toEqual(['write src/a.ts']);
    expect(modes('git apply fix.patch')).toEqual(['edit fix.patch ?']);
    expect(modes('patch -p1 < fix.diff')).toEqual(['full fix.diff', 'edit . ?']);
  });

  it('handles heredocs, pipes, chains, and cd', () => {
    expect(modes('cat > src/new.ts <<EOF\nexport const x = 1;\ncat should/not/parse.ts\nEOF')).toEqual(['write src/new.ts']);
    expect(modes('cat src/a.ts | grep foo | head -5')).toEqual(['full src/a.ts', 'grep .']);
    expect(modes('cd api && cat src/a.ts && ls')).toEqual(['full src/a.ts', 'name .']);
    expect(parseShellCommand('cd api && cat src/a.ts', '/repo')).toEqual([{ path: '/repo/api/src/a.ts', mode: 'full' }]);
    expect(modes('npm test; git status')).toEqual(['name .']);
  });

  it('marks runners as name and unknown commands as unparsed', () => {
    expect(modes('npx vitest run src/a.test.ts')).toEqual(['name src/a.test.ts']);
    expect(modes('node scripts/build.mjs')).toEqual(['name scripts/build.mjs']);
    expect(modes('curl -o out.json https://example.com/x')).toEqual(['write out.json']);
    expect(modes('frobnicate src/a.ts')).toEqual(['name src/a.ts ?']);
    expect(modes('git show HEAD:src/a.ts')).toEqual(['full src/a.ts']);
    expect(modes('git diff -- src/a.ts')).toEqual(['name src/a.ts']);
  });

  it('strips wrappers and env assignments', () => {
    expect(modes('FOO=1 BAR=2 cat src/a.ts')).toEqual(['full src/a.ts']);
    expect(modes('sudo cat /etc/hosts')).toEqual(['full /etc/hosts']);
    expect(modes('timeout 30 node run.js')).toEqual(['name run.js']);
    expect(modes('echo "no > redirect here"')).toEqual([]);
    expect(modes('cat "src/with space.ts"')).toEqual(['full src/with space.ts']);
  });

  it('sees through an interpreter script: heredoc or inline, read, edit, write, delete, and the opaque case', () => {
    expect(modes("python3 - <<'PY'\np='src/a.ts'\ns=open(p).read()\nopen(p,'w').write(s.replace('x','y'))\nPY")).toEqual(['edit src/a.ts']);
    expect(modes("python3 - <<'PY'\nimport json\nprint(json.load(open('cfg/x.json')))\nPY")).toEqual(['full cfg/x.json']);
    expect(modes("python3 - <<'PY'\nfrom pathlib import Path\nPath('docs/out.md').write_text('hi')\nPY")).toEqual(['write docs/out.md']);
    expect(modes("python3 - <<'PY'\nimport os\nos.remove('tmp/old.log')\nPY")).toEqual(['delete tmp/old.log']);
    expect(modes("node - <<'JS'\nconst fs = require('fs');\nconst p = 'src/b.ts';\nfs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/a/g, 'b'));\nJS")).toEqual(['edit src/b.ts']);
    expect(modes("node -e \"require('fs').writeFileSync('out/x.json', '{}')\"")).toEqual(['write out/x.json']);
    expect(modes("cat <<'EOF' | python3 -\np='src/c.ts'\nopen(p,'w').write('x')\nEOF")).toEqual(['write src/c.ts']);
    expect(modes("bash <<'EOF'\ncat src/d.ts\nsed -i '' 's/a/b/' src/e.ts\nEOF")).toEqual(['full src/d.ts', 'edit src/e.ts']);
    expect(modes("sh -c 'cat src/f.ts'")).toEqual(['full src/f.ts']);
    expect(modes("python3 - <<'PY'\nprint(1)\nPY")).toEqual(['name . ?']);
    expect(modes("python3 - <<'PY'\nfor f in files:\n    open(f, 'w').write(x)\nPY")).toEqual(['edit . ?']);
    expect(modes("python3 - <<'PY'\nimport subprocess\nsubprocess.run(['ls', 'src/g.ts'])\nPY")).toEqual(['name src/g.ts ?']);
    expect(modes("node -e \"import('./src/h.js')\"")).toEqual([]);
    expect(modes("python3 scripts/gen.py")).toEqual(['name scripts/gen.py']);
    expect(parseShellCommand("cd api && python3 - <<'PY'\nopen('src/i.ts','w').write('')\nPY", '/repo')).toEqual([{ path: '/repo/api/src/i.ts', mode: 'write' }]);
  });

  it('never mistakes a regex or an inline script for a path', () => {
    expect(modes("perl -pe 's/^\\s*\\*\\s*//' src/a.ts")).toEqual(['name src/a.ts']);
    expect(modes("python3 -c 'import os; print(os.path.join(\"a\",\"b\"))'")).toEqual([]);
    expect(modes("grep -E '^(foo|bar)/baz$' src/")).toEqual(['grep src/']);
    expect(modes("sed -n 's/^import .*from \\(.*\\)/\\1/p' src/a.ts")).toEqual(['grep src/a.ts']);
    expect(modes('awk -F/ \'{print $2}\' data.csv')).toEqual(['full data.csv']);
    expect(modes("awk '/async resumeAfterHumanInput/{p=1} p{print NR\": \"$0} p&&/^  }$/{exit}' src/orchestrator.ts")).toEqual(['full src/orchestrator.ts']);
    expect(modes('LOG=/tmp/run.log; npm test > $LOG 2>&1; tail -20 $LOG')).toEqual([]);
    expect(modes('echo hi > "$DIR/out.txt"')).toEqual([]);
  });

  it('ignores /dev/null and noops', () => {
    expect(modes('cmd > /dev/null 2>&1')).toEqual([]);
    expect(modes('export X=1; pwd; echo done')).toEqual([]);
  });
});
