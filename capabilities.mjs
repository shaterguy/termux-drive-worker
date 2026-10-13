import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { buildProgramInventory } from './program-catalog.mjs';

const NOTABLE = [
  'git','gh','node','npm','npx','skills','python','python3','java','javac','gradle','adb',
  'chromium','chromium-browser','google-chrome','ffmpeg','curl','wget','jq',
  'proot','proot-distro','ssh','scp','rsync','make','cmake','clang','gcc','g++',
  'kotlinc','sdkmanager','rea','rea-full','apktool','rclone','pandoc'
];

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function summarize(locations) {
  const commands = Object.keys(locations).sort();
  return {
    command_count: commands.length,
    commands,
    locations,
    notable: Object.fromEntries(NOTABLE.map((name) => [name, locations[name] || null])),
  };
}

async function scanDirectory(actualDir, logicalDir, trustSymlinks) {
  const found = {};
  let entries = [];
  try {
    entries = await fs.readdir(actualDir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.name || entry.isDirectory()) continue;
    const actual = path.join(actualDir, entry.name);
    let executable = trustSymlinks && entry.isSymbolicLink();
    if (!executable) {
      try {
        await fs.access(actual, fss.constants.X_OK);
        executable = true;
      } catch {}
    }
    if (executable) found[entry.name] = path.posix.join(logicalDir, entry.name);
  }
  return found;
}

async function scanHost(pathValue) {
  const dirs = uniq(String(pathValue || '').split(':'));
  const locations = {};
  for (const dir of dirs) {
    const one = await scanDirectory(dir, dir, false);
    for (const [name, full] of Object.entries(one)) {
      if (!(name in locations)) locations[name] = full;
    }
  }
  return { path: dirs, ...summarize(locations) };
}

async function scanProot(prefix) {
  const base = path.join(prefix, 'var', 'lib', 'proot-distro', 'installed-rootfs');
  let roots = [];
  try {
    roots = (await fs.readdir(base, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {}
  const standardPath = ['/usr/local/sbin','/usr/local/bin','/usr/sbin','/usr/bin','/sbin','/bin'];
  const distributions = [];
  for (const name of roots) {
    const root = path.join(base, name);
    const locations = {};
    for (const logical of standardPath) {
      const actual = path.join(root, logical.slice(1));
      const one = await scanDirectory(actual, logical, true);
      for (const [cmd, full] of Object.entries(one)) {
        if (!(cmd in locations)) locations[cmd] = full;
      }
    }
    distributions.push({
      name,
      rootfs: root,
      scan_path: standardPath,
      ...summarize(locations),
    });
  }
  return { rootfs_base: base, installed_distributions: roots, distributions };
}


async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

function parseSkillFrontmatter(text) {
  const lines = String(text || '').split(/\r?\n/);
  if ((lines[0] || '').trim() !== '---') return {};
  const parsed = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '---') break;
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    parsed[match[1]] = value;
  }
  return parsed;
}

async function scanSkills(home) {
  const roots = [
    { kind: 'agents', directory: path.join(home, '.agents', 'skills') },
    { kind: 'codex', directory: path.join(home, '.codex', 'skills') },
  ];
  const lockFile = path.join(home, '.agents', '.skill-lock.json');
  const lock = await readJson(lockFile);
  const lockSkills = lock && typeof lock.skills === 'object' && lock.skills
    ? lock.skills
    : {};
  const byName = new Map();

  for (const root of roots) {
    let entries = [];
    try {
      entries = await fs.readdir(root.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillDir = path.join(root.directory, entry.name);
      const skillFile = path.join(skillDir, 'SKILL.md');
      let text = '';
      try {
        text = await fs.readFile(skillFile, 'utf8');
      } catch {
        continue;
      }
      const frontmatter = parseSkillFrontmatter(text);
      const name = String(frontmatter.name || entry.name);
      const locked = lockSkills[entry.name] || lockSkills[name] || {};
      const sourceMeta = await readJson(path.join(skillDir, '.skill-source.json')) || {};
      const current = byName.get(name) || {
        name,
        description: frontmatter.description || null,
        license: frontmatter.license || null,
        source: locked.source || sourceMeta.source || null,
        source_type: locked.sourceType || sourceMeta.source_type || sourceMeta.sourceType || null,
        source_url: locked.sourceUrl || sourceMeta.source_url || sourceMeta.sourceUrl || null,
        skill_path: locked.skillPath || sourceMeta.skill_path || sourceMeta.skillPath || null,
        plugin_name: locked.pluginName || sourceMeta.plugin_name || sourceMeta.pluginName || null,
        installed_at: locked.installedAt || sourceMeta.installed_at || sourceMeta.installedAt || null,
        updated_at: locked.updatedAt || sourceMeta.updated_at || sourceMeta.updatedAt || null,
        locations: [],
      };
      if (!current.description && frontmatter.description) current.description = frontmatter.description;
      if (!current.license && frontmatter.license) current.license = frontmatter.license;
      if (!current.source) current.source = locked.source || sourceMeta.source || null;
      if (!current.source_type) current.source_type = locked.sourceType || sourceMeta.source_type || sourceMeta.sourceType || null;
      if (!current.source_url) current.source_url = locked.sourceUrl || sourceMeta.source_url || sourceMeta.sourceUrl || null;
      if (!current.skill_path) current.skill_path = locked.skillPath || sourceMeta.skill_path || sourceMeta.skillPath || null;
      if (!current.plugin_name) current.plugin_name = locked.pluginName || sourceMeta.plugin_name || sourceMeta.pluginName || null;
      if (!current.installed_at) current.installed_at = locked.installedAt || sourceMeta.installed_at || sourceMeta.installedAt || null;
      if (!current.updated_at) current.updated_at = locked.updatedAt || sourceMeta.updated_at || sourceMeta.updatedAt || null;
      current.locations.push({
        kind: root.kind,
        directory: skillDir,
        skill_file: skillFile,
      });
      byName.set(name, current);
    }
  }

  const installed = [...byName.values()]
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    roots: roots.map((item) => item.directory),
    lock_file: fss.existsSync(lockFile) ? lockFile : null,
    installed_count: installed.length,
    installed,
  };
}

export async function detectCapabilities(options = {}) {
  const prefix = options.prefix || process.env.PREFIX || '/data/data/com.termux/files/usr';
  const home = options.home || process.env.HOME || '/data/data/com.termux/files/home';
  const pathValue = options.pathValue ?? process.env.PATH ?? '';
  const host = { kind: 'termux', home, prefix, ...(await scanHost(pathValue)) };
  return {
    schema: 'drive-worker-capabilities-v1',
    detected_at: new Date().toISOString(),
    host,
    programs: await buildProgramInventory(host.locations, {home,prefix}),
    proot: await scanProot(prefix),
    skills: await scanSkills(home),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  detectCapabilities()
    .then((value) => process.stdout.write(JSON.stringify(value, null, 2) + '\n'))
    .catch((error) => {
      console.error(error && error.stack ? error.stack : String(error));
      process.exitCode = 1;
    });
}
