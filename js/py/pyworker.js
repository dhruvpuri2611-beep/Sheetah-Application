// Runs Python (Pyodide) off the page's main thread, so a loop that never ends can be stopped
// by ending this worker. The page sends jobs ({id, job: 'run'|'check'|'features', ...}) and gets JSON back.
const base = new URL('../../vendor/pyodide/', self.location).href;
let ready = null;
function boot() {
  if (!ready) ready = (async () => {
    importScripts(base + 'pyodide.js');
    const py = await loadPyodide({ indexURL: base, stdout: () => {}, stderr: () => {} });
    const src = await (await fetch(new URL('harness.py', self.location).href, { cache: 'no-cache' })).text();
    py.FS.writeFile('/sheetah_harness.py', src);
    py.runPython("import sys\nsys.path.insert(0, '/')\nimport sheetah_harness");
    return { py, api: py.globals.get('sheetah_harness').api };
  })();
  return ready;
}
// Extra libraries, loaded the first time a lab needs them (from vendor/pyodide, so no CDN is used).
// pandas, numpy and matplotlib come from Pyodide's own lock file (it fetches their dependencies too); openpyxl and et_xmlfile are plain-Python wheels unpacked into site-packages.
const WHEELS = { et_xmlfile: 'et_xmlfile-2.0.0-py3-none-any.whl', openpyxl: 'openpyxl-3.1.5-py2.py3-none-any.whl' };
const loaded = new Set();
async function prepare(py, wants) {
  const need = new Set(wants || []);
  if (need.has('openpyxl')) need.add('et_xmlfile');
  const lock = ['numpy', 'pandas', 'matplotlib'].filter(n => need.has(n) && !loaded.has(n));
  if (lock.length) { await py.loadPackage(lock, { messageCallback: () => {}, errorCallback: () => {} }); lock.forEach(n => loaded.add(n)); }
  for (const n of ['et_xmlfile', 'openpyxl']) if (need.has(n) && !loaded.has(n)) {
    const buf = await (await fetch(base + WHEELS[n])).arrayBuffer();
    py.unpackArchive(buf, 'wheel', { extractDir: py.runPython('import sysconfig; sysconfig.get_paths()["purelib"]') });
    loaded.add(n);
  }
  // import them now, so the first timed run doesn't pay for it
  const imp = [...need].filter(n => n !== 'et_xmlfile');
  if (imp.length) py.runPython(imp.map(n => n === 'matplotlib' ? "import os\nos.environ['MPLBACKEND'] = 'Agg'\nimport matplotlib\nmatplotlib.use('Agg')\nimport matplotlib.pyplot" : 'import ' + n).join('\n')); // pyplot's first import builds its font list: do it now
  return [...loaded];
}
self.onmessage = async e => {
  const { id, ...job } = e.data;
  try {
    const { py, api } = await boot();
    if (job.job === 'ping') { self.postMessage({ id, ok: true, result: { ready: true } }); return; }
    if (job.job === 'prepare') { self.postMessage({ id, ok: true, result: { loaded: await prepare(py, job.packages) } }); return; }
    self.postMessage({ id, ok: true, result: JSON.parse(api(JSON.stringify(job))) });
  } catch (err) { self.postMessage({ id, ok: false, error: String(err && err.message || err) }); }
};
