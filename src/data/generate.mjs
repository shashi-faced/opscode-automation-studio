// Test data for form fields: a rule per field (node.data) and a generator that makes a new,
// realistic value on every run. No dependencies; values come from a seeded random source so a
// run can be reproduced from its seed.

const FIRST = ['Aarav', 'Diya', 'Kabir', 'Meera', 'Rohan', 'Ananya', 'Vikram', 'Isha', 'Arjun', 'Priya', 'Liam', 'Emma', 'Noah', 'Olivia', 'Lucas', 'Sofia', 'Mateo', 'Hana', 'Yusuf', 'Zara', 'Ethan', 'Mia', 'Omar', 'Leah', 'Ravi', 'Nina', 'Sam', 'Tara', 'Ivan', 'Maya'];
const LAST = ['Sharma', 'Verma', 'Iyer', 'Kapoor', 'Nair', 'Reddy', 'Gupta', 'Singh', 'Patel', 'Mehta', 'Smith', 'Garcia', 'Chen', 'Kim', 'Novak', 'Rossi', 'Silva', 'Khan', 'Mori', 'Weber', 'Brown', 'Lopez', 'Das', 'Joshi', 'Bose', 'Ali', 'Costa', 'Berg', 'Dubois', 'Haddad'];
const COMPANY_A = ['Blue', 'North', 'Bright', 'Prime', 'Swift', 'Green', 'Silver', 'Urban', 'Nova', 'Summit', 'Coral', 'Delta'];
const COMPANY_B = ['Traders', 'Logistics', 'Foods', 'Systems', 'Retail', 'Labs', 'Industries', 'Supplies', 'Works', 'Partners'];
const STREETS = ['MG Road', 'Park Street', 'Lake View Road', 'Station Road', 'Hill Avenue', 'Church Lane', 'Market Street', 'Ring Road', 'Main Street', 'Oak Drive'];
const CITIES = ['Delhi', 'Mumbai', 'Bengaluru', 'Pune', 'Chennai', 'Hyderabad', 'Jaipur', 'Kochi', 'Lucknow', 'Indore', 'Austin', 'Berlin', 'Lisbon', 'Toronto'];
const WORDS = ['alpha', 'river', 'maple', 'orbit', 'pixel', 'cedar', 'harbor', 'falcon', 'quartz', 'meadow', 'ember', 'summit', 'willow', 'comet', 'lotus', 'atlas'];

export const DATA_KINDS = ['email', 'fullName', 'firstName', 'lastName', 'username', 'phone', 'number', 'date', 'company', 'street', 'city', 'zip', 'url', 'sentence', 'text', 'pattern'];
export const DATA_MODES = ['generate', 'fixed', 'list', 'any', 'secret'];

/** Seeded random source (mulberry32). */
export function makeRandom(seed = Date.now()) {
  let a = (Number(seed) >>> 0) || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min, max) => min + Math.floor(next() * (max - min + 1));
  const pick = (list) => list[Math.floor(next() * list.length)];
  const tag = (n = 4) => { let s = ''; for (let i = 0; i < n; i++) s += '0123456789abcdefghijkmnpqrstuvwxyz'[int(0, 33)]; return s; };
  return { next, int, pick, tag };
}

const lc = (s) => String(s || '').toLowerCase();
const digitsOnly = (s) => String(s || '').replace(/\D/g, '');

/** Re-roll every digit of a value, keeping its punctuation and a leading +country code. */
function rerollDigits(rng, value, { keepCountryCode = false } = {}) {
  const s = String(value);
  let i = 0;
  let skip = 0;
  if (keepCountryCode) {
    const m = s.match(/^\s*\+(\d{1,3})[\s-]/);
    if (m) skip = m[0].length;
  }
  let first = true;
  return s.replace(/\d/g, (d, pos) => {
    i++;
    if (pos < skip) return d;
    if (first) {
      first = false;
      // keep a mobile-looking first digit (6-9) or at least a non-zero one
      if (/[6-9]/.test(d)) return String(rng.int(6, 9));
      return String(rng.int(1, 9));
    }
    return String(rng.int(0, 9));
  });
}

