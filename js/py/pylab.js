// The Python lab: the practice ladder. Short, auto-checked rungs that climb from reading code to writing it:
// Predict · Trace · Arrange · Fill the gaps · Fix · Change · Write (and Plan, at the start of every Build it).
// The learner's level decides which rungs show, when hints open, and whether step-through is on by default.
import { store } from '../store.js';
import { esc, md, $, $$, mascot, toast, modal, shuffle } from '../ui.js';
import { PyEditor, pyBlock, pyHL, filesHTML, figsHTML, changedFiles, stripPreviews, workbookHTML, previewOf, pageHTML } from './editor.js';
import { Stepper } from './stepper.js';
import { runPy, checkPy, pyReady, onPyStatus, pyStatus, pyPrepare, packagesFor } from './pyrun.js';
import { explainError, codeCautions, CAUTIONS, featureName } from './explain.js';
import { activeLevel, LEVEL_NAMES } from '../levels.js';

export const RUNGS = {
  predict: { name: 'Predict', icon: '🔮', what: 'Say what the code prints' },
  trace: { name: 'Trace', icon: '👣', what: 'Fill in each variable’s value, line by line' },
  arrange: { name: 'Arrange', icon: '🧩', what: 'Put the lines in order and indent them' },
  gaps: { name: 'Fill the gaps', icon: '🔤', what: 'Drag the code chips into the blanks' },
  fix: { name: 'Fix', icon: '🔧', what: 'Make the broken code pass' },
  change: { name: 'Change', icon: '✏️', what: 'Change working code to a new spec' },
  write: { name: 'Write', icon: '📝', what: 'Write it from a blank editor' },
  plan: { name: 'Plan', icon: '🗺️', what: 'Put the steps of the program in order' },
};
const LADDER = ['predict', 'trace', 'arrange', 'gaps', 'fix', 'change', 'write'];
export const LEVEL_RUNGS = { B: [...LADDER, 'plan'], I: ['predict', 'arrange', 'fix', 'change', 'write', 'plan'], M: ['fix', 'write', 'plan'] };
// how the level changes the help on offer
export const LEVEL_RULES = {
  B: { hints: 3, hintsAfterTry: false, stepper: true, solutionAfter: 3, decoys: false },
  I: { hints: 3, hintsAfterTry: true, stepper: false, solutionAfter: 3, decoys: true },
  M: { hints: 1, hintsAfterTry: true, stepper: false, solutionAfter: 5, decoys: true },
};
// the rungs follow the level's place in the course: a course that starts at Intermediate (PY2) shows its first level every rung
export const rungTier = (c, lv) => { const i = (c && c.levels || []).findIndex(l => l.id === lv); return i >= 0 ? ['B', 'I', 'M'][i] : lv; };
export const visibleTasks = (tasks, lv) => tasks.filter(t => t.levels ? t.levels.includes(lv) : (LEVEL_RUNGS[lv] || LEVEL_RUNGS.B).includes(t.kind));
const norm = s => String(s ?? '').replace(/\r\n/g, '\n').split('\n').map(l => l.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '').replace(/^\n+/, '');
const normVal = s => { let v = String(s ?? '').trim(); if (/^".*"$/.test(v)) v = "'" + v.slice(1, -1) + "'"; return v.replace(/\s*,\s*/g, ', ').replace(/\[\s+/g, '[').replace(/\s+\]/g, ']'); };
const usesInput = code => /\binput\s*\(/.test(code || '');
const pre = (s, cls = '') => `<pre class="pyout ${cls}">${esc(s) || '<span class="muted">(nothing printed)</span>'}</pre>`;

export function renderPyLab(body, { c, L, st, id, meta, onNext, nextLabel, minutes, practice = false }) {
  const B = L.lab; const lv = activeLevel(c) || 'B'; const rules = LEVEL_RULES[lv]; st.tasks = st.tasks || {};
  const tasks = visibleTasks(B.tasks, rungTier(c, lv)); const hidden = B.tasks.length - tasks.length;
  const ladder = tasks.map(t => t.kind);
  body.innerHTML = `<div class="lab pylab"><div class="card lab-intro"><p class="eyebrow">Lab · practice ladder · ${tasks.length} rungs · about ${minutes} min</p><p>${md(B.intro)}</p>
     <div class="ladder" aria-label="The rungs in this lab">${ladder.map((k, i) => `<span class="rung r-${k}" data-goto="${i}" title="${esc(RUNGS[k].what)}"><i>${RUNGS[k].icon}</i>${esc(RUNGS[k].name)}</span>`).join('<b aria-hidden="true">›</b>')}</div>
     <p class="muted small">Your level: <b>${esc(LEVEL_NAMES[lv])}</b>${hidden ? ` · ${hidden} rung${hidden === 1 ? '' : 's'} for other levels hidden` : ''}. ${lv === 'B' ? 'Hints open any time, and the step-through panel opens after every run.' : lv === 'I' ? 'Hints open after your first try; the step-through panel is one click away.' : 'One hint, after a try that didn’t pass; the model answer after a pass.'} <a href="#/course/${c.id}">Change level</a></p>
     <p class="pystat small" id="pyStat" role="status"></p></div>
     <ol class="tasks pytasks">${tasks.map((t, i) => shell(t, i)).join('')}</ol>
     <div class="row between"><span class="muted" id="labStat"></span><button class="btn" id="n" type="button">${esc(nextLabel)}</button></div></div>`;
  // Python loads in the background the moment the lab opens
  const stat = $('#pyStat', body); const off = onPyStatus(s => { if (!document.body.contains(stat)) { off(); return; } stat.innerHTML = s === 'loading' ? (pyStatus.what ? `⏳ Loading ${esc(pyStatus.what)} for this lab… the first time takes a few seconds more.` : '⏳ Loading Python in your browser… the first time takes a few seconds.') : s === 'ready' ? '<span class="ok">✓ Python is ready. Your code runs here, in this browser.</span>' : s === 'error' ? `<span class="no">Python didn’t load. Check the internet connection, then <button class="linkbtn" id="pyRetry" type="button">try again</button>.</span>` : ''; const r = $('#pyRetry', body); if (r) r.onclick = () => pyReady().catch(() => {}); });
  if (tasks.some(t => ['arrange', 'gaps', 'fix', 'change', 'write'].includes(t.kind))) {
    // and any library the lab's programs use (pandas, openpyxl) straight after, so the first Run doesn't wait
    const pk = [...new Set(tasks.flatMap(t => packagesFor([t.model, t.start, t.broken].filter(Boolean).join('\n'), t.files)))];
    pyReady().then(() => pyPrepare(pk)).catch(() => {});
  }
  $$('[data-goto]', body).forEach(b => b.onclick = () => $(`#task-${b.dataset.goto}`, body).scrollIntoView({ behavior: 'smooth', block: 'center' }));
  const refresh = () => { const done = tasks.filter(t => st.tasks[t.id] && st.tasks[t.id].done).length; $('#labStat', body).textContent = `${done} of ${tasks.length} rungs done`; const n = $('#n', body); n.disabled = !practice && done < tasks.length; n.title = done < tasks.length ? 'Finish every rung to continue' : ''; $$('.rung', body).forEach((r, i) => r.classList.toggle('done', !!(st.tasks[tasks[i].id] && st.tasks[tasks[i].id].done))); };
  tasks.forEach((t, i) => wire(t, $(`#task-${i}`, body), i));
  refresh(); $('#n', body).onclick = onNext;
  const firstOpen = tasks.findIndex(t => !(st.tasks[t.id] && st.tasks[t.id].done)); if (firstOpen > 0) setTimeout(() => $(`#task-${firstOpen}`, body).scrollIntoView({ block: 'center' }), 50);

  function shell(t, i) {
    const s = st.tasks[t.id] || {}; const R = RUNGS[t.kind] || RUNGS.write;
    return `<li class="card task pytask k-${t.kind} ${s.done ? 'done' : ''}" id="task-${i}" tabindex="-1"><div class="tnum">${i + 1}</div><div class="tbody">
      <p class="eyebrow rung-tag">${R.icon} ${esc(R.name)} · ${esc(R.what)}</p><div class="tprompt">${md(t.prompt)}</div>${t.files && !['fix', 'change', 'write'].includes(t.kind) ? filesHTML(t.files, { title: Object.keys(t.files).length > 1 ? 'The files it works on' : 'The file it works on' }) : ''}<div class="tarea"></div>
      <div class="row tbtns"><button class="btn sm check" type="button">${t.kind === 'plan' ? 'Done planning' : 'Check'}</button><button class="btn ghost sm hint" type="button"></button><button class="btn ghost sm sol" type="button" hidden>${lv === 'M' && t.kind !== 'plan' ? 'See the model answer' : 'Show solution'}</button></div>
      <ul class="hints"></ul><div class="tfb" role="status">${s.done ? `<p class="ok">✓ ${s.help ? 'Done with help' : 'Done'}</p>` : ''}</div></div></li>`;
  }

  function wire(t, card, i) {
    const ts = () => st.tasks[t.id] || (st.tasks[t.id] = { hints: 0, attempts: 0 });
    const area = $('.tarea', card); const fb = $('.tfb', card); const hintBtn = $('.hint', card); const solBtn = $('.sol', card); const checkBtn = $('.check', card);
    const hints = (t.hints || []).slice(0, rules.hints);
    const showHints = () => { const s = ts(); $('.hints', card).innerHTML = hints.slice(0, s.hints).map((h, k) => `<li><b>Hint ${k + 1}.</b> ${md(h)}</li>`).join('');
      const locked = rules.hintsAfterTry && !s.attempts && !s.done; hintBtn.hidden = !hints.length; hintBtn.disabled = locked || s.hints >= hints.length;
      hintBtn.textContent = s.hints >= hints.length ? 'No more hints' : locked ? `Hint (after your first try)` : `Hint ${s.hints + 1} of ${hints.length}`;
      const canSol = lv === 'M' ? s.done || s.attempts >= rules.solutionAfter : s.attempts >= rules.solutionAfter || (hints.length && s.hints >= hints.length);
      solBtn.hidden = !canSol || t.kind === 'plan'; };
    hintBtn.onclick = () => { const s = ts(); if (s.hints < hints.length) s.hints++; showHints(); store.save(); };
    const R = RENDER[t.kind] || RENDER.write; const ui = R(t, area, ts, { lv, rules, c, id });
    const pass = (msg, extra = '') => { const s = ts(); s.done = true; if (s.first === undefined) s.first = s.hints === 0 && s.attempts === 1; if (s.sawSolution) s.help = true; if (s.first && !practice) { const ls = store.lesson(id); ls.firstTries = (ls.firstTries || 0) + 1; }
      fb.innerHTML = `<p class="ok">✓ ${s.help ? 'Done with help. It comes back in your daily review. ' : ''}${md(msg || t.explain || 'Right.')}</p>${extra}`; card.classList.add('done'); if (!practice) store.act('tasks'); else store.save();
      if (s.help && !s.logged) { s.logged = true; store.logError({ course: c.id, lesson: id, lessonNum: L.num, task: t.id, kind: 'lab', prompt: t.prompt, yours: '(done with the solution)', right: solutionText(t), why: t.explain || 'Done with help: try it again from memory in your review.' }); } };
    const fail = (msg, extra = '', yours = '', caution = null) => { const s = ts(); fb.innerHTML = `<p class="no">${mascot('oops', 'xs')} ${md(msg)}</p>${extra}${caution && CAUTIONS[caution] ? cautionBox(caution) : ''}${s.attempts >= 3 ? `<p class="small">Still stuck? <button class="linkbtn" type="button" data-ask="1" data-where="${esc(`Lesson ${L.num}, lab rung ${i + 1}`)}" data-what="${esc('I’m stuck on this task: ' + String(t.prompt).replace(/\*\*|`/g, '') + ' Sheetah says: ' + String(msg).replace(/\*\*|`/g, ''))}">Ask your teacher</button></p>` : ''}`;
      card.classList.add('shake'); setTimeout(() => card.classList.remove('shake'), 400);
      if (!s.logged) { s.logged = true; store.logError({ course: c.id, lesson: id, lessonNum: L.num, task: t.id, kind: 'lab', prompt: t.prompt, yours: String(yours || '').slice(0, 800), right: solutionText(t).slice(0, 800), why: String(msg).replace(/\*\*/g, '') + (caution && CAUTIONS[caution] ? ' ⚠ Watch out: ' + CAUTIONS[caution].title + '. ' + CAUTIONS[caution].text : ''), caution }); }
      if (caution) { store.d.cautions = store.d.cautions || {}; store.d.cautions[caution] = (store.d.cautions[caution] || 0) + 1; }
      if (store.d.settings.autoHint && s.hints < hints.length) s.hints++; };
    checkBtn.onclick = async () => {
      const s = ts(); checkBtn.disabled = true; const label = checkBtn.textContent; checkBtn.textContent = 'Checking…';
      try { s.attempts++; const r = await ui.check(); if (r.ok) pass(r.msg, r.extra); else fail(r.msg, r.extra, r.yours, r.caution); }
      catch (e) { s.attempts--; fb.innerHTML = `<p class="no">Sheetah couldn’t check this: ${esc(e.message)}. Try again in a moment.</p>`; }
      finally { checkBtn.disabled = false; checkBtn.textContent = label; store.save(); showHints(); refresh(); }
    };
    solBtn.onclick = () => { const s = ts(); if (!s.done) s.sawSolution = true; store.save();
      const m = modal(`<h2>${lv === 'M' && s.done ? 'The model answer' : 'Worked solution'}</h2>${solutionHTML(t)}<p>${md(t.explain || '')}</p>${s.done ? '' : '<p class="muted small">This rung will count as “done with help” and come back in your daily review.</p>'}<div class="row end">${ui.put && !s.done ? '<button class="btn ghost" id="put" type="button">Put it in for me</button>' : ''}<button class="btn" id="ok" type="button">${s.done ? 'Close' : 'I’ll do it myself'}</button></div>`);
      const p = $('#put', m.el); if (p) p.onclick = () => { ui.put(); m.close(); }; $('#ok', m.el).onclick = m.close; };
    showHints();
  }
}

export function cautionBox(id) { const k = CAUTIONS[id]; return k ? `<div class="caution"><b>⚠ Watch out: ${esc(k.title)}</b><p>${md(k.text)}</p></div>` : ''; }
function solutionText(t) {
  if (t.kind === 'predict') return t.options ? t.options[t.answer] : t.answer;
  if (t.kind === 'trace') return (t.rows || []).map(r => `line ${r.line}: ` + Object.entries(r.vals).map(([k, v]) => `${k}=${v}`).join(', ')).join('; ');
  if (t.kind === 'arrange') return t.lines.join('\n');
  if (t.kind === 'gaps') return fillTemplate(t.template, t.answers.map(a => a[0]));
  if (t.kind === 'plan') return t.steps.join(' → ');
  return t.model || '';
}
function solutionHTML(t) {
  if (t.kind === 'predict') return `<p>It prints:</p>${pre(t.options ? t.options[t.answer] : t.answer)}`;
  if (t.kind === 'trace') return traceTable(t, null, true);
  if (t.kind === 'plan') return `<ol>${t.steps.map(x => `<li>${md(x)}</li>`).join('')}</ol>`;
  return pyBlock(solutionText(t));
}
const fillTemplate = (tpl, vals) => tpl.replace(/__(\d+)__/g, (m, k) => vals[+k] ?? '___');

// ---------- each rung: render(t, area, state, ctx) → { check(): Promise<{ok,msg,extra,yours,caution}>, put?() } ----------
const RENDER = {
  predict(t, area, ts) {
    const s = ts();
    area.innerHTML = `${pyBlock(t.code)}${t.stdin && t.stdin.length ? `<p class="muted small">When it asks, the person types: ${t.stdin.map(x => `<code>${esc(x)}</code>`).join(', ')}</p>` : ''}${t.options ? `<div class="opts">${t.options.map((o, k) => `<button class="opt mono" data-i="${k}" type="button">${esc(o).replace(/\n/g, '<br>')}</button>`).join('')}</div>` : `<label class="small muted">What appears on the screen? Type it exactly, one line per line.<textarea class="predict-in mono" rows="${Math.min(6, Math.max(1, String(t.answer).split('\n').length))}" spellcheck="false" autocapitalize="off">${esc(s.given || '')}</textarea></label>`}`;
    let pick = s.pick; $$('.opt', area).forEach(b => { if (+b.dataset.i === pick) b.classList.add('sel'); b.onclick = () => { $$('.opt', area).forEach(x => x.classList.remove('sel')); b.classList.add('sel'); pick = +b.dataset.i; s.pick = pick; }; });
    const ta = $('.predict-in', area); if (ta) ta.oninput = () => { s.given = ta.value; };
    return { async check() {
      if (t.options) { if (pick === undefined) return { ok: false, msg: 'Pick an answer first.' }; const ok = pick === t.answer; return ok ? { ok, msg: t.explain } : { ok, msg: (t.why && t.why[pick]) || 'Not that one. Read the code line by line and keep track of each value.', yours: t.options[pick] }; }
      const g = ta.value; if (!g.trim()) return { ok: false, msg: 'Type what you think it prints first.' };
      const ok = [t.answer, ...(t.accept || [])].some(a => norm(a) === norm(g)) || (t.loose && [t.answer].some(a => norm(a).toLowerCase().replace(/\s+/g, ' ') === norm(g).toLowerCase().replace(/\s+/g, ' ')));
      if (ok) return { ok, msg: t.explain };
      const ga = norm(g).split('\n'), wa = norm(t.answer).split('\n'); const k = wa.findIndex((w, j) => w !== ga[j]);
      return { ok: false, msg: k >= 0 && ga[k] !== undefined ? `Line ${k + 1} of the output isn’t that. ${t.nudge || 'Step through it in your head: what does each variable hold when that line runs?'}` : ga.length < wa.length ? `It prints more lines than that. ${t.nudge || ''}` : `It prints fewer lines than that. ${t.nudge || ''}`, yours: g };
    } };
  },
  trace(t, area, ts) {
    const s = ts(); s.vals = s.vals || {};
    area.innerHTML = `${pyBlock(t.code)}<p class="muted small">Each row is one moment, just after that line runs. Fill in the blanks. Write text with quotes, as Python shows it: <code>'Asha'</code>.</p>${traceTable(t, s.vals)}`;
    $$('input[data-k]', area).forEach(inp => inp.oninput = () => { s.vals[inp.dataset.k] = inp.value; });
    return { async check() {
      let wrong = 0, blank = 0, first = null;
      $$('input[data-k]', area).forEach(inp => { const want = inp.dataset.want; const g = inp.value; inp.classList.remove('bad', 'good'); if (!g.trim()) { blank++; return; } const ok = normVal(g) === normVal(want) || (/^'.*'$/.test(normVal(want)) && normVal("'" + g.trim() + "'") === normVal(want)); inp.classList.add(ok ? 'good' : 'bad'); if (!ok) { wrong++; if (!first) first = inp.dataset.k; } });
      if (blank) return { ok: false, msg: `${blank} blank${blank === 1 ? '' : 's'} still to fill.` };
      if (!wrong) return { ok: true, msg: t.explain || 'Every value is right. That’s exactly what Python keeps track of.' };
      const [row, v] = first.split(':'); return { ok: false, msg: `${wrong} value${wrong === 1 ? ' isn’t' : 's aren’t'} right yet (marked in red). Look at row ${+row + 1}: what does **${v}** hold after line ${t.rows[+row].line} runs?`, yours: $$('input[data-k]', area).map(i => i.dataset.k + '=' + i.value).join(', ') };
    }, put() { $$('input[data-k]', area).forEach(inp => { inp.value = inp.dataset.want; s.vals[inp.dataset.k] = inp.value; }); store.save(); } };
  },
  arrange(t, area, ts, { rules }) {
    const s = ts(); const decoys = rules.decoys || t.alwaysDecoys ? (t.decoys || []) : [];
    const pool = t.lines.map((l, k) => ({ k: 'l' + k, text: l.trim() })).concat(decoys.map((l, k) => ({ k: 'd' + k, text: l.trim(), decoy: true })));
    if (!s.order || s.order.some(x => !pool.find(p => p.k === x.k))) s.order = [];
    if (!s.bankOrder || s.bankOrder.length !== pool.length) s.bankOrder = shuffle(pool.map(p => p.k));
    let selected = null; let drag = null;
    const get = k => pool.find(p => p.k === k);
    const draw = () => {
      const used = new Set(s.order.map(x => x.k));
      area.innerHTML = `<div class="arr"><div class="arr-col"><span class="sp-tag">Lines to use${decoys.length ? ' · some don’t belong' : ''}</span><ul class="arr-bank" aria-label="Lines to use">${s.bankOrder.filter(k => !used.has(k)).map(k => `<li><button type="button" class="arr-chip mono" data-add="${k}" draggable="true" title="Add to your program">${pyHL(get(k).text)}</button></li>`).join('') || '<li class="muted small">All lines placed.</li>'}</ul></div>
        <div class="arr-col"><span class="sp-tag">Your program · tap a line, then move or indent it</span><ol class="arr-prog" aria-label="Your program">${s.order.map((x, j) => `<li class="${selected === j ? 'sel' : ''}" data-j="${j}" draggable="true"><button type="button" class="arr-line mono" data-pick="${j}" style="padding-left:${10 + x.ind * 28}px" aria-label="Line ${j + 1}, indent ${x.ind}: ${esc(get(x.k).text)}">${x.ind ? '<span class="arr-ind">' + '·&nbsp;&nbsp;&nbsp;'.repeat(x.ind) + '</span>' : ''}${pyHL(get(x.k).text)}</button><span class="arr-tools"><button class="mini" data-act="out" data-j="${j}" type="button" aria-label="Indent less" title="Indent less">⇤</button><button class="mini" data-act="in" data-j="${j}" type="button" aria-label="Indent more" title="Indent more">⇥</button><button class="mini" data-act="up" data-j="${j}" type="button" aria-label="Move up">↑</button><button class="mini" data-act="down" data-j="${j}" type="button" aria-label="Move down">↓</button><button class="mini" data-act="del" data-j="${j}" type="button" aria-label="Take out">✕</button></span></li>`).join('') || '<li class="muted small arr-empty">Tap or drag lines here, in order.</li>'}</ol></div></div>`;
      $$('[data-add]', area).forEach(b => { b.onclick = () => { s.order.push({ k: b.dataset.add, ind: 0 }); selected = s.order.length - 1; store.save(); draw(); }; b.ondragstart = e => { drag = { from: 'bank', k: b.dataset.add }; e.dataTransfer.setData('text/plain', b.dataset.add); }; });
      $$('[data-pick]', area).forEach(b => b.onclick = () => { selected = selected === +b.dataset.pick ? null : +b.dataset.pick; draw(); });
      $$('[data-act]', area).forEach(b => b.onclick = () => { const j = +b.dataset.j, a = b.dataset.act, o = s.order; if (a === 'in') o[j].ind = Math.min(4, o[j].ind + 1); if (a === 'out') o[j].ind = Math.max(0, o[j].ind - 1); if (a === 'up' && j > 0) { [o[j - 1], o[j]] = [o[j], o[j - 1]]; selected = j - 1; } if (a === 'down' && j < o.length - 1) { [o[j + 1], o[j]] = [o[j], o[j + 1]]; selected = j + 1; } if (a === 'del') { o.splice(j, 1); selected = null; } store.save(); draw(); const nb = $(`[data-act="${a}"][data-j="${selected ?? j}"]`, area); if (nb) nb.focus(); });
      const prog = $('.arr-prog', area);
      $$('li[data-j]', prog).forEach(li => { li.ondragstart = e => { drag = { from: 'prog', j: +li.dataset.j }; e.dataTransfer.setData('text/plain', 'p'); }; });
      prog.ondragover = e => e.preventDefault();
      prog.ondrop = e => { e.preventDefault(); if (!drag) return; const lis = $$('li[data-j]', prog); let at = lis.length; for (const li of lis) { const r = li.getBoundingClientRect(); if (e.clientY < r.top + r.height / 2) { at = +li.dataset.j; break; } }
        const dx = e.clientX - prog.getBoundingClientRect().left; const ind = Math.max(0, Math.min(4, Math.round((dx - 20) / 28)));
        if (drag.from === 'bank') s.order.splice(at, 0, { k: drag.k, ind }); else { const [x] = s.order.splice(drag.j, 1); if (at > drag.j) at--; s.order.splice(at, 0, x); }
        drag = null; store.save(); draw(); };
      const bank = $('.arr-bank', area); bank.ondragover = e => e.preventDefault(); bank.ondrop = e => { e.preventDefault(); if (drag && drag.from === 'prog') { s.order.splice(drag.j, 1); store.save(); draw(); } drag = null; };
    };
    draw();
    const code = () => s.order.map(x => '    '.repeat(x.ind) + get(x.k).text).join('\n');
    return { async check() {
      if (!s.order.length) return { ok: false, msg: 'Move the lines into your program first.' };
      const dec = s.order.map(x => get(x.k)).filter(p => p.decoy); if (dec.length) return { ok: false, msg: `\`${dec[0].text}\` doesn’t belong in this program. ${t.decoyWhy || 'Take it out (✕) and try again.'}`, yours: code() };
      const unused = pool.filter(p => !p.decoy && !s.order.some(x => x.k === p.k)); if (unused.length) return { ok: false, msg: `${unused.length} line${unused.length === 1 ? ' is' : 's are'} still waiting to be used.`, yours: code() };
      if (norm(code()) === norm(t.lines.join('\n'))) return { ok: true, msg: t.explain };
      const sameOrder = s.order.map(x => get(x.k).text).join('\n') === t.lines.map(l => l.trim()).join('\n');
      const r = await checkPy(code(), t.lines.join('\n'), t.cases || [{}], { chart: t.chart });
      if (r.ok) return { ok: true, msg: (t.explain || '') + ' (Your order is different from Sheetah’s, and it works just as well.)' };
      const c0 = r.cases.find(x => !x.ok) || {};
      if (sameOrder) { const j = s.order.findIndex((x, k) => '    '.repeat(x.ind) + get(x.k).text !== t.lines[k]); return { ok: false, msg: `The order is right. Check the indentation of line ${j + 1}: ${t.indentWhy || 'which block does it belong to?'}`, yours: code(), caution: 'indent' }; }
      return caseFeedback(c0, code(), t, 'arrange');
    } };
  },
  gaps(t, area, ts) {
    const s = ts(); const n = t.answers.length; s.fill = s.fill && s.fill.length === n ? s.fill : Array(n).fill(null);
    const chips = t.chips.map((x, k) => ({ k, text: x })); if (!s.chipOrder || s.chipOrder.length !== chips.length) s.chipOrder = shuffle(chips.map(x => x.k));
    let sel = s.fill.findIndex(x => x === null); let drag = null;
    const draw = () => {
      const used = new Set(s.fill.filter(x => x !== null));
      const html = t.template.split('\n').map((l, li) => `<div class="pyl"><span class="pyn">${li + 1}</span><span class="pyc">${l.split(/(__\d+__)/).map(part => { const m = /^__(\d+)__$/.exec(part); if (!m) return pyHL(part); const k = +m[1]; const v = s.fill[k]; return `<button type="button" class="gap ${v === null ? 'empty' : 'full'} ${sel === k ? 'sel' : ''}" data-gap="${k}" aria-label="Gap ${k + 1}${v !== null ? ': ' + esc(chips[v].text) : ', empty'}">${v === null ? `<span class="gapn">${k + 1}</span>` : esc(chips[v].text)}</button>`; }).join('')}</span></div>`).join('');
      area.innerHTML = `<pre class="pyblock gaps">${html}</pre><p class="muted small">Tap a chip to drop it in the highlighted gap, or drag it. Tap a filled gap to empty it.</p><div class="chips" aria-label="Code chips">${s.chipOrder.map(k => `<button type="button" class="chip mono" data-chip="${k}" draggable="true" ${used.has(k) ? 'disabled' : ''}>${esc(chips[k].text)}</button>`).join('')}</div>`;
      $$('[data-gap]', area).forEach(b => { b.onclick = () => { const k = +b.dataset.gap; if (s.fill[k] !== null) { s.fill[k] = null; } sel = k; store.save(); draw(); $(`[data-gap="${k}"]`, area).focus(); }; b.ondragover = e => e.preventDefault(); b.ondrop = e => { e.preventDefault(); if (drag !== null) { s.fill[+b.dataset.gap] = drag; drag = null; sel = s.fill.findIndex(x => x === null); store.save(); draw(); } }; });
      $$('[data-chip]', area).forEach(b => { b.onclick = () => { const target = sel >= 0 && s.fill[sel] === null ? sel : s.fill.findIndex(x => x === null); if (target < 0) return toast('Every gap is full. Tap one to empty it.'); s.fill[target] = +b.dataset.chip; sel = s.fill.findIndex(x => x === null); store.save(); draw(); const nx = $('.chip:not([disabled])', area); if (nx) nx.focus(); }; b.ondragstart = e => { drag = +b.dataset.chip; e.dataTransfer.setData('text/plain', b.dataset.chip); }; });
    };
    draw();
    const code = () => fillTemplate(t.template, s.fill.map(v => v === null ? '___' : chips[v].text));
    return { async check() {
      const empty = s.fill.filter(v => v === null).length; if (empty) return { ok: false, msg: `${empty} gap${empty === 1 ? '' : 's'} still empty.` };
      const wrong = s.fill.map((v, k) => t.answers[k].includes(chips[v].text) ? -1 : k).filter(k => k >= 0);
      if (!wrong.length) return { ok: true, msg: t.explain };
      if (t.model && t.runCheck !== false) { const r = await checkPy(code(), t.model, t.cases || [{}], { chart: t.chart }); if (r.ok) return { ok: true, msg: (t.explain || '') + ' (That’s not the chip Sheetah had in mind, but it works.)' }; }
      return { ok: false, msg: `Gap ${wrong.map(k => k + 1).join(' and gap ')} ${wrong.length === 1 ? 'isn’t' : 'aren’t'} right yet. ${t.gapWhy && t.gapWhy[wrong[0]] ? t.gapWhy[wrong[0]] : ''}`, yours: code(), caution: t.cautionOnWrong || null };
    }, put() { s.fill = t.answers.map(a => chips.findIndex(ch => ch.text === a[0])); store.save(); draw(); } };
  },
  plan(t, area, ts, { lv }) {
    const s = ts();
    if (lv !== 'B') { area.innerHTML = `<label class="small muted">Write the steps your program will take, one per line, before you write any code.<textarea class="plan-in" rows="5">${esc(s.text || '')}</textarea></label>`; const ta = $('.plan-in', area); ta.oninput = () => { s.text = ta.value; store.save(); };
      return { async check() { const steps = ta.value.split('\n').filter(x => x.trim().length > 3); if (steps.length < 3) return { ok: false, msg: 'Write at least three steps, one per line.' }; return { ok: true, msg: 'Plan saved. Here is Sheetah’s, to compare with yours:', extra: `<ol class="small">${t.steps.map(x => `<li>${md(x)}</li>`).join('')}</ol>` }; } }; }
    if (!s.order || s.order.length !== t.steps.length) s.order = shuffle(t.steps.map((_, k) => k));
    const draw = () => { area.innerHTML = `<ol class="order plan-order">${s.order.map((k, j) => `<li data-j="${j}"><span>⋮⋮</span> ${md(t.steps[k])} <button class="mini" data-d="up" data-j="${j}" aria-label="Move up" type="button">↑</button><button class="mini" data-d="down" data-j="${j}" aria-label="Move down" type="button">↓</button></li>`).join('')}</ol>`;
      $$('button[data-d]', area).forEach(b => b.onclick = () => { const j = +b.dataset.j, o = s.order; const k = b.dataset.d === 'up' ? j - 1 : j + 1; if (k < 0 || k >= o.length) return; [o[j], o[k]] = [o[k], o[j]]; store.save(); draw(); const nb = $(`button[data-d="${b.dataset.d}"][data-j="${k}"]`, area); if (nb) nb.focus(); });
      let drag = null; $$('li[data-j]', area).forEach(li => { li.draggable = true; li.ondragstart = () => { drag = +li.dataset.j; }; li.ondragover = e => e.preventDefault(); li.ondrop = e => { e.preventDefault(); const to = +li.dataset.j; if (drag === null || drag === to) return; const [x] = s.order.splice(drag, 1); s.order.splice(to, 0, x); drag = null; store.save(); draw(); }; }); };
    draw();
    return { async check() { const bad = s.order.findIndex((k, j) => k !== j); if (bad < 0) return { ok: true, msg: 'That’s the plan. Now build it.' }; return { ok: false, msg: `Step ${bad + 1} isn’t in the right place yet. What has to happen before it can?`, yours: s.order.map(k => t.steps[k]).join(' → ') }; }, put() { s.order = t.steps.map((_, k) => k); store.save(); draw(); } };
  },
  fix: editorRung, change: editorRung, write: editorRung,
};

// Fix, Change and Write: an editor with Run, Step through and hidden tests
function editorRung(t, area, ts, { rules, lv }) {
  const s = ts(); if (s.code === undefined) s.code = t.start || '';
  const needsInput = usesInput(t.model) || usesInput(t.start);
  // files: the folder the program runs in. It starts with the task's files and keeps what each run writes, until Start again.
  const usesFiles = !!(t.files || t.checkFiles || /\bopen\(|openpyxl|read_excel|to_excel|read_csv|to_csv/.test(t.model || ''));
  const startFiles = () => stripPreviews({ ...(t.files || {}) });
  if (usesFiles && !s.files) s.files = startFiles(); else if (t.files) stripPreviews(t.files);
  area.innerHTML = `${t.kind === 'fix' && t.error ? `<details class="errshow" open><summary>The error it gives now</summary>${pre(t.error, 'err')}${figsHTML(t.errorFigs, { tag: '' })}</details>` : ''}${t.kind === 'change' && t.spec ? `<div class="spec">${md(t.spec)}</div>` : ''}
    <div class="pyed-host"></div>
    ${needsInput ? `<label class="small stdin-l">Input · one line for each <code>input()</code><textarea class="stdin mono" rows="${Math.max(1, (t.sample || []).length)}" spellcheck="false">${esc((s.stdin ?? (t.sample || []).join('\n')))}</textarea></label>` : ''}
    <div class="row pyrun"><button class="btn ghost sm run" type="button" title="Ctrl+Enter">▶ Run</button><button class="btn ghost sm stepb" type="button">👣 Step through</button><button class="btn ghost sm reset" type="button">↺ Start again</button></div>
    <div class="console" hidden></div>${usesFiles ? '<div class="files-host"></div>' : ''}<div class="sp-host" hidden></div>`;
  const ed = new PyEditor($('.pyed-host', area), { code: s.code, minLines: t.lines || Math.max(4, String(t.model || '').split('\n').length + 1), onChange: v => { s.code = v; store.save(); }, onRun: () => run(false) });
  const inp = $('.stdin', area); if (inp) inp.oninput = () => { s.stdin = inp.value; store.save(); };
  const con = $('.console', area), sp = $('.sp-host', area);
  const stdin = () => inp ? inp.value.split('\n').filter((x, k, a) => x !== '' || k < a.length - 1) : [];
  const fh = $('.files-host', area);
  const drawFiles = (changed = []) => { if (!fh) return; fh.innerHTML = filesHTML(s.files, { changed }) + `<p class="small"><button class="linkbtn rsf" type="button">Put the files back as they started</button></p>`; $('.rsf', fh).onclick = () => { s.files = startFiles(); store.save(); drawFiles(); toast('Files put back.'); }; };
  drawFiles();
  const run = async (trace) => {
    con.hidden = false; con.innerHTML = '<p class="muted small">Running…</p>'; sp.hidden = true;
    const before = s.files;
    // a seeded example (a game with random numbers): when the Input box holds that example's lines, use its seed so the example plays out as shown
    const sc = (t.cases || []).find(c => c.seed != null && (c.stdin || []).join('\n') === stdin().join('\n'));
    const r = await runPy(ed.value, { stdin: stdin(), trace: trace || rules.stepper, maxTrace: 600, files: usesFiles ? s.files : null, seed: sc ? sc.seed : null });
    if (usesFiles && r.files) { s.files = stripPreviews(r.files); store.save(); drawFiles(changedFiles(before, r.files)); }
    const ex = explainError(r.err, ed.value); if (r.err && r.err.line) ed.mark(r.err.line, 'err'); else ed.mark(null);
    con.innerHTML = `${r.figures && r.figures.length && !r.out ? '' : `<span class="sp-tag">Output</span>${pre(r.out)}`}${figsHTML(r.figures)}${r.err ? `${pre(r.err.tb || r.err.msg, 'err')}<div class="explain"><b>${esc(ex.title)}</b><p>${md(ex.plain)}</p>${ex.fix ? `<p class="small"><b>Try:</b> ${md(ex.fix)}</p>` : ''}</div>${ex.caution ? cautionBox(ex.caution) : ''}` : ''}${needsInput && r.inputsLeft ? `<p class="muted small">${r.inputsLeft} line${r.inputsLeft === 1 ? '' : 's'} of input weren’t used.</p>` : ''}`;
    if (r.steps && r.steps.length > 1 && (trace || rules.stepper)) { sp.hidden = false; new Stepper(sp, ed.value, r, { onLine: l => ed.mark(l, 'stepl'), startAt: trace ? 0 : r.steps.length - 1 }); }
  };
  $('.run', area).onclick = () => run(false); $('.stepb', area).onclick = () => run(true);
  $('.reset', area).onclick = () => { ed.value = t.start || ''; s.code = ed.value; if (usesFiles) { s.files = startFiles(); drawFiles(); } store.save(); con.hidden = true; sp.hidden = true; };
  return {
    async check() {
      const code = ed.value; if (!code.trim()) return { ok: false, msg: 'Write some code first.' };
      if ((t.kind === 'fix' || t.kind === 'change') && norm(code) === norm(t.start)) return { ok: false, msg: t.kind === 'fix' ? 'This is still the broken code. Read the error, find the line it names, and change it.' : 'This is still the starting code. Change it to the new spec.' };
      const r = await checkPy(code, t.model, t.cases || [{}], { compare: t.compare, loose: t.loose, checkFiles: t.checkFiles, chart: t.chart });
      const f = r.features || []; const missing = (t.need || []).filter(x => !f.includes(x)); const banned = (t.ban || []).filter(x => f.includes(x)); const cautions = codeCautions(f);
      const c0 = r.cases.find(x => !x.ok);
      if (c0) { const fb = caseFeedback(c0, code, t, t.kind); if (c0.err && c0.err.line) ed.mark(c0.err.line, 'err'); return fb; }
      if (missing.length) return { ok: false, msg: `It gives the right answers, but this rung asks you to use ${missing.map(featureName).join(' and ')}.`, yours: code };
      if (banned.length) return { ok: false, msg: `It works, but this rung asks you not to use ${banned.map(featureName).join(' or ')}.`, yours: code };
      const n = r.cases.length;
      return { ok: true, msg: `${t.explain || 'It passes.'}`, extra: `<details class="what"><summary>What Sheetah checked</summary><ul>${r.cases.map((x, k) => `<li>✓ ${x.label ? esc(x.label) : k === 0 ? 'The example' : 'A hidden case'}${x.stdin && x.stdin.length ? `: input ${x.stdin.map(v => `<code>${esc(v)}</code>`).join(', ')}` : ''}${x.expr ? `: <code>${esc(x.expr)}</code>` : ''}</li>`).join('')}${(t.need || []).map(x => `<li>✓ Uses ${esc(featureName(x))}</li>`).join('')}</ul><p class="muted small">${n} case${n === 1 ? '' : 's'}, compared with the model answer’s output.</p></details>${cautions.map(cautionBox).join('')}` };
    },
    put() { ed.value = t.model; s.code = t.model; store.save(); },
  };
}

// what went wrong on one test case, in plain words
export function caseFeedback(c0, code, t, kind) {
  const inputTxt = c0.stdin && c0.stdin.length ? ` with the input ${c0.stdin.map(v => `\`${v}\``).join(', ')}` : c0.expr ? ` for \`${c0.expr}\`` : '';
  const which = c0.hidden ? `On a case you haven’t tried${inputTxt}` : `On the example${inputTxt}`;
  if (c0.err) { const ex = explainError(c0.err, code); return { ok: false, msg: `${which}, your code stops with an error. **${ex.title}.** ${ex.plain}`, extra: `${pre(c0.err.tb || c0.err.msg, 'err')}${ex.fix ? `<p class="small"><b>Try:</b> ${md(ex.fix)}</p>` : ''}`, yours: code, caution: ex.caution }; }
  if (c0.problems.includes('value')) return { ok: false, msg: `${which}, it gives back \`${c0.gotValue}\` but should give \`${c0.wantValue}\`.`, yours: code };
  const fileP = c0.problems.find(p => p.startsWith('file:')); if (fileP && !c0.problems.includes('out')) { const fn = fileP.slice(5); const d = (c0.fileDiff || {})[fn] || {};
    if (d.picture) return { ok: false, msg: `${which}, ${d.diffs[0]}`, yours: code };
    if (d.html) {
      return { ok: false, msg: `${which}, the web page **${fn}** isn’t right yet.`, extra: `<ul class="xldiffs">${d.diffs.map(x => `<li>${esc(x)}</li>`).join('')}</ul><div class="cmp"><div><span class="sp-tag">Your ${esc(fn)}</span>${d.got == null ? pre('(your program didn’t write this page)') : pageHTML(d.got, d.gotPics, 'Your page')}</div><div><span class="sp-tag">Expected</span>${pageHTML(d.want || '', d.wantPics, 'The expected page')}</div></div>`, yours: code, caution: t.cautionOnWrong || t.caution_on_wrong || null }; }
    if (d.diffs) { const marks = d.diffs.map(x => (/^(.*?![A-Z]+\d+|[A-Z]+\d+) (holds|has|should)/.exec(x) || [])[1]).filter(Boolean); /* the cells named in the differences are outlined in both workbooks */
      return { ok: false, msg: `${which}, the workbook **${fn}** isn’t right yet.`, extra: `<ul class="xldiffs">${d.diffs.map(x => `<li>${esc(x)}</li>`).join('')}</ul><div class="cmp"><div><span class="sp-tag">Your ${esc(fn)}</span>${d.got ? workbookHTML(previewOf(d.got), { marks }) : pre('(your program didn’t save this file)')}</div><div><span class="sp-tag">Expected</span>${workbookHTML(previewOf(d.want), { marks })}</div></div>`, yours: code, caution: t.cautionOnWrong || t.caution_on_wrong || null }; }
    return { ok: false, msg: `${which}, the file **${fn}** doesn’t hold what it should.`, extra: `<div class="cmp"><div><span class="sp-tag">Your ${esc(fn)}</span>${pre(d.got == null ? '(your program didn’t write this file)' : d.got)}</div><div><span class="sp-tag">Expected</span>${pre(d.want || '')}</div></div>`, yours: code, caution: t.cautionOnWrong || t.caution_on_wrong || null }; }
  if (c0.problems.includes('chart') && !c0.problems.includes('out')) { const two = (c0.gotFigs || []).length && (c0.wantFigs || []).length;
    return { ok: false, msg: `${which}, the chart isn’t right yet.`, extra: `<ul class="xldiffs">${(c0.chartDiffs || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul>${two || (c0.wantFigs || []).length ? `<div class="cmp"><div><span class="sp-tag">Yours</span>${(c0.gotFigs || []).length ? figsHTML(c0.gotFigs, { tag: '' }) : pre('(no chart)')}</div><div><span class="sp-tag">Expected</span>${figsHTML(c0.wantFigs, { tag: '' })}</div></div>` : ''}`, yours: code, caution: t.cautionOnWrong || t.caution_on_wrong || null }; }
  const caution = guessCaution(c0, t);
  return { ok: false, msg: `${which}, the output isn’t right yet.`, extra: `<div class="cmp"><div><span class="sp-tag">Yours</span>${pre(c0.got)}</div><div><span class="sp-tag">Expected</span>${pre(c0.want)}</div></div>`, yours: code, caution };
}
// a wrong answer that looks like a famous mistake
function guessCaution(c0, t) {
  const g = norm(c0.got).split('\n'), w = norm(c0.want).split('\n');
  if (t.cautionOnWrong || t.caution_on_wrong) return t.cautionOnWrong || t.caution_on_wrong;
  if (g.length === w.length - 1 && w.slice(0, -1).join('\n') === g.join('\n')) return 'range-stop';
  return null;
}

