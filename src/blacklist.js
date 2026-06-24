const fs = require('fs');
const path = require('path');

const BLACKLIST_FILE = process.env.SESSION_PATH
  ? path.join(process.env.SESSION_PATH, 'blacklist.json')
  : path.join(__dirname, '../blacklist.json');

let jids = new Set();

function load() {
  try {
    if (fs.existsSync(BLACKLIST_FILE)) {
      const data = JSON.parse(fs.readFileSync(BLACKLIST_FILE, 'utf8'));
      jids = new Set(data.jids || []);
    }
  } catch (e) {
    console.error('[blacklist] Error loading:', e.message);
  }
}

function save() {
  try {
    fs.writeFileSync(BLACKLIST_FILE, JSON.stringify({ jids: [...jids] }, null, 2));
  } catch (e) {
    console.error('[blacklist] Error saving:', e.message);
  }
}

function add(jid) {
  if (jids.has(jid)) return;
  jids.add(jid);
  save();
  console.log(`[blacklist] JID agregado (causó un logout al procesarlo): ${jid}`);
}

function has(jid) {
  return jids.has(jid);
}

load();

module.exports = { add, has };
