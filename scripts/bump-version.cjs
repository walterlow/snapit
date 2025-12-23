#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

const FILES = {
  package: path.join(ROOT, 'package.json'),
  tauri: path.join(ROOT, 'src-tauri', 'tauri.conf.json'),
  cargo: path.join(ROOT, 'src-tauri', 'Cargo.toml'),
};

function getCurrentVersion() {
  const pkg = JSON.parse(fs.readFileSync(FILES.package, 'utf8'));
  return pkg.version;
}

function parseVersion(version) {
  const [major, minor, patch] = version.split('.').map(Number);
  return { major, minor, patch };
}

function bumpVersion(current, type) {
  const v = parseVersion(current);
  switch (type) {
    case 'major':
      return `${v.major + 1}.0.0`;
    case 'minor':
      return `${v.major}.${v.minor + 1}.0`;
    case 'patch':
      return `${v.major}.${v.minor}.${v.patch + 1}`;
    default:
      if (/^\d+\.\d+\.\d+$/.test(type)) {
        return type;
      }
      throw new Error(`Invalid version or bump type: ${type}`);
  }
}

function updatePackageJson(version) {
  const pkg = JSON.parse(fs.readFileSync(FILES.package, 'utf8'));
  pkg.version = version;
  fs.writeFileSync(FILES.package, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`  Updated package.json`);
}

function updateTauriConf(version) {
  const conf = JSON.parse(fs.readFileSync(FILES.tauri, 'utf8'));
  conf.version = version;
  fs.writeFileSync(FILES.tauri, JSON.stringify(conf, null, 2) + '\n');
  console.log(`  Updated tauri.conf.json`);
}

function updateCargoToml(version) {
  let content = fs.readFileSync(FILES.cargo, 'utf8');
  content = content.replace(
    /^(version\s*=\s*")[^"]+(")/m,
    `$1${version}$2`
  );
  fs.writeFileSync(FILES.cargo, content);
  console.log(`  Updated Cargo.toml`);
}

function gitCommitAndTag(version, skipTag) {
  try {
    execSync('git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml', {
      cwd: ROOT,
      stdio: 'inherit'
    });

    execSync(`git commit -m "chore: bump version to ${version}"`, {
      cwd: ROOT,
      stdio: 'inherit'
    });
    console.log(`  Committed changes`);

    if (!skipTag) {
      execSync(`git tag v${version}`, {
        cwd: ROOT,
        stdio: 'inherit'
      });
      console.log(`  Created tag v${version}`);
    }
  } catch (err) {
    console.error('Git operation failed:', err.message);
    process.exit(1);
  }
}

function printUsage() {
  console.log(`
Usage: node scripts/bump-version.cjs <version|patch|minor|major> [options]

Arguments:
  patch          Bump patch version (0.0.x)
  minor          Bump minor version (0.x.0)
  major          Bump major version (x.0.0)
  x.y.z          Set specific version

Options:
  --commit, -c   Commit changes after bumping
  --tag, -t      Create git tag (implies --commit)
  --push, -p     Push commit and tag to origin (implies --tag)
  --no-tag       Commit without creating a tag
  --help, -h     Show this help

Examples:
  node scripts/bump-version.cjs patch
  node scripts/bump-version.cjs minor --commit
  node scripts/bump-version.cjs 1.0.0 --tag
  node scripts/bump-version.cjs patch --push
`);
}

const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  printUsage();
  process.exit(0);
}

const versionArg = args.find(a => !a.startsWith('-'));
const shouldCommit = args.includes('--commit') || args.includes('-c') || args.includes('--tag') || args.includes('-t') || args.includes('--push') || args.includes('-p');
const shouldTag = (args.includes('--tag') || args.includes('-t') || args.includes('--push') || args.includes('-p')) && !args.includes('--no-tag');
const shouldPush = args.includes('--push') || args.includes('-p');

if (!versionArg) {
  console.error('Error: Version or bump type required');
  printUsage();
  process.exit(1);
}

const currentVersion = getCurrentVersion();
const newVersion = bumpVersion(currentVersion, versionArg);

console.log(`\nBumping version: ${currentVersion} -> ${newVersion}\n`);

updatePackageJson(newVersion);
updateTauriConf(newVersion);
updateCargoToml(newVersion);

if (shouldCommit) {
  console.log('\nCommitting changes...');
  gitCommitAndTag(newVersion, !shouldTag);
}

if (shouldPush) {
  console.log('\nPushing to origin...');
  try {
    execSync('git push', { cwd: ROOT, stdio: 'inherit' });
    if (shouldTag) {
      execSync(`git push origin v${newVersion}`, { cwd: ROOT, stdio: 'inherit' });
    }
    console.log('  Pushed successfully');
  } catch (err) {
    console.error('Push failed:', err.message);
    process.exit(1);
  }
}

console.log(`\n✅ Version bumped to ${newVersion}`);
