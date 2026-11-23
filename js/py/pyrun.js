// The page's side of the Python labs: one worker, started on first use and kept warm.
// A job that runs too long ends the worker (a loop that never stops can't freeze the page) and a fresh one starts.
const listeners = new Set();
let worker = null, seq = 0, warm = false, loading = null;
const pending = new Map();
export const pyStatus = { state: 'idle' }; // idle | loading | ready | error
const emit = () => listeners.forEach(f => { try { f(pyStatus.state); } catch (e) { } });
export const onPyStatus = fn => { listeners.add(fn); fn(pyStatus.state); return () => listeners.delete(fn); };
function spawn() {
  worker = new Worker(new URL('./pyworker.js', import.meta.url));
  worker.onmessage = e => { const p = pending.get(e.data.id); if (!p) return; pending.delete(e.data.id); clearTimeout(p.t); e.data.ok ? p.res(e.data.result) : p.rej(new Error(e.data.error)); };
  worker.onerror = e => { for (const [, p] of pending) { clearTimeout(p.t); p.rej(new Error('Python stopped: ' + (e.message || 'unknown error'))); } pending.clear(); };
  warm = false;
}
function send(job, ms) {
  if (!worker) spawn();
  const id = ++seq;
  return new Promise((res, rej) => {
    const t = setTimeout(() => { pending.delete(id); kill(); res({ timeout: true }); }, ms);
    pending.set(id, { res, rej, t }); worker.postMessage({ id, ...job });
  });
}
function kill() { if (worker) worker.terminate(); worker = null; warm = false; loading = null; have = new Set(); for (const [, p] of pending) { clearTimeout(p.t); p.res({ timeout: true }); } pending.clear(); pyStatus.state = 'idle'; emit(); }
// Load Python (about 12 MB the first time, then from the browser's cache). Safe to call many times.
export function pyReady() {
  if (warm) return Promise.resolve(true);
  if (!loading) { pyStatus.state = 'loading'; emit();
    loading = send({ job: 'ping' }, 120000).then(r => { if (r && r.timeout) throw new Error('Python took too long to load. Check the internet connection and try again.'); warm = true; pyStatus.state = 'ready'; emit(); return true; })
      .catch(e => { loading = null; pyStatus.state = 'error'; pyStatus.error = e.message; emit(); throw e; }); }
  return loading;
}
// Libraries a program needs beyond plain Python (pandas, openpyxl): found from its imports and the files it works on.
// They load once per worker, before the timed run, with a long timeout of their own.
let have = new Set();
// matplotlib (about 9 MB) loads only for a program that draws a chart.
export function packagesFor(code = '', files = null) {
  const s = String(code || ''), need = new Set();
  if (/^\s*(import|from)\s+pandas\b/m.test(s)) { need.add('pandas'); need.add('numpy'); if (/read_excel|to_excel|ExcelWriter|ExcelFile/.test(s) || hasXlsx(files)) need.add('openpyxl'); }
  if (/^\s*(import|from)\s+numpy\b/m.test(s)) need.add('numpy');
  if (/^\s*(import|from)\s+matplotlib\b/m.test(s) || (need.has('pandas') && /\.(plot|hist)\s*[.(]/.test(s))) { need.add('matplotlib'); need.add('numpy'); }
  if (/^\s*(import|from)\s+openpyxl\b/m.test(s) || hasXlsx(files)) need.add('openpyxl');
  return [...need];
}
const hasXlsx = files => !!files && Object.keys(files).some(n => /\.xlsx$/i.test(n));
export const needsLoading = pk => pk.some(n => !have.has(n));
export async function pyPrepare(packages) {
  await pyReady(); if (!packages || !packages.length || !needsLoading(packages)) return true;
  pyStatus.state = 'loading'; pyStatus.what = packages.filter(n => n !== 'numpy').join(' and '); emit();
  const r = await send({ job: 'prepare', packages }, 180000);
  if (r && r.timeout) { pyStatus.state = 'error'; pyStatus.error = 'Loading ' + pyStatus.what + ' took too long. Check the internet connection and try again.'; emit(); throw new Error(pyStatus.error); }
  r.loaded.forEach(n => have.add(n)); pyStatus.state = 'ready'; pyStatus.what = ''; emit(); return true;
}
const TIMEOUT = 8000;
const timedOut = () => ({ out: '', err: { type: 'Timeout', msg: 'The program ran for more than 8 seconds, so Sheetah stopped it. A loop that never ends is the usual cause.', line: null, text: '', tb: '' }, files: {}, features: [] });
export async function runPy(code, { stdin = [], trace = false, files = null, maxTrace = 600, seed = null } = {}) {
  await pyPrepare(packagesFor(code, files)); const r = await send({ job: 'run', code, stdin, trace, files, maxTrace, seed }, TIMEOUT); return r.timeout ? timedOut() : r;
}
export async function checkPy(code, model, cases, opts = {}) {
  await pyPrepare([...new Set([...packagesFor(code), ...packagesFor(model, (cases || []).reduce((a, c) => Object.assign(a, c.files || {}), {}))])]); const r = await send({ job: 'check', code, model, cases, opts }, TIMEOUT * Math.max(1, (cases || []).length)); return r.timeout ? { ok: false, cases: [{ ok: false, problems: ['error'], err: timedOut().err }], features: [] } : r;
}
export async function previewPy(b64) { await pyPrepare(['openpyxl']); const r = await send({ job: 'preview', b64 }, 15000); return r.timeout ? { error: 'Took too long to open.' } : r; }
export async function featuresPy(code) { await pyReady(); const r = await send({ job: 'features', code }, 4000); return r.timeout ? { ok: false, f: [] } : r; }
export async function explainPy(code, n = 3) { await pyReady(); const r = await send({ job: 'explain', code, n }, 6000); return r.timeout ? [] : r; }