function formatDate(d, sample) {
  const pad = (n) => String(n).padStart(2, '0');
  const y = d.getFullYear(), m = pad(d.getMonth() + 1), day = pad(d.getDate());
  const s = String(sample || '');
  let mm;
  if ((mm = s.match(/^\d{4}([-/.])\d{1,2}\1\d{1,2}/))) return `${y}${mm[1]}${m}${mm[1]}${day}`;
  if ((mm = s.match(/^(\d{1,2})([-/.])(\d{1,2})\2\d{4}/))) {
    // 13/02/2025 is day-first; 02/13/2025 is month-first; ambiguous -> day-first
    const monthFirst = Number(mm[3]) > 12 && Number(mm[1]) <= 12;
    return monthFirst ? `${m}${mm[2]}${day}${mm[2]}${y}` : `${day}${mm[2]}${m}${mm[2]}${y}`;
  }
  return `${y}-${m}-${day}`;
}

function fitLength(value, maxLength) {
  const s = String(value);
  return maxLength && maxLength > 0 && s.length > maxLength ? s.slice(0, maxLength) : s;
}

function fillPattern(rng, pattern, ctx) {
  return String(pattern).replace(/\{([a-zA-Z]+)(?::(\d+))?\}/g, (m, name, n) => {
    const k = name.toLowerCase();
    if (k === 'n' || k === 'digits') { const len = Number(n || 4); let s = String(rng.int(1, 9)); while (s.length < len) s += rng.int(0, 9); return s; }
    if (k === 'tag' || k === 'id') return rng.tag(Number(n || 4));
    if (k === 'run') return ctx.runTag;
    if (k === 'word') return rng.pick(WORDS);
    const kind = DATA_KINDS.find((x) => x.toLowerCase() === k);
    if (kind && kind !== 'pattern') return generateValue({ mode: 'generate', kind }, rng, { ...ctx, sample: '' });
    return m;
  });
}

/**
 * Make one value for a rule. `ctx.sample` is the recorded value (keeps formats and lengths),
 * `ctx.runTag` a short tag unique to the run, `ctx.maxLength` the field's limit.
 */
export function generateValue(rule, rng, ctx = {}) {
  const sample = ctx.sample ?? '';
  const runTag = ctx.runTag || rng.tag(4);
  const max = ctx.maxLength || rule.maxLength;
  if (rule.mode === 'list') {
    const values = Array.isArray(rule.values) && rule.values.length ? rule.values : [sample];
    return String(rng.pick(values));
  }
  if (rule.mode !== 'generate') return sample;
  const first = rng.pick(FIRST), last = rng.pick(LAST);
  let v;
  switch (rule.kind) {
    case 'email': {
      const domain = rule.domain || (String(sample).includes('@') && !/gmail|yahoo|outlook|hotmail/i.test(sample) ? String(sample).split('@')[1] : 'example.com');
      v = `${lc(first)}.${lc(last)}.${runTag}@${domain}`;
      break;
    }
    case 'fullName': v = `${first} ${last}`; break;
    case 'firstName': v = first; break;
    case 'lastName': v = last; break;
    case 'username': v = `${lc(first)}_${runTag}`; break;
    case 'phone': {
      v = digitsOnly(sample).length >= 7 ? rerollDigits(rng, sample, { keepCountryCode: true }) : `9${String(rng.int(100000000, 999999999))}`;
      break;
    }
    case 'zip': v = digitsOnly(sample).length >= 3 ? rerollDigits(rng, sample) : String(rng.int(110001, 855999)); break;
    case 'number': {
      const rec = Number(sample);
      const decimals = (String(sample).split('.')[1] || '').length;
      const lo = rule.min ?? (Number.isFinite(rec) && rec < 1 ? 0 : 1);
      const hi = rule.max ?? Math.max(5, Number.isFinite(rec) ? Math.ceil(rec * 2) : 100);
      v = decimals ? (lo + rng.next() * (hi - lo)).toFixed(decimals) : String(rng.int(lo, hi));
      break;
    }
    case 'date': {
      const now = new Date();
      const base = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
      let days;
      if (rule.range === 'birth') days = -rng.int(20 * 365, 60 * 365);
      else if (rule.range === 'past') days = -rng.int(1, 365);
      else days = rng.int(1, 60);
      const d = new Date(base.getTime() + days * 86400000);
      v = formatDate(new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()), sample);
      break;
    }
    case 'company': v = `${rng.pick(COMPANY_A)} ${rng.pick(COMPANY_B)} ${runTag.toUpperCase()}`; break;
    case 'street': v = `${rng.int(1, 999)} ${rng.pick(STREETS)}`; break;
    case 'city': v = rng.pick(CITIES); break;
    case 'url': v = `https://${rng.pick(WORDS)}-${runTag}.example.com`; break;
    case 'sentence': v = `QA ${runTag}: ${rng.pick(WORDS)} ${rng.pick(WORDS)} ${rng.pick(WORDS)} check by automation.`; break;
    case 'pattern': v = fillPattern(rng, rule.pattern || '{word} {tag}', { ...ctx, runTag }); break;
    case 'text':
    default: {
      const s = String(sample || '').trim();
      if (!s) v = `${rng.pick(WORDS)} ${runTag}`;
      else if (/\d/.test(s)) v = rerollDigits(rng, s);
      else v = `${s} ${runTag}`;
      if (max && v.length > max) v = s.length + 1 < max ? `${s.slice(0, max - runTag.length - 1)} ${runTag}` : runTag.slice(0, max);
    }
  }
  return fitLength(v, max);
}

