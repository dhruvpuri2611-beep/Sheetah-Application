// Code replay: the program types itself out with captions, mistakes and error messages included.
// Pause at any point, or press Take over to edit and run the code from there.
// Outputs shown during the replay were worked out when the course was built, so watching needs no Python;
// taking over loads Python in the browser.
import { esc, md, $, mascot } from '../ui.js';
import { PyEditor, filesHTML, figsHTML, changedFiles } from './editor.js';
import { Stepper } from './stepper.js';
import { runPy, pyReady, pyPrepare, packagesFor } from './pyrun.js';
import { explainError } from './explain.js';
import { cautionBox } from './pylab.js';
const pre = (s, cls = '') => `<pre class="pyout ${cls}">${esc(s) || '<span class="muted">(nothing printed)</span>'}</pre>`;
const wait = ms => new Promise(r => setTimeout(r, ms));
const idxOf = (code, line, col = 0) => { const ls = code.split('\n'); let k = 0; for (let i = 0; i < Math.min(line - 1, ls.length); i++) k += ls[i].length + 1; return Math.min(code.length, k + (col < 0 ? (ls[line - 1] || '').length : col)); };

export function renderReplay(body, { D, st, onSeen, onNext, nextLabel, store }) {
  body.innerHTML = `<div class="card demo replay"><p class="eyebrow">Code replay · about ${D.minutes || 4} min</p><p class="lead">${md(D.intro)}</p>
    <div class="say" id="cap">${mascot('teaching', 'sm')}<div class="bubble">Press <b>Play</b> and watch the program being written, mistakes and all. Pause whenever you like, or press <b>Take over</b> to edit and run it yourself.</div></div>
    <div class="rp-ed"></div>
    <div class="row rp-ctl"><button class="btn" id="rpPlay" type="button">▶ Play</button><button class="btn ghost" id="rpSpeed" type="button" aria-label="Speed">1×</button><button class="btn ghost" id="rpRestart" type="button">↺ Restart</button><button class="btn ghost" id="rpTake" type="button">✋ Take over</button><span class="rp-prog muted small" aria-live="polite"></span></div>
    <div class="rp-own" hidden><label class="small stdin-l" hidden>Input · one line for each <code>input()</code><textarea class="stdin mono" rows="2" spellcheck="false"></textarea></label><div class="row"><button class="btn ghost sm" id="rpRun" type="button">▶ Run</button><button class="btn ghost sm" id="rpStep" type="button">👣 Step through</button></div></div>
    <div class="console" hidden></div>${D.files ? `<div class="rp-files">${filesHTML(D.files, { title: 'Files in the folder, before it runs' })}</div>` : ''}<div class="sp-host" hidden></div>
    <div class="row between"><span></span><button class="btn" id="n" type="button" ${st.demoSeen ? '' : 'disabled'} title="${st.demoSeen ? '' : 'Watch the replay once (or take over) to continue'}">${esc(nextLabel)}</button></div>${st.demoSeen ? '' : '<p class="muted small right rp-note">Watch it to the end, or take over and run it, to continue.</p>'}</div>`;
  const ed = new PyEditor($('.rp-ed', body), { code: '', readOnly: true, minLines: D.lines || 8, onRun: () => own(false) });
  const con = $('.console', body), sp = $('.sp-host', body), cap = t => { const b = $('#cap .bubble', body); if (b) b.innerHTML = md(t); };
  let i = 0, playing = false, speed = 1, takenOver = false, token = 0;
  const prog = () => { const p = $('.rp-prog', body); if (p) p.textContent = `Step ${Math.min(i, D.steps.length)} of ${D.steps.length}`; };
  const seen = () => { if (st.demoSeen) return; st.demoSeen = true; store.save(); onSeen && onSeen(); const n = $('#n', body); n.disabled = false; n.title = ''; const note = $('.rp-note', body); if (note) note.remove(); };
  const showRun = (s) => { con.hidden = false; const ex = s.err ? explainError(s.err, ed.value) : null; if (s.err && s.err.line) ed.mark(s.err.line, 'err'); else ed.mark(null);
    con.innerHTML = `<span class="sp-tag">Output${s.stdin && s.stdin.length ? ` · typed in: ${s.stdin.map(x => `<code>${esc(x)}</code>`).join(', ')}` : ''}</span>${pre(s.out)}${figsHTML(s.figs)}${s.err ? pre(s.err.tb || s.err.msg, 'err') + `<div class="explain"><b>${esc(ex.title)}</b><p>${md(ex.plain)}</p></div>` : ''}`;
    const rf = $('.rp-files', body); if (rf && s.files) rf.innerHTML = filesHTML(s.files, { title: 'Files in the folder, after this run', changed: s.changed || [] }); };
  async function step(s, my) {
    if (s.say) cap(s.say);
    if (s.goto) { const k = idxOf(ed.value, s.goto[0], s.goto[1] ?? -1); ed.ta.selectionStart = ed.ta.selectionEnd = k; ed._cur = k; }
    if (s.type) { let k = ed._cur ?? ed.value.length; for (const ch of s.type) { if (my !== token) return; const v = ed.value; ed.value = v.slice(0, k) + ch + v.slice(k); k++; ed._cur = k; await wait((ch === '\n' ? 160 : 38) / speed); } }
    if (s.back) { let k = ed._cur ?? ed.value.length; for (let j = 0; j < s.back; j++) { if (my !== token) return; const v = ed.value; ed.value = v.slice(0, k - 1) + v.slice(k); k--; ed._cur = k; await wait(70 / speed); } }
    if (s.run) { await wait(300 / speed); showRun(s); await wait(1400 / speed); }
    if (s.say) await wait(Math.min(4200, 900 + s.say.length * 28) / speed);
    if (s.pause) await wait(s.pause / speed);
  }
  const reset = () => { token++; playing = false; i = 0; ed.value = ''; ed._cur = 0; con.hidden = true; sp.hidden = true; const rf = $('.rp-files', body); if (rf && D.files) rf.innerHTML = filesHTML(D.files, { title: 'Files in the folder, before it runs' }); $('#rpPlay', body).textContent = '▶ Play'; prog(); };
  async function play() {
    if (takenOver) return; if (playing) { playing = false; token++; $('#rpPlay', body).textContent = '▶ Play'; return; }
    if (i >= D.steps.length) reset();
    playing = true; const my = ++token; $('#rpPlay', body).textContent = '⏸ Pause';
    while (i < D.steps.length && playing && my === token) { const s = D.steps[i]; await step(s, my); if (my !== token) return; i++; prog(); }
    if (i >= D.steps.length) { playing = false; $('#rpPlay', body).textContent = '↺ Play again'; cap(D.outro || 'That’s the whole program. Your turn in the lab next.'); seen(); }
  }
  // Take over: playback stops, and the code so far is yours to edit and run
  function takeOver() {
    token++; playing = false; takenOver = true; ed.ta.readOnly = false; ed.focus(); $('#rpPlay', body).disabled = true; $('#rpTake', body).disabled = true; $('#rpSpeed', body).disabled = true;
    $('.rp-own', body).hidden = false; if (/\binput\s*\(/.test(D.final || ed.value)) { const l = $('.stdin-l', body); l.hidden = false; $('.stdin', body).value = (D.sample || []).join('\n'); }
    cap('It’s yours now. Change anything, then press **Run** (or Ctrl+Enter). **Restart** brings the replay back.'); pyReady().then(() => pyPrepare(packagesFor(D.final || ed.value, D.files))).catch(() => {});
  }
  async function own(trace) {
    const stdin = $('.stdin', body) ? $('.stdin', body).value.split('\n').filter((x, k, a) => x !== '' || k < a.length - 1) : [];
    con.hidden = false; con.innerHTML = '<p class="muted small">Running…</p>'; sp.hidden = true;
    const r = await runPy(ed.value, { stdin, trace, files: D.files || null }); const ex = explainError(r.err, ed.value); if (r.err && r.err.line) ed.mark(r.err.line, 'err'); else ed.mark(null);
    con.innerHTML = `<span class="sp-tag">Output</span>${pre(r.out)}${r.err ? pre(r.err.tb || r.err.msg, 'err') + `<div class="explain"><b>${esc(ex.title)}</b><p>${md(ex.plain)}</p>${ex.fix ? `<p class="small"><b>Try:</b> ${md(ex.fix)}</p>` : ''}</div>${ex.caution ? cautionBox(ex.caution) : ''}` : ''}`;
    const rf = $('.rp-files', body); if (rf && D.files && r.files) rf.innerHTML = filesHTML(r.files, { title: 'Files in the folder, after your run', changed: changedFiles(D.files, r.files) });
    if (trace && r.steps && r.steps.length > 1) { sp.hidden = false; new Stepper(sp, ed.value, r, { onLine: l => ed.mark(l, 'stepl') }); }
    seen();
  }
  $('#rpPlay', body).onclick = play; $('#rpTake', body).onclick = takeOver;
  $('#rpRestart', body).onclick = () => { takenOver = false; ed.ta.readOnly = true; $('.rp-own', body).hidden = true; ['#rpPlay', '#rpTake', '#rpSpeed'].forEach(s => $(s, body).disabled = false); reset(); cap('Press **Play** to watch it again.'); };
  $('#rpSpeed', body).onclick = () => { speed = speed === 1 ? 2 : speed === 2 ? 0.5 : 1; $('#rpSpeed', body).textContent = speed + '×'; };
  $('#rpRun', body).onclick = () => own(false); $('#rpStep', body).onclick = () => own(true);
  $('#n', body).onclick = onNext; prog();
  return () => { token++; };
}
