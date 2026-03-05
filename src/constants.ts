export const URI_SCHEME = 'multi-claude-git';

export const CLAUDE_DIR = '.claude';
export const ATTRIBUTION_LOG = '.claude/file-attribution.jsonl';
export const SESSION_NAMES_FILE = '.claude/session-names.json';
export const STAGED_FILES_PATH = '.claude/staged-files.json';
export const HOOK_SCRIPT_PATH = '.claude/hooks/log-attribution.sh';
export const SETTINGS_LOCAL_PATH = '.claude/settings.local.json';

export const NAME_POOL = [
    'Rainbow', 'Falcon', 'Aurora', 'Comet', 'Phoenix',
    'Nebula', 'Horizon', 'Cascade', 'Prism', 'Zenith',
    'Ember', 'Quasar', 'Riptide', 'Solstice', 'Tempest',
    'Vortex', 'Zephyr', 'Orbit', 'Spectra', 'Glacier',
];

export const DEBOUNCE_MS = 300;

export const HOOK_SCRIPT = `#!/bin/bash
node -e "
  let c=[];
  process.stdin.on('data',d=>c.push(d));
  process.stdin.on('end',()=>{
    const d=JSON.parse(Buffer.concat(c).toString());
    if(!d.tool_input||!d.tool_input.file_path)process.exit(0);
    const l=JSON.stringify({session_id:d.session_id,file_path:d.tool_input.file_path,tool_name:d.tool_name,timestamp:Date.now()});
    require('fs').appendFileSync(require('path').join(d.cwd,'.claude','file-attribution.jsonl'),l+'\\\\n');
  });
"
`;