// ---------------------------------------------------------------------------------------------
// Rules: suggested when a flow is saved, changed by the agent or the user.

const FIXED_FIELDS = /(search|filter|query|find|keyword|otp|one.?time|captcha|coupon|promo|voucher|verification|\bcode\b|\bpin\b)/i;

/** Field facts from a recorded step: its label, name, input type, autocomplete, max length. */
export function fieldInfo(step) {
  const ctx = step.selectorSet?.domContext || {};
  return {
    label: step.fieldName || ctx.label || '',
    name: ctx.name || '',
    type: lc(ctx.inputType || step.inputType || ''),
    autocomplete: lc(ctx.autocomplete || ''),
    maxLength: ctx.maxLength || step.maxLength || undefined,
    tag: lc(ctx.tag || ''),
    text: `${step.fieldName || ''} ${ctx.label || ''} ${ctx.name || ''} ${ctx.placeholder || ''} ${ctx.autocomplete || ''}`.toLowerCase(),
  };
}

function kindFor(info, value) {
  const t = info.text;
  const v = String(value ?? '');
  if (info.type === 'email' || /e-?mail/.test(t) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return ['email', 'an email field'];
  if (info.type === 'tel' || /phone|mobile|\btel\b|contact.?n/.test(t)) return ['phone', 'a phone field'];
  if (info.type === 'url' || /website|\burl\b|homepage/.test(t)) return ['url', 'a website field'];
  if (info.type === 'date' || /\bdate\b|\bdob\b|birth/.test(t) || /^\d{4}-\d{2}-\d{2}$|^\d{1,2}[/.-]\d{1,2}[/.-]\d{4}$/.test(v)) {
    return ['date', 'a date field'];
  }
  if (/zip|postal|post.?code|pin.?code|pincode/.test(t)) return ['zip', 'a postal code field'];
  if (/user.?name|login.?id|handle/.test(t)) return ['username', 'a username field'];
  if (/first.?name|given/.test(t)) return ['firstName', 'a first-name field'];
  if (/last.?name|surname|family/.test(t)) return ['lastName', 'a last-name field'];
  if (/company|organi[sz]ation|business|firm|vendor|supplier/.test(t)) return ['company', 'a company field'];
  if (/city|town/.test(t)) return ['city', 'a city field'];
  if (/address|street|line.?1/.test(t)) return ['street', 'an address field'];
  if (/\bname\b|full.?name|customer|contact|person/.test(t) && !/\d/.test(v)) return ['fullName', 'a name field'];
  if (info.type === 'number' || /^-?\d+(\.\d+)?$/.test(v)) return ['number', 'a number field'];
  if (info.tag === 'textarea' || /description|note|comment|remark|message|detail/.test(t)) return ['sentence', 'a free-text field'];
  return ['text', 'text field: recorded value plus a unique tag'];
}

/** Suggest a rule for one fill/select step. `signInPages` lists page patterns that hold a sign-in form. */
export function suggestRule(step, { signInPage = false } = {}) {
  const info = fieldInfo(step);
  const value = step.value;
  if (step.action === 'select') return { mode: 'fixed', why: 'option kept as recorded (set mode "any" for a random option)', source: 'auto' };
  if (/^\{\{secret:[^}]+\}\}$/.test(String(value || '')) || step.sensitive) return { mode: 'secret', why: 'password or secret', source: 'auto' };
  if (/^\{\{input:[^}]+\}\}$/.test(String(value || ''))) return { mode: 'fixed', why: 'given as a run input', source: 'auto' };
  if (signInPage) return { mode: 'fixed', why: 'sign-in form: must match an existing account', source: 'auto' };
  if (FIXED_FIELDS.test(info.text)) return { mode: 'fixed', why: 'search/code field: kept as recorded', source: 'auto' };
  if (value == null || value === '') return { mode: 'fixed', why: 'empty value', source: 'auto' };
  const [kind, why] = kindFor(info, value);
  const rule = { mode: 'generate', kind, why: `${why}: new value every run`, source: 'auto' };
  if (kind === 'date' && /birth|dob/.test(info.text)) rule.range = 'birth';
  if (info.maxLength) rule.maxLength = info.maxLength;
  return rule;
}

