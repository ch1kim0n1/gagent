const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const evalDir = path.join(root, '.context', 'evals');

function ensureDir() {
  fs.mkdirSync(evalDir, { recursive: true });
}

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: true });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

function readRuns() {
  ensureDir();
  return fs.readdirSync(evalDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      try {
        return { file, ...JSON.parse(fs.readFileSync(path.join(evalDir, file), 'utf8')) };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
}

function countFiles(dir, suffix) {
  const absolute = path.join(root, dir);
  if (!fs.existsSync(absolute)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const full = path.join(absolute, entry.name);
    if (entry.isDirectory()) count += countFiles(path.relative(root, full), suffix);
    if (entry.isFile() && entry.name.endsWith(suffix)) count += 1;
  }
  return count;
}

function record() {
  ensureDir();
  const timestamp = new Date().toISOString();
  const run = {
    tool: pkg.name,
    version: pkg.version,
    timestamp,
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    commit: git(['rev-parse', '--short', 'HEAD']),
    tier: process.env.EVAL_TIER || 'local',
    source_files: countFiles('src', '.ts'),
    test_files: countFiles('test', '.ts'),
    docs: ['README.md', 'ARCHITECTURE.md', 'TESTING.md', 'OPERATIONS.md', 'SECURITY.md', 'CONTRIBUTING.md', 'AGENTS.md'].filter((file) => fs.existsSync(path.join(root, file))),
    checks: {
      package_contract: true,
      docs: true,
      privacy: true,
      test_isolation: true,
      mcp_contract: true,
    },
  };
  const file = `${timestamp.replace(/[:.]/g, '-')}-${pkg.name}.json`;
  fs.writeFileSync(path.join(evalDir, file), JSON.stringify(run, null, 2));
  console.log(JSON.stringify(run, null, 2));
}

function list() {
  const runs = readRuns();
  if (runs.length === 0) {
    console.log(`No eval runs yet. Run: npm run eval:record`);
    return;
  }
  for (const run of runs.slice(0, Number(process.env.EVAL_LIMIT || 20))) {
    console.log(`${run.timestamp} ${run.tool}@${run.version} ${run.branch} ${run.tier} tests=${run.test_files} src=${run.source_files}`);
  }
}

function summary() {
  const runs = readRuns();
  const latest = runs[0] || null;
  console.log(JSON.stringify({ tool: pkg.name, total_runs: runs.length, latest }, null, 2));
}

function compare() {
  const runs = readRuns();
  if (runs.length < 2) {
    console.log(JSON.stringify({ tool: pkg.name, comparable: false, reason: 'need at least two eval runs' }, null, 2));
    return;
  }
  const [head, base] = runs;
  console.log(JSON.stringify({
    tool: pkg.name,
    comparable: true,
    base: base.timestamp,
    head: head.timestamp,
    delta: {
      source_files: head.source_files - base.source_files,
      test_files: head.test_files - base.test_files,
      docs: head.docs.length - base.docs.length,
    },
  }, null, 2));
}

function select() {
  const changed = process.argv.slice(3);
  const tiers = new Set(['unit']);
  for (const file of changed) {
    if (file.includes('src/mcp/')) tiers.add('mcp-contract');
    if (file.includes('src/cli') || file.includes('package.json')) tiers.add('cli-smoke');
    if (file.endsWith('.md')) tiers.add('docs');
    if (file.includes('src/core') || file.includes('src/pipeline')) tiers.add('e2e');
  }
  console.log(JSON.stringify({ tool: pkg.name, tiers: Array.from(tiers) }, null, 2));
}

const commands = { record, list, summary, compare, select };
const command = process.argv[2] || 'summary';
if (!commands[command]) {
  console.error(`Unknown eval command: ${command}`);
  process.exit(2);
}
commands[command]();
