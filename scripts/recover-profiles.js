'use strict';

// Rebuilds Chrome's "Local State" profile list (profile.info_cache) from the
// profile folders that still exist on disk. The profile DATA is never touched —
// only the small index that tells Chrome which profiles to show.
//
//   node recover-profiles.js           (dry run: show what it would restore)
//   node recover-profiles.js --apply   (back up Local State, then write the fix)
//
// Chrome MUST be fully closed before running with --apply, or Chrome will
// overwrite the fix on exit.

const fs = require('fs');
const path = require('path');

const UD = path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data');
const LS_PATH = path.join(UD, 'Local State');
const apply = process.argv.includes('--apply');

const ls = JSON.parse(fs.readFileSync(LS_PATH, 'utf8'));
ls.profile = ls.profile || {};
ls.profile.info_cache = ls.profile.info_cache || {};
const cache = ls.profile.info_cache;

// Use an existing entry as a schema-correct template (fall back to a skeleton).
const template = cache['Default'] || {
  avatar_icon: 'chrome://theme/IDR_PROFILE_AVATAR_26',
  background_apps: false,
  is_ephemeral: false,
  is_using_default_avatar: true,
  is_using_default_name: false,
  metrics_bucket_index: 0
};

const dirs = fs.readdirSync(UD, { withFileTypes: true })
  .filter((d) => d.isDirectory() && (d.name === 'Default' || /^Profile \d+$/.test(d.name)))
  .map((d) => d.name)
  .sort();

let bucket = Math.max(0, ...Object.values(cache).map((e) => e.metrics_bucket_index || 0));
const restored = [];

for (const dir of dirs) {
  if (cache[dir]) continue; // already listed
  const prefPath = path.join(UD, dir, 'Preferences');
  let name = dir, email = '', gaiaId = '', gaiaName = '';
  try {
    const pref = JSON.parse(fs.readFileSync(prefPath, 'utf8'));
    name = (pref.profile && pref.profile.name) || dir;
    const ai = pref.account_info && pref.account_info[0];
    if (ai) { email = ai.email || ''; gaiaId = ai.gaia || ''; gaiaName = ai.full_name || ''; }
  } catch (e) {
    name = dir + ' (name unreadable — Chrome may still be open)';
  }
  bucket += 1;
  cache[dir] = Object.assign({}, template, {
    name: name.replace(/ \(name unreadable.*$/, ''),
    user_name: email,
    gaia_id: gaiaId,
    gaia_name: gaiaName,
    is_using_default_name: false,
    is_ephemeral: false,
    metrics_bucket_index: bucket
  });
  restored.push({ dir, name, email });
}

console.log('Already listed:', Object.keys(cache).filter((k) => !restored.find((r) => r.dir === k)).join(', ') || '(none)');
console.log('\nProfiles to restore:');
if (!restored.length) console.log('  (none — all folders already listed)');
restored.forEach((r) => console.log(`  ${r.dir}  ->  "${r.name}"  ${r.email}`));

if (apply) {
  // Refuse to write while Chrome is open (it would overwrite the fix on exit).
  if (process.platform === 'win32') {
    try {
      const out = require('child_process').execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', { encoding: 'utf8' });
      if (/chrome\.exe/i.test(out)) {
        console.error('\n*** Chrome is still running. ***');
        console.error('Close it completely first: Ctrl+Shift+Esc -> Google Chrome -> End task, then run this again.');
        process.exit(1);
      }
    } catch {}
  }
  fs.copyFileSync(LS_PATH, LS_PATH + '.claudebak');
  fs.writeFileSync(LS_PATH, JSON.stringify(ls));
  console.log('\nDONE. Restored ' + restored.length + ' profiles. Backup saved as "Local State.claudebak".');
  console.log('Now open Chrome normally — all your profiles will be back.');
} else {
  console.log('\n(dry run — nothing written. Close Chrome, then run with --apply.)');
}
