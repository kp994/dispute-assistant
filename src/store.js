// Tiny JSON-file store. On hosts with an ephemeral disk (Render free tier) the
// file disappears on restart, so we re-seed the demo cases whenever it is missing.

const fs = require("fs");
const path = require("path");

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "..", "data", "cases.json");
const SEED_FILE = path.join(__dirname, "..", "seed", "cases.json");

let cases = null;

function load() {
  if (cases) return cases;
  if (fs.existsSync(DATA_FILE)) {
    cases = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } else {
    cases = seed();
    save();
  }
  return cases;
}

function save() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cases, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// Seed dates are written relative to now ("@-3d", "@+30h") so deadlines stay live.
function seed() {
  const raw = JSON.parse(fs.readFileSync(SEED_FILE, "utf8"));
  const now = Date.now();
  const resolve = (v) => {
    if (typeof v === "string") {
      const m = /^@([+-]\d+(?:\.\d+)?)([dh])$/.exec(v);
      if (m) return new Date(now + Number(m[1]) * (m[2] === "d" ? 864e5 : 36e5)).toISOString();
      return v;
    }
    if (Array.isArray(v)) return v.map(resolve);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]));
    return v;
  };
  return raw.map((c) => ({ source: "demo", status: "OPEN", audit: [], ...resolve(c) }));
}

const all = () => load();
const get = (id) => load().find((c) => c.id === id);

function upsert(c) {
  const list = load();
  const i = list.findIndex((x) => x.id === c.id);
  if (i >= 0) list[i] = c;
  else list.push(c);
  save();
  return c;
}

function update(id, fn) {
  const c = get(id);
  if (!c) return null;
  fn(c);
  save();
  return c;
}

function resetDemo() {
  const live = load().filter((c) => c.source === "paypal");
  cases = [...seed(), ...live];
  save();
}

module.exports = { all, get, upsert, update, resetDemo };
