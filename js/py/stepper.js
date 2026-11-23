// The step-through panel: run one line at a time, step back, and watch the variables, the output and the function calls change.
// It plays back a trace recorded by the harness (or worked out when the course was built), so stepping back is instant.
import { pyHL } from './editor.js';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class Stepper {
  // res: {steps, out, err, truncated}; code: the program the trace belongs to
  constructor(host, code, res, { onLine, startAt = 0, title = 'Step through' } = {}) {
    this.host = host; this.code = code; this.res = res; this.onLine = onLine; this.i = Math.min(startAt, res.steps.length - 1); this.title = title;
    this.lines = code.split('\n'); this.render();
  }
  get n() { return this.res.steps.length; }
  at(i) { this.i = Math.max(0, Math.min(this.n - 1, i)); this.draw(); }
  render() {
    this.host.classList.add('stepper');
    this.host.innerHTML = `<div class="sp-head"><b>👣 ${esc(this.title)}</b><span class="sp-count" aria-live="polite"></span></div>
      <div class="sp-ctl" role="group" aria-label="Step controls"><button class="btn ghost sm" data-s="first" type="button" title="Back to the start">⏮</button><button class="btn ghost sm" data-s="back" type="button" title="Step back (←)">◀ Back</button><button class="btn sm" data-s="next" type="button" title="Next step (→)">Next ▶</button><button class="btn ghost sm" data-s="last" type="button" title="Jump to the end">⏭</button><input type="range" min="0" max="${this.n - 1}" value="${this.i}" aria-label="Step"></div>
      <div class="sp-cols"><div class="sp-code"></div><div class="sp-state"><div class="sp-frames"></div><div class="sp-outw"><span class="sp-tag">Output so far</span><pre class="sp-out"></pre></div></div></div>
      ${this.res.truncated ? '<p class="muted small">This program runs a lot of steps; the panel shows the first ones.</p>' : ''}`;
    this.host.querySelectorAll('[data-s]').forEach(b => b.onclick = () => { const s = b.dataset.s; this.at(s === 'first' ? 0 : s === 'last' ? this.n - 1 : s === 'back' ? this.i - 1 : this.i + 1); });
    const r = this.host.querySelector('input[type=range]'); r.oninput = () => this.at(+r.value);
    this.host.tabIndex = 0; this.host.onkeydown = e => { if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return; if (e.key === 'ArrowRight') { e.preventDefault(); this.at(this.i + 1); } if (e.key === 'ArrowLeft') { e.preventDefault(); this.at(this.i - 1); } };
    this.draw();
  }
  draw() {
    const s = this.res.steps[this.i], prev = this.res.steps[this.i - 1]; const end = s.ev === 'end';
    const errLine = end && this.res.err ? this.res.err.line : null; const prevLine = errLine ? null : prev && prev.line; const cur = s.line;
    this.host.querySelector('.sp-count').textContent = end ? `${this.res.err ? 'Stopped' : 'Finished'} · step ${this.i + 1} of ${this.n}` : `Step ${this.i + 1} of ${this.n}`;
    this.host.querySelector('input[type=range]').value = this.i;
    this.host.querySelector('[data-s=back]').disabled = this.i === 0; this.host.querySelector('[data-s=first]').disabled = this.i === 0;
    this.host.querySelector('[data-s=next]').disabled = this.i >= this.n - 1; this.host.querySelector('[data-s=last]').disabled = this.i >= this.n - 1;
    const note = s.ev === 'call' ? `→ calling ${esc(s.fn)}()` : s.ev === 'return' ? `← ${esc(s.fn)}() gives back ${esc(s.ret)}` : '';
    this.host.querySelector('.sp-code').innerHTML = `<pre class="pyblock">${this.lines.map((l, k) => { const n = k + 1; const cls = n === errLine ? 'sp-err' : n === cur && !end ? (s.ev === 'return' ? 'sp-ret' : 'sp-cur') : n === prevLine ? 'sp-prev' : ''; return `<div class="pyl ${cls}"><span class="pyn">${n === errLine ? '✗' : n === cur && !end ? '➜' : n === prevLine ? '✓' : n}</span><span class="pyc">${pyHL(l) || ' '}</span></div>`; }).join('')}</pre>
      <p class="sp-legend small"><span class="sp-k cur">➜</span> runs next${prevLine ? ' · <span class="sp-k prev">✓</span> just ran' : ''}${note ? ` · <b>${note}</b>` : ''}${end ? (this.res.err ? ` · <b class="no">✗ Stopped with ${esc(this.res.err.type)}${errLine ? ' on line ' + errLine : ''}.</b>` : ' · <b>The program has finished.</b>') : ''}</p>`;
    const pv = new Map(); if (prev) for (const f of prev.frames) for (const [k, v] of f.vars) pv.set(f.name + ':' + k, v);
    this.host.querySelector('.sp-frames').innerHTML = s.frames.map((f, fi) => `<div class="sp-frame ${fi === s.frames.length - 1 ? 'sp-top' : ''}"><span class="sp-tag">${f.name === 'Global' ? 'Variables' : 'Inside ' + esc(f.name)}</span>${f.vars.length ? `<table><tbody>${f.vars.map(([k, v, t]) => { const ch = prev && pv.get(f.name + ':' + k) !== v; return `<tr class="${ch ? 'chg' : ''}"><th>${esc(k)}</th><td><code>${esc(v)}</code></td><td class="muted small">${esc(t)}</td></tr>`; }).join('')}</tbody></table>` : '<p class="muted small">No variables yet</p>'}</div>`).join('');
    const out = (this.res.out || '').slice(0, s.out); const o = this.host.querySelector('.sp-out'); o.textContent = out || ' '; o.scrollTop = o.scrollHeight;
    if (this.onLine) this.onLine(end ? null : cur);
  }
}
