// A small Python code editor: a textarea laid over highlighted code, with line numbers,
// 4-space indents (Tab, Shift+Tab, and Enter after a colon), Ctrl+Enter to run, and line marks for errors and step-through.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KW = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'match', 'case']);
const BI = new Set(['print', 'input', 'int', 'float', 'str', 'len', 'range', 'list', 'dict', 'set', 'tuple', 'bool', 'type', 'round', 'sum', 'min', 'max', 'abs', 'sorted', 'enumerate', 'zip', 'open', 'isinstance', 'reversed', 'any', 'all', 'map', 'filter']);
// one line of Python as highlighted HTML (strings, comments, keywords, built-ins, numbers)
export function pyHL(line) {
  let out = '', i = 0; const s = String(line);
  while (i < s.length) {
    const ch = s[i];
    if (ch === '#') { out += `<span class="pc">${esc(s.slice(i))}</span>`; break; }
    const sm = /^(?:[fFrRbB]{1,2})?("""|'''|"|')/.exec(s.slice(i));
    if (sm && (sm.index === 0) && (sm[0].length === sm[1].length || /[A-Za-z_]/.test(s[i]) && !/[A-Za-z0-9_]/.test(s[i - 1] || ''))) {
      const q = sm[1]; let j = i + sm[0].length; while (j < s.length && s.slice(j, j + q.length) !== q) { if (s[j] === '\\') j++; j++; }
      const str = s.slice(i, Math.min(s.length, j + q.length)); const isF = /^[fF]/.test(sm[0]);
      out += isF ? `<span class="ps">${esc(str).replace(/\{([^}]*)\}/g, '<span class="pf">{$1}</span>')}</span>` : `<span class="ps">${esc(str)}</span>`; i += str.length; continue;
    }
    const w = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
    if (w) { const t = w[0]; const next = s.slice(i + t.length).trimStart()[0]; out += KW.has(t) ? `<span class="pk">${t}</span>` : BI.has(t) && next === '(' ? `<span class="pb">${t}</span>` : next === '(' ? `<span class="pfn">${t}</span>` : esc(t); i += t.length; continue; }
    const n = /^\d[\d_]*(\.\d+)?/.exec(s.slice(i)); if (n) { out += `<span class="pd">${n[0]}</span>`; i += n[0].length; continue; }
    out += esc(ch); i++;
  }
  return out;
}
export const pyBlock = (code, { marks = {}, numbers = true } = {}) => `<pre class="pyblock">${String(code).split('\n').map((l, k) => `<div class="pyl ${marks[k + 1] || ''}">${numbers ? `<span class="pyn">${k + 1}</span>` : ''}<span class="pyc">${pyHL(l) || ' '}</span></div>`).join('')}</pre>`;

export class PyEditor {
  constructor(host, { code = '', onChange, onRun, readOnly = false, minLines = 6, label = 'Python code' } = {}) {
    this.host = host; this.onChange = onChange; this.onRun = onRun; this.marks = {};
    host.classList.add('pyed'); host.innerHTML = `<div class="pyed-gut" aria-hidden="true"></div><div class="pyed-main"><pre class="pyed-hl" aria-hidden="true"></pre><textarea class="pyed-ta" wrap="off" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" aria-label="${esc(label)}" ${readOnly ? 'readonly' : ''}></textarea></div>`;
    this.ta = host.querySelector('textarea'); this.hl = host.querySelector('.pyed-hl'); this.gut = host.querySelector('.pyed-gut'); this.minLines = minLines;
    this.ta.value = code; this.paint();
    this.ta.addEventListener('input', () => { this.marks = {}; this.paint(); this.onChange && this.onChange(this.ta.value); });
    this.ta.addEventListener('scroll', () => { this.hl.scrollTop = this.ta.scrollTop; this.hl.scrollLeft = this.ta.scrollLeft; this.gut.scrollTop = this.ta.scrollTop; });
    this.ta.addEventListener('keydown', e => this.key(e));
  }
  get value() { return this.ta.value; }
  set value(v) { this.ta.value = v; this.marks = {}; this.paint(); }
  mark(line, cls) { this.marks = {}; if (line) this.marks[line] = cls; this.paint(); if (line) this.scrollTo(line); }
  scrollTo(line) { const lh = parseFloat(getComputedStyle(this.ta).lineHeight) || 21; const y = (line - 1) * lh; if (y < this.ta.scrollTop || y > this.ta.scrollTop + this.ta.clientHeight - lh * 2) this.ta.scrollTop = Math.max(0, y - lh * 2); }
  paint() {
    const lines = this.ta.value.split('\n'); const n = Math.max(lines.length, this.minLines);
    this.hl.innerHTML = lines.map((l, k) => `<div class="pyl ${this.marks[k + 1] || ''}">${pyHL(l) || ' '}</div>`).join('') + '<div> </div>';
    this.gut.innerHTML = Array.from({ length: n }, (_, k) => `<div class="${this.marks[k + 1] || ''}">${k + 1}</div>`).join('');
    this.ta.style.height = 'auto'; this.ta.rows = n; this.host.style.setProperty('--rows', n);
  }
  edit(fn) { const ta = this.ta; const v = ta.value, a = ta.selectionStart, b = ta.selectionEnd; const r = fn(v, a, b); ta.value = r[0]; ta.selectionStart = r[1]; ta.selectionEnd = r[2]; this.marks = {}; this.paint(); this.onChange && this.onChange(ta.value); }
  key(e) {
    if (this.ta.readOnly) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); this.onRun && this.onRun(); return; }
    if (e.key === 'Escape') { this.ta.blur(); return; } // so keyboard users can Tab out of the editor
    if (e.key === 'Tab') {
      e.preventDefault();
      this.edit((v, a, b) => {
        const ls = v.lastIndexOf('\n', a - 1) + 1; const multi = v.slice(a, b).includes('\n');
        if (!multi && !e.shiftKey) return [v.slice(0, a) + '    ' + v.slice(b), a + 4, a + 4];
        const le = b; const block = v.slice(ls, le); const lines = block.split('\n');
        const out = lines.map(l => e.shiftKey ? l.replace(/^ {1,4}/, '') : '    ' + l).join('\n'); const d0 = e.shiftKey ? (lines[0].match(/^ {0,4}/)[0].length * -1) : 4;
        return [v.slice(0, ls) + out + v.slice(le), Math.max(ls, a + d0), ls + out.length];
      }); return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      this.edit((v, a, b) => { const ls = v.lastIndexOf('\n', a - 1) + 1; const cur = v.slice(ls, a); let ind = cur.match(/^ */)[0]; if (/:\s*(#.*)?$/.test(cur)) ind += '    '; if (/^\s*(return|break|continue|pass)\b/.test(cur)) ind = ind.slice(4); const ins = '\n' + ind; return [v.slice(0, a) + ins + v.slice(b), a + ins.length, a + ins.length]; });
      return;
    }
    if (e.key === 'Backspace' && this.ta.selectionStart === this.ta.selectionEnd) {
      const v = this.ta.value, a = this.ta.selectionStart; const ls = v.lastIndexOf('\n', a - 1) + 1; const before = v.slice(ls, a);
      if (before.length && /^ +$/.test(before)) { e.preventDefault(); const k = before.length % 4 || 4; this.edit((v2, a2) => [v2.slice(0, a2 - k) + v2.slice(a2), a2 - k, a2 - k]); }
    }
  }
  focus() { this.ta.focus(); }
}

// The lab's folder: the files a program can open, shown as small cards. `changed` names files the last run created or changed.
// ---------- files in the lab's folder: text files as text, Excel workbooks as sheets ----------
export const isBin = v => !!v && typeof v === 'object';
const previews = new Map(); // b64 -> preview, filled from content and from each run, so a stored file needs no Python to show
export function rememberPreviews(files) { for (const v of Object.values(files || {})) if (isBin(v) && v.preview && v.b64) previews.set(v.b64, v.preview); return files; }
// what gets saved: the bytes only (a preview is redrawn from the cache, or after the next run)
export const stripPreviews = files => { rememberPreviews(files); const o = {}; for (const [k, v] of Object.entries(files || {})) o[k] = isBin(v) ? { b64: v.b64, size: v.size } : v; return o; };
export const previewOf = v => isBin(v) ? (v.preview || previews.get(v.b64) || null) : null;
const colName = c => { let s = ''; while (c) { const r = (c - 1) % 26; s = String.fromCharCode(65 + r) + s; c = Math.floor((c - 1) / 26); } return s; };
// a few common Excel number formats, so 1234.5 with "#,##0.00" shows as Excel would show it
function shown(v, nf) {
  if (!nf || v === '' || isNaN(+v) || /^=/.test(v)) return v;
  const n = +v; const pct = /%/.test(nf); const dec = (/0\.(0+)/.exec(nf) || [, ''])[1].length; const x = pct ? n * 100 : n;
  let t = /#,##0|,0/.test(nf) ? x.toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec }) : x.toFixed(dec);
  const cur = (/^[^#0]*?([₹$€£])/.exec(nf) || [])[1] || '';
  return cur + t + (pct ? '%' : '');
}
// charts and colour rules: drawn from what the workbook really holds, the way Excel would show them
const XLC = ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47'];
const fmtN = n => Math.abs(n) >= 1000 ? Math.round(n).toLocaleString('en-IN') : String(Math.round(n * 100) / 100);
function chartSVG(ch) {
  const ser = (ch.series || []).filter(s => (s.v || []).length); if (!ser.length) return '<p class="muted small">(no data in this chart)</p>';
  const cats = ser[0].c && ser[0].c.length ? ser[0].c : ser[0].v.map((_, i) => String(i + 1)); const n = cats.length;
  const W = 340, H = 190, L = 44, B = 34, T = 8, R = 8;
  if (ch.kind === 'pie' || ch.kind === 'doughnut') {
    const vals = ser[0].v.map(v => Math.max(0, v || 0)); const tot = vals.reduce((a, b) => a + b, 0) || 1; let a0 = -Math.PI / 2; const cx = 95, cy = 95, r = 80;
    const sl = vals.map((v, i) => { const a1 = a0 + 2 * Math.PI * v / tot; const big = a1 - a0 > Math.PI ? 1 : 0; const d = v / tot >= 0.9999 ? `M${cx} ${cy - r}A${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r}Z` : `M${cx} ${cy}L${cx + r * Math.cos(a0)} ${cy + r * Math.sin(a0)}A${r} ${r} 0 ${big} 1 ${cx + r * Math.cos(a1)} ${cy + r * Math.sin(a1)}Z`; a0 = a1; return `<path d="${d}" fill="${XLC[i % 6]}" stroke="var(--sheet)" stroke-width="1"/>`; }).join('');
    const leg = cats.slice(0, 9).map((c, i) => `<rect x="200" y="${14 + i * 18}" width="10" height="10" fill="${XLC[i % 6]}"/><text x="215" y="${23 + i * 18}">${esc(String(c).slice(0, 14))} · ${Math.round(vals[i] / tot * 100)}%</text>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" class="xlchart-svg" role="img" aria-label="Pie chart">${sl}${ch.kind === 'doughnut' ? `<circle cx="${cx}" cy="${cy}" r="40" fill="var(--sheet)"/>` : ''}${leg}</svg>`;
  }
  const all = ser.flatMap(s => s.v.filter(v => v != null)); const mx = Math.max(0, ...all), mn = Math.min(0, ...all); const span = (mx - mn) || 1;
  const across = ch.dir === 'across' && ch.kind === 'bar';
  if (across) {
    const ph = (H - T - 10) / n, bw = ph * 0.7 / ser.length, x0 = 70, pw = W - x0 - 40;
    const bars = ser.map((s, k) => s.v.map((v, i) => v == null ? '' : `<rect x="${x0}" y="${T + i * ph + ph * 0.15 + k * bw}" width="${Math.max(0, (v - 0) / span * pw)}" height="${bw}" fill="${XLC[k % 6]}"/>`).join('')).join('');
    const lab = cats.map((c, i) => `<text x="${x0 - 4}" y="${T + i * ph + ph / 2 + 4}" text-anchor="end">${esc(String(c).slice(0, 10))}</text>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" class="xlchart-svg" role="img" aria-label="Bar chart">${bars}${lab}<line x1="${x0}" y1="${T}" x2="${x0}" y2="${H - 10}" class="ax"/></svg>`;
  }
  const pw = W - L - R, ph = H - T - B, y = v => T + ph - (v - mn) / span * ph, step = pw / n;
  const ticks = [mn, mn + span / 2, mx].map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 4}" y="${y(v) + 4}" text-anchor="end">${fmtN(v)}</text>`).join('');
  let body = '';
  if (ch.kind === 'line' || ch.kind === 'scatter' || ch.kind === 'area') body = ser.map((s, k) => { const pts = s.v.map((v, i) => v == null ? null : [L + step * (i + 0.5), y(v)]).filter(Boolean); return `<polyline points="${pts.map(p => p.join(',')).join(' ')}" fill="none" stroke="${XLC[k % 6]}" stroke-width="2.5"/>${pts.map(p => `<circle cx="${p[0]}" cy="${p[1]}" r="3" fill="${XLC[k % 6]}"/>`).join('')}`; }).join('');
  else { const bw = step * 0.7 / ser.length; body = ser.map((s, k) => s.v.map((v, i) => v == null ? '' : `<rect x="${L + step * i + step * 0.15 + k * bw}" y="${Math.min(y(v), y(0))}" width="${bw}" height="${Math.abs(y(v) - y(0))}" fill="${XLC[k % 6]}"/>`).join('')).join(''); }
  const lab = cats.map((c, i) => n <= 12 ? `<text x="${L + step * (i + 0.5)}" y="${H - B + 14}" text-anchor="middle">${esc(String(c).slice(0, n > 6 ? 5 : 10))}</text>` : '').join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="xlchart-svg" role="img" aria-label="${esc(ch.kind)} chart">${ticks}${body}<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" class="ax"/>${lab}</svg>`;
}
function extrasHTML(sh) {
  const charts = (sh.charts || []).map(ch => `<figure class="xlchart"><figcaption><b>${esc(ch.title || '(no title)')}</b> <span class="muted small">${esc(ch.kind)} chart${ch.at ? ' at ' + esc(ch.at) : ''} · data ${esc((ch.series || []).map(s => s.vals).join(', '))}${ch.series && ch.series[0] && ch.series[0].cats ? ', labels ' + esc(ch.series[0].cats) : ''}</span></figcaption>${chartSVG(ch)}${(ch.series || []).length > 1 ? `<p class="small">${ch.series.map((s, k) => `<span class="xlkey" style="background:${XLC[k % 6]}"></span>${esc(s.name || 'Series ' + (k + 1))}`).join(' ')}</p>` : ''}</figure>`).join('');
  const cf = (sh.cf || []).length ? `<p class="small xlcf">🎨 Colour rule${sh.cf.length > 1 ? 's' : ''}: ${sh.cf.map(r => `${esc(r.say)}${r.bg ? ` <span class="xlkey" style="background:#${esc(r.bg)}"></span>` : ''}`).join('; ')}</p>` : '';
  const fr = sh.freeze ? `<p class="small muted">❄ Frozen above and left of ${esc(sh.freeze)}</p>` : '';
  return cf + fr + charts;
}
let bookSeq = 0;
export function workbookHTML(pv, { marks = [] } = {}) {
  if (!pv) return '<p class="muted small">Run the program to see inside this workbook.</p>';
  if (pv.error) return `<p class="muted small">${esc(pv.error)}</p>`;
  const id = 'xb' + (++bookSeq); let act = Math.min(pv.active || 0, pv.sheets.length - 1);
  const mk = new Set(marks);
  const firstMarked = (marks.find(m => m.includes('!')) || '').split('!')[0]; /* open the sheet the first difference is on */
  if (firstMarked && !marks.some(m => !m.includes('!'))) { const k = pv.sheets.findIndex(sh => sh.name === firstMarked); if (k >= 0) act = k; }
  return `<div class="xlbook">${pv.sheets.map((sh, i) => `<input type="radio" class="xlr" name="${id}" id="${id}-${i}" ${i === act ? 'checked' : ''}>`).join('')}
  <div class="xlpanes">${pv.sheets.map(sh => { const nc = Math.max(1, ...sh.rows.map(r => r.length)); return `<div class="xlpane"><div class="xlscroll"><table class="xlgrid"><thead><tr><th></th>${Array.from({ length: nc }, (_, c) => `<th style="${sh.widths && sh.widths[colName(c + 1)] ? `min-width:${Math.round(sh.widths[colName(c + 1)] * 7)}px` : ''}">${colName(c + 1)}</th>`).join('')}</tr></thead><tbody>${sh.rows.length ? sh.rows.map((r, ri) => `<tr><th>${ri + 1}</th>${Array.from({ length: nc }, (_, c) => { const v = r[c] ?? ''; const f = (sh.fmt || {})[`${ri + 1},${c + 1}`] || {}; const ref = colName(c + 1) + (ri + 1); const isF = /^=/.test(v); const num = v !== '' && !isNaN(+v); return `<td class="${isF ? 'xlf' : ''} ${num ? 'xln' : ''} ${f.b ? 'xlb' : ''} ${mk.has(sh.name + '!' + ref) || mk.has(ref) ? 'xlmark' : ''}" ${f.bg ? `style="background:#${esc(f.bg)}"` : ''} title="${esc(ref + (isF ? ' · a formula: Excel works it out when the file is opened' : f.nf ? ' · format ' + f.nf : ''))}">${esc(shown(v, f.nf))}</td>`; }).join('')}</tr>`).join('') : `<tr><th>1</th><td class="muted small">(empty sheet)</td></tr>`}</tbody></table></div>${sh.maxRow > sh.rows.length || sh.maxCol > nc ? `<p class="muted small">Showing ${sh.rows.length} of ${sh.maxRow} rows${sh.maxCol > nc ? ` and ${nc} of ${sh.maxCol} columns` : ''}.</p>` : ''}${extrasHTML(sh)}</div>`; }).join('')}</div>
  <div class="xltabs">${pv.sheets.map((sh, i) => `<label for="${id}-${i}">${esc(sh.name)}</label>`).join('')}</div></div>`;
}
const fileLines = t => String(t).split('\n').filter(Boolean).length;
const sizeText = n => n >= 1024 ? Math.round(n / 1024) + ' KB' : (n || 0) + ' bytes';
// a CSV file shows as a table (the way Excel would open it), with the plain text a click away
export function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
    if (ch === '"') q = true; else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
function csvHTML(text, max = 40) {
  const rows = parseCSV(text || ''); if (!rows.length) return '<pre class="pyout"> </pre>';
  const nc = Math.max(...rows.map(r => r.length)); const shown = rows.slice(0, max + 1); const num = v => v !== '' && !isNaN(+v);
  return `<div class="xlscroll csvgrid"><table class="xlgrid"><thead><tr><th></th>${Array.from({ length: nc }, (_, c) => `<th>${colName(c + 1)}</th>`).join('')}</tr></thead><tbody>${shown.map((r, ri) => `<tr><th>${ri + 1}</th>${Array.from({ length: nc }, (_, c) => { const v = r[c] ?? ''; return `<td class="${ri === 0 ? 'xlb' : num(v) ? 'xln' : ''}">${esc(v)}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>${rows.length > shown.length ? `<p class="muted small csvmore">… and ${rows.length - shown.length} more row${rows.length - shown.length === 1 ? '' : 's'}</p>` : ''}<details class="csvtext"><summary class="small">As plain text</summary><pre class="pyout">${esc(text)}</pre></details>`;
}
// A web page a program wrote, shown as a browser would (no scripts run), with its pictures taken from the folder.
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml' };
function pageSrc(html, all) {
  return String(html || '').replace(/(<img\b[^>]*?\bsrc\s*=\s*)(["'])([^"']+)\2/gi, (m, a, q, src) => { const f = all && all[src]; const ext = (src.split('.').pop() || '').toLowerCase();
    if (isBin(f) && f.b64 && MIME[ext]) return `${a}${q}data:${MIME[ext]};base64,${f.b64}${q}`; if (typeof f === 'string' && ext === 'svg') return `${a}${q}data:image/svg+xml;charset=utf-8,${encodeURIComponent(f)}${q}`; return m; });
}
export function pageHTML(html, all, title = 'The web page') {
  return `<iframe class="pypage" sandbox="" referrerpolicy="no-referrer" srcdoc="${esc('<style>img{max-width:100%;height:auto}</style>' + pageSrc(html, all))}" title="${esc(title)}"></iframe>`;
}
export function fileHTML(n, v, { open = true, changed = false, marks, all } = {}) {
  if (/\.html?$/i.test(n) && typeof v === 'string') return `<details class="pyfile ${changed ? 'chg' : ''}" ${open ? 'open' : ''}><summary>🌐 <b>${esc(n)}</b>${changed ? ' <span class="tag">just written</span>' : ''} <span class="muted small">a web page, shown as a browser shows it</span></summary>${pageHTML(v, all, n)}<details class="pysrc"><summary class="small">As code (${fileLines(v)} line${fileLines(v) === 1 ? '' : 's'})</summary><pre class="pyout">${esc(v.length > 20000 ? v.slice(0, 20000) + '\n…' : v)}</pre></details></details>`;
  if (isBin(v) && v.b64 && /\.(png|jpe?g|gif)$/i.test(n)) return `<details class="pyfile ${changed ? 'chg' : ''}" ${open ? 'open' : ''}><summary>🖼️ <b>${esc(n)}</b>${changed ? ' <span class="tag">just written</span>' : ''} <span class="muted small">a picture · ${sizeText(v.size)}</span></summary><img class="pyfig pyfilepic" src="data:${MIME[n.split('.').pop().toLowerCase()]};base64,${v.b64}" alt="${esc(n)}" loading="lazy"></details>`;
  if (isBin(v)) { const pv = previewOf(v); const xl = /\.xlsx?m?$/i.test(n);
    return `<details class="pyfile ${changed ? 'chg' : ''}" ${open ? 'open' : ''}><summary>${xl ? '📊' : '📦'} <b>${esc(n)}</b>${changed ? ' <span class="tag">just written</span>' : ''} <span class="muted small">${xl && pv && pv.sheets ? `${pv.sheets.length} sheet${pv.sheets.length === 1 ? '' : 's'}` : sizeText(v.size)}</span></summary>${xl ? workbookHTML(pv, { marks }) : '<p class="muted small">Not a text file.</p>'}</details>`; }
  if (/\.csv$/i.test(n) && typeof v === 'string' && v.includes(',')) { const nr = Math.max(0, parseCSV(v).length - 1); return `<details class="pyfile ${changed ? 'chg' : ''}" ${open ? 'open' : ''}><summary>🧾 <b>${esc(n)}</b>${changed ? ' <span class="tag">just written</span>' : ''} <span class="muted small">${nr} row${nr === 1 ? '' : 's'} and a header</span></summary>${csvHTML(v)}</details>`; }
  return `<details class="pyfile ${changed ? 'chg' : ''}" ${open ? 'open' : ''}><summary>📄 <b>${esc(n)}</b>${changed ? ' <span class="tag">just written</span>' : ''} <span class="muted small">${fileLines(v)} line${fileLines(v) === 1 ? '' : 's'}</span></summary><pre class="pyout">${esc(v) || ' '}</pre></details>`;
}
// The charts a program drew: matplotlib's figures, sent back from Python as small PNG pictures.
export function figsHTML(figs, { tag = 'It draws' } = {}) {
  if (!figs || !figs.length) return '';
  return `<div class="pyfigs">${tag ? `<span class="sp-tag">${esc(tag)}</span>` : ''}${figs.map((f, i) => f.png ? `<img class="pyfig" src="data:image/png;base64,${f.png}" alt="Chart ${i + 1} drawn by the program" loading="lazy">` : '').join('')}</div>`;
}
export function filesHTML(files, { changed = [], title = 'Files in the folder', empty = 'No files yet. A program that writes a file makes one here.' } = {}) {
  const names = Object.keys(files || {});
  return `<div class="pyfiles"><span class="sp-tag">📁 ${esc(title)}</span>${names.length ? names.map(n => fileHTML(n, files[n], { open: names.length <= 2 || changed.includes(n), changed: changed.includes(n), all: files })).join('') : `<p class="muted small">${esc(empty)}</p>`}</div>`;
}
const fkey = v => isBin(v) ? 'b64:' + v.b64 : v;
export const changedFiles = (before, after) => Object.keys(after || {}).filter(n => fkey((before || {})[n]) !== fkey(after[n]));
