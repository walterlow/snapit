#!/usr/bin/env node

/**
 * Syncs version from package.json to tauri.conf.json and Cargo.toml
 * Called automatically by npm version lifecycle hook
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const FILES = {
  package: path.join(ROOT, 'package.json'),
  tauri: path.join(ROOT, 'src-tauri', 'tauri.conf.json'),
  cargo: path.join(ROOT, 'src-tauri', 'Cargo.toml'),
};

function getVersion() {
  const pkg = JSON.parse(fs.readFileSync(FILES.package, 'utf8'));
  return pkg.version;
}

function updateTauriConf(version) {
  const conf = JSON.parse(fs.readFileSync(FILES.tauri, 'utf8'));
  conf.version = version;
  fs.writeFileSync(FILES.tauri, JSON.stringify(conf, null, 2) + '\n');
  console.log(`  Synced tauri.conf.json -> ${version}`);
}

function updateCargoToml(version) {
  let content = fs.readFileSync(FILES.cargo, 'utf8');
  content = content.replace(
    /^(version\s*=\s*")[^"]+(")/m,
    `$1${version}$2`
  );
  fs.writeFileSync(FILES.cargo, content);
  console.log(`  Synced Cargo.toml -> ${version}`);
}

const version = getVersion();
console.log(`\nSyncing version ${version} to Tauri files...`);
updateTauriConf(version);
updateCargoToml(version);
