const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

const contracts = {
  gagent: ['gagent_run', 'gagent_health', 'gagent_brain_search', 'gagent_stack_review', 'gagent_config_get', 'gagent_config_set'],
  gorchestrator: ['gorch_run', 'gorch_health', 'gorch_config_sample'],
  gmirror: ['gmirror_score', 'gmirror_health', 'gmirror_failure_modes', 'gmirror_calibrate'],
  gtom: ['gtom_ingest', 'gtom_score', 'gtom_audit', 'gtom_vulnerabilities', 'gtom_health'],
  glearn: ['glearn_run', 'glearn_patterns', 'glearn_proposals', 'glearn_approve', 'glearn_health'],
};

function fail(message) {
  console.error(`[quality-gates] FAIL: ${message}`);
  process.exitCode = 1;
}

function ok(message) {
  console.log(`[quality-gates] OK: ${message}`);
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    const relative = path.relative(root, absolute).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', 'coverage', '.git', '.context'].includes(entry.name)) continue;
      walk(absolute, files);
    } else {
      files.push(relative);
    }
  }
  return files;
}

function checkPackageContract() {
  const requiredScripts = ['build', 'test', 'test:coverage', 'typecheck', 'verify', 'ci:local', 'check:all', 'smoke', 'eval:record', 'eval:list', 'eval:summary', 'eval:compare', 'eval:select'];
  for (const script of requiredScripts) {
    if (!pkg.scripts || !pkg.scripts[script]) fail(`package.json missing script: ${script}`);
  }
  if (!pkg.name) fail('package.json missing name');
  if (!pkg.version) fail('package.json missing version');
  if (!pkg.description) fail('package.json missing description');
  if (!pkg.license) fail('package.json missing license');
  if (!pkg.engines || !pkg.engines.node) fail('package.json missing engines.node');
  if (!pkg.bin || Object.keys(pkg.bin).length === 0) fail('package.json missing bin entry');
  if (!exists('src/cli.ts')) fail('missing src/cli.ts');
  if (!exists('src/mcp/server.ts')) fail('missing src/mcp/server.ts');
  if (!exists('scripts/eval-tools.js')) fail('missing scripts/eval-tools.js');
  if (!exists('jest.config.js')) fail('missing jest.config.js');
  if (!exists('tsconfig.json')) fail('missing tsconfig.json');
  ok('package contract');
}

function checkDocs() {
  const requiredDocs = ['README.md', 'ARCHITECTURE.md', 'TESTING.md', 'OPERATIONS.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'AGENTS.md', '.env.example'];
  for (const doc of requiredDocs) {
    if (!exists(doc)) {
      fail(`missing documentation file: ${doc}`);
      continue;
    }
    const content = read(doc).trim();
    if (content.length < 100) fail(`${doc} is too thin to be production documentation`);
  }
  ok('documentation contract');
}

function checkPrivacy() {
  const candidates = walk(root).filter((file) => /\.(ts|js|json|md|sh|ps1|yml|yaml|txt)$/.test(file));
  const secretPatterns = [
    /(?:api[_-]?key|secret|token|password)\s*[:=]\s*['\"][A-Za-z0-9_./+=-]{20,}['\"]/i,
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
    /sk-[A-Za-z0-9]{20,}/,
  ];
  for (const file of candidates) {
    if (['package-lock.json', 'bun.lock'].includes(path.basename(file))) continue;
    const content = read(file);
    for (const pattern of secretPatterns) {
      if (pattern.test(content)) fail(`possible secret in ${file}`);
    }
  }
  ok('privacy scan');
}

function checkTestIsolation() {
  const testFiles = walk(path.join(root, 'test')).filter((file) => file.endsWith('.ts'));
  for (const file of testFiles) {
    const content = read(file);
    if (/\b(?:describe|it|test)\.only\s*\(/.test(content)) fail(`focused test committed in ${file}`);
    if (/\b(?:fdescribe|fit)\s*\(/.test(content)) fail(`focused test alias committed in ${file}`);
  }
  ok('test isolation');
}

function checkMcpContract() {
  const server = read('src/mcp/server.ts');
  const expected = contracts[pkg.name] || [];
  if (expected.length === 0) fail(`no MCP contract registered for package ${pkg.name}`);
  for (const tool of expected) {
    if (!server.includes(tool)) fail(`MCP server missing expected tool: ${tool}`);
  }
  if (!server.includes(`name: '${pkg.name}'`) && !server.includes(`name: \"${pkg.name}\"`)) fail('MCP server package name mismatch');
  if (!server.includes("version: '0.1.0'") && !server.includes('version: \"0.1.0\"')) fail('MCP server version mismatch');
  ok('MCP contract');
}

function checkAll() {
  checkPackageContract();
  checkDocs();
  checkPrivacy();
  checkTestIsolation();
  checkMcpContract();
}

function run(command, args) {
  const useShell = command === 'npm';
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: useShell });
  if (result.error) console.error(`[quality-gates] command failed to start: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status || 1);
}

function smoke() {
  const cli = path.join(root, 'dist', 'cli.js');
  if (!fs.existsSync(cli)) fail('missing dist/cli.js; run npm run build before smoke');
  if (process.exitCode) process.exit(process.exitCode);
  run('node', [cli, '--version']);
  run('node', [cli, '--help']);
  ok('CLI smoke');
}

function ciLocal() {
  checkAll();
  if (process.exitCode) process.exit(process.exitCode);
  run('npm', ['run', 'typecheck']);
  run('npm', ['test']);
  run('npm', ['run', 'build']);
  smoke();
}

const command = process.argv[2] || 'all';
const commands = {
  'package-contract': checkPackageContract,
  docs: checkDocs,
  privacy: checkPrivacy,
  'test-isolation': checkTestIsolation,
  'mcp-contract': checkMcpContract,
  all: checkAll,
  smoke,
  'ci-local': ciLocal,
};

if (!commands[command]) {
  console.error(`Unknown quality gate: ${command}`);
  process.exit(2);
}

commands[command]();
if (process.exitCode) process.exit(process.exitCode);