/** Page key for grouping fields of one form. */
function pageKey(step) {
  try {
    const u = new URL(step.page?.url || '');
    return u.host + u.pathname;
  } catch {
    return String(step.page?.url || '');
  }
}

/**
 * Add a data rule to every fill/select node that has none. Returns the flow (changed in place).
 * A page with a password field, at most two other fields and no "confirm" field is a sign-in form.
 */
export function applyDataRules(flow) {
  const steps = flow.steps || [];
  const byPage = new Map();
  for (const s of steps) {
    if (s.action !== 'fill') continue;
    const k = pageKey(s);
    if (!byPage.has(k)) byPage.set(k, []);
    byPage.get(k).push(s);
  }
  const signIn = new Set();
  for (const [k, fills] of byPage) {
    const secret = fills.filter((s) => s.sensitive || /\{\{secret:/.test(String(s.value || '')));
    const others = fills.filter((s) => !secret.includes(s));
    const confirm = fills.some((s) => /confirm|repeat|re-?type|again/i.test(fieldInfo(s).text));
    if (secret.length && others.length <= 2 && !confirm) signIn.add(k);
  }
  for (const s of steps) {
    if (s.action !== 'fill' && s.action !== 'select') continue;
    if (s.data && s.data.mode) continue;
    s.data = suggestRule(s, { signInPage: signIn.has(pageKey(s)) });
  }
  return flow;
}

/** Normalise a rule given by the agent or the app: "fixed", "email", or an object. */
export function normalizeRule(input, current = {}) {
  if (input == null) return null;
  if (typeof input === 'string') {
    const s = input.trim();
    if (DATA_MODES.includes(s)) return { mode: s, source: 'ai' };
    const kind = DATA_KINDS.find((k) => k.toLowerCase() === s.toLowerCase());
    if (kind) return { mode: 'generate', kind, source: 'ai' };
    if (/\{[a-zA-Z]+(:\d+)?\}/.test(s)) return { mode: 'generate', kind: 'pattern', pattern: s, source: 'ai' };
    throw new Error(`Unknown data rule "${input}". Use a mode (${DATA_MODES.join(', ')}), a kind (${DATA_KINDS.join(', ')}) or a pattern like "ORD-{n:5}".`);
  }
  const rule = { ...current, ...input };
  if (rule.values != null && !Array.isArray(rule.values)) rule.values = [rule.values];
  if (!input.mode) rule.mode = Array.isArray(input.values) || (input.values != null) ? 'list' : input.kind || input.pattern ? 'generate' : rule.mode || 'fixed';
  if (rule.pattern && !rule.kind) rule.kind = 'pattern';
  if (!DATA_MODES.includes(rule.mode)) throw new Error(`Unknown data mode "${rule.mode}".`);
  if (rule.mode === 'generate' && !DATA_KINDS.includes(rule.kind)) rule.kind = 'text';
  rule.source = input.source || 'ai';
  return rule;
}

/** One-line text of a rule for the graph and tool results. */
export function describeRule(rule) {
  if (!rule || !rule.mode) return 'recorded value';
  if (rule.mode === 'generate') return `new ${rule.kind === 'pattern' ? `"${rule.pattern}"` : rule.kind} each run`;
  if (rule.mode === 'list') return `one of ${(rule.values || []).length} values`;
  if (rule.mode === 'any') return 'any option';
  if (rule.mode === 'secret') return 'secret';
  return 'fixed (recorded value)';
}