// a table of moments: one row per chosen step, a column per variable; some cells blank for the learner
export function traceTable(t, vals, solved = false) {
  const cols = t.cols; const L = t.code.split('\n');
  return `<div class="tblwrap"><table class="tbl trace"><thead><tr><th>After line</th>${cols.map(v => `<th><code>${esc(v)}</code></th>`).join('')}${t.showOut ? '<th>Printed</th>' : ''}</tr></thead><tbody>${t.rows.map((r, ri) => `<tr><td class="trl"><b>${r.line}</b> <code class="small trl-code">${esc((L[r.line - 1] || '').trim())}</code></td>${cols.map(v => { const want = r.vals[v]; const blank = (r.blank || []).includes(v); if (want === undefined) return '<td class="muted">—</td>'; if (!blank || solved) return `<td><code>${esc(want)}</code></td>`; return `<td><input class="trace-in mono" data-k="${ri}:${esc(v)}" data-want="${esc(want)}" value="${esc((vals || {})[ri + ':' + v] || '')}" aria-label="${esc(v)} after line ${r.line}" autocomplete="off" spellcheck="false"></td>`; }).join('')}${t.showOut ? `<td><code>${esc(r.out || '')}</code></td>` : ''}</tr>`).join('')}</tbody></table></div>`;
}
