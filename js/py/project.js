// The course project for Python courses: one brief, a checklist per level, a written plan first,
// hidden tests (including cases the learner never saw), and three "explain your code" questions on submission.
// Score = 80% from the checklist's hidden tests + 20% from the explain questions. Pass mark 70%, two submissions.
import { store } from '../store.js';
import { esc, md, $, $$, toast, shuffle } from '../ui.js';
import { PyEditor, pyBlock, filesHTML, changedFiles, stripPreviews } from './editor.js';
import { Stepper } from './stepper.js';
import { runPy, checkPy, explainPy, pyReady } from './pyrun.js';
import { explainError } from './explain.js';
import { caseFeedback, cautionBox } from './pylab.js';
import { activeLevel, LEVEL_NAMES, rank, hasLevels } from '../levels.js';
import { who } from '../access.js';

const PASS = 70, TEST_SHARE = 80, EXPLAIN_SHARE = 20;
const pre = (s, cls = '') => `<pre class="pyout ${cls}">${esc(s) || '<span class="muted">(nothing printed)</span>'}</pre>`;
const fmtDate = iso => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

// the checklist for a level: every item at or below it, in order (Beginner first, then each level adds more)
export function checklistFor(P, lv) {
  const out = []; for (const L of ['B', 'I', 'M']) { if (rank(L) > rank(lv) || !P.levels[L]) continue; for (const it of P.levels[L].checklist) out.push({ ...it, level: L }); }
  // an item a higher level re-specifies (same id) replaces the lower one
  const seen = new Map(); for (const it of out) seen.set(it.id, it); return [...seen.values()];
}
const modelFor = (P, lv) => { for (const L of ['M', 'I', 'B']) if (rank(L) <= rank(lv) && P.levels[L] && P.levels[L].model) return P.levels[L].model; return ''; };
const levelOf = (P, c) => { const lv = hasLevels(c) ? activeLevel(c) : 'B'; return P.levels[lv] ? lv : Object.keys(P.levels).filter(L => rank(L) <= rank(lv)).pop() || 'B'; };

export function renderPyProject(main, { c, P, ps, crumbs, qhelp, mascot, confetti, confirmBox, rerender }) {
  const lv = levelOf(P, c); const L = P.levels[lv]; const items = checklistFor(P, lv); const model = modelFor(P, lv);
  const isAdmin = who() === 'admin';
  const startFiles = () => stripPreviews({ ...(L.files || P.files || {}) }); const asks = /\binput\s*\(/.test(model);
  ps.code = ps.code ?? (P.start || ''); if (!ps.files || (L.files && ps.filesLevel !== lv)) { ps.files = startFiles(); ps.filesLevel = lv; } ps.checks = ps.checks || {};
  const tries = ps.tries || (ps.tries = []); const left = 2 - tries.length;
  const planned = (ps.plan || '').split('\n').filter(x => x.trim().length > 3).length >= 3;
  main.innerHTML = `${crumbs([[c.title, '#/course/' + c.id], ['Course project']])}
  <section class="card"><div class="row between"><div><p class="eyebrow">Course project · about ${P.hours || 4} hours · pass mark ${PASS}% ${qhelp('pyproject')}</p><h1>${esc(P.title)}</h1>
   ${hasLevels(c) ? `<p class="small">Your level: <span class="tag lv-${lv}">${LEVEL_NAMES[lv]}</span> · the checklist below is for this level. <a href="#/course/${c.id}">Change level</a></p>` : ''}</div>${mascot('focus')}</div>
   <div class="lead">${md(P.brief)}</div>${P.story ? `<p>${md(P.story)}</p>` : ''}
   ${L.session ? `<details class="what" open><summary>What ${asks ? 'a session' : 'a run on the starting folder'} looks like at ${LEVEL_NAMES[lv]}</summary>${pre(L.session)}</details>` : ''}</section>
  <section class="card"><h2>Your checklist</h2><p class="small muted">Hidden tests check each line with the inputs in the brief and with others you haven’t seen. <b>Check my checklist</b> tries the examples as often as you like; only a submission counts.</p>
   <ol class="pjlist">${items.map(it => { const st = ps.checks[it.id]; return `<li class="${st === true ? 'ok' : st === false ? 'no' : ''}" data-item="${esc(it.id)}"><span class="pjst">${st === true ? '✓' : st === false ? '✗' : '○'}</span><span>${md(it.text)}${hasLevels(c) && (it.since || it.level) !== 'B' ? ` <span class="tag lv-${it.since || it.level}">${LEVEL_NAMES[it.since || it.level]}</span>` : ''}</span></li>`; }).join('')}</ol>
   <div class="pjfb"></div></section>
  <section class="card"><h2>1. Plan it</h2><p>Before any code: write the steps your program takes, one per line, in plain words. At least three.</p>
   <textarea class="plan-in" rows="6" placeholder="${esc(P.planPlaceholder || '1. Start with an empty list of expenses\n2. Ask for a command, again and again\n3. …').replace(/\n/g, '&#10;')}">${esc(ps.plan || '')}</textarea>
   <div class="row"><button class="btn ghost sm" id="pjPlan" type="button">${planned ? 'Update my plan' : 'Save my plan'}</button>${planned ? '<span class="ok small">✓ Plan saved</span>' : ''}</div>
   ${P.planHint ? `<details class="small"><summary>Stuck? A nudge</summary><p>${md(P.planHint)}</p></details>` : ''}</section>
  <section class="card ${planned ? '' : 'pjlocked'}"><h2>2. Build it</h2>${planned ? `
   <div class="pyed-host"></div>
   <label class="small stdin-l" ${asks ? '' : 'hidden'}>Input · one line for each <code>input()</code>, in order<textarea class="stdin mono" rows="4" spellcheck="false">${esc(ps.stdin ?? (L.sample || []).join('\n'))}</textarea></label>
   <div class="row pyrun"><button class="btn ghost sm run" type="button" title="Ctrl+Enter">▶ Run</button><button class="btn ghost sm stepb" type="button">👣 Step through</button><button class="btn sm" id="pjCheck" type="button">Check my checklist</button></div>
   <div class="console" hidden></div><div class="files-host"></div><div class="sp-host" hidden></div>` : '<p class="muted">Save your plan first: the editor opens once Sheetah has it.</p>'}</section>
  <section class="card"><h2>3. Submit</h2>
   <p>${left > 0 ? `You have <b>${left}</b> submission${left === 1 ? '' : 's'} left. Your best score counts.` : 'You have used both submissions.'}${ps.best !== undefined ? ` Best so far: <b>${ps.best}%</b>${ps.best >= PASS ? ' · passed ✓' : ''}.` : ''}</p>
   <p class="small muted">Sheetah runs every line of the checklist on hidden cases (${TEST_SHARE}% of the score), then asks you three questions about lines of <b>your</b> code (${EXPLAIN_SHARE}%). You may get help while you build, but you should be able to explain every line you hand in.</p>
   ${(left > 0 || isAdmin) && planned ? '<button class="btn" id="pjSubmit" type="button">Submit my program</button>' : ''}
   <div class="pjres">${ps.last ? resultHTML(ps.last, items) : ''}</div>
   ${tries.length ? `<h3>Your submissions</h3><ul>${tries.map(t => `<li>${fmtDate(t.at)}: <b>${t.pct}%</b> (tests ${t.tests}%, explain ${t.explain}/${t.asked})</li>`).join('')}</ul>` : ''}</section>`;

  const planBox = $('.plan-in', main);
  $('#pjPlan').onclick = () => { const n = planBox.value.split('\n').filter(x => x.trim().length > 3).length; if (n < 3) return toast('Write at least three steps, one per line.'); ps.plan = planBox.value; store.save(); toast('Plan saved.'); rerender(); };
  planBox.oninput = () => { if (planned) { ps.plan = planBox.value; store.save(); } };
  if (!planned) return;

  const ed = new PyEditor($('.pyed-host', main), { code: ps.code, minLines: 18, label: 'Your program', onChange: v => { ps.code = v; store.save(); }, onRun: () => run(false) });
  const inp = $('.stdin', main); inp.oninput = () => { ps.stdin = inp.value; store.save(); };
  const con = $('.console', main), sp = $('.sp-host', main), fh = $('.files-host', main);
  const drawFiles = (changed = []) => { fh.innerHTML = filesHTML(ps.files, { changed }) + `<p class="small"><button class="linkbtn rsf" type="button">${Object.keys(L.files || P.files || {}).length ? 'Put the files back as they started' : 'Empty the folder (as on a first run)'}</button></p>`; $('.rsf', fh).onclick = () => { ps.files = startFiles(); store.save(); drawFiles(); toast('Folder reset.'); }; };
  drawFiles();
  const stdin = () => inp.value.split('\n').filter((x, k, a) => x !== '' || k < a.length - 1);
  const run = async trace => {
    con.hidden = false; con.innerHTML = '<p class="muted small">Running… (the first run loads Python, a few seconds)</p>'; sp.hidden = true;
    const before = ps.files; const r = await runPy(ed.value, { stdin: stdin(), trace, maxTrace: 1500, files: ps.files });
    if (r.files) { ps.files = stripPreviews(r.files); store.save(); drawFiles(changedFiles(before, r.files)); }
    const ex = explainError(r.err, ed.value); if (r.err && r.err.line) ed.mark(r.err.line, 'err'); else ed.mark(null);
    const ranOut = r.err && r.err.type === 'EOFError';
    con.innerHTML = `<span class="sp-tag">Output</span>${pre(r.out)}${r.err && !ranOut ? `${pre(r.err.tb || r.err.msg, 'err')}<div class="explain"><b>${esc(ex.title)}</b><p>${md(ex.plain)}</p>${ex.fix ? `<p class="small"><b>Try:</b> ${md(ex.fix)}</p>` : ''}</div>${ex.caution ? cautionBox(ex.caution) : ''}` : ''}${ranOut ? '<p class="muted small">The program wanted more input than the box holds. Add lines to the input box (end with <code>quit</code>), or that’s fine if you were just trying the start.</p>' : ''}`;
    if (trace && r.steps && r.steps.length > 1) { sp.hidden = false; new Stepper(sp, ed.value, r, { onLine: l => ed.mark(l, 'stepl') }); }
  };
  $('.run', main).onclick = () => run(false); $('.stepb', main).onclick = () => run(true);

  // practice check: the first (visible) case of every checklist line
  $('#pjCheck').onclick = async () => {
    const fb = $('.pjfb', main); fb.innerHTML = '<p class="muted small">Checking each line of the checklist…</p>'; await pyReady();
    let firstBad = null;
    for (const it of items) {
      const li = $(`[data-item="${CSS.escape(it.id)}"]`, main); li.classList.remove('ok', 'no'); $('.pjst', li).textContent = '…';
      const r = await checkPy(ed.value, model, it.cases.slice(0, 1), { checkFiles: it.checkFiles, compare: it.compare, chart: it.chart });
      ps.checks[it.id] = r.ok; li.classList.add(r.ok ? 'ok' : 'no'); $('.pjst', li).textContent = r.ok ? '✓' : '✗';
      if (!r.ok && !firstBad) firstBad = { it, c0: r.cases.find(x => !x.ok) };
    }
    store.save();
    if (!firstBad) { fb.innerHTML = '<p class="ok">Every example passes. The hidden cases try other inputs too, so test a few of your own before you submit.</p>'; return; }
    const f = caseFeedback({ ...firstBad.c0, hidden: false }, ed.value, {}, 'write');
    fb.innerHTML = `<div class="fb no"><p><b>First one to fix:</b> ${md(firstBad.it.text)}</p><p>${md(f.msg)}</p>${f.extra || ''}${f.caution ? cautionBox(f.caution) : ''}</div>`;
  };

  const sb = $('#pjSubmit');
  if (sb) sb.onclick = async () => {
    if (!await confirmBox(`Submit your program as submission ${tries.length + 1} of 2? Sheetah runs the hidden tests, then asks three questions about your code.`, 'Submit')) return;
    const res = $('.pjres', main); res.innerHTML = '<p class="muted">Running the hidden tests on your program…</p>'; await pyReady();
    const code = ed.value; const rows = []; let got = 0, all = 0;
    for (const it of items) {
      const r = await checkPy(code, model, it.cases, { checkFiles: it.checkFiles, compare: it.compare, chart: it.chart, stopAtFirst: true });
      const w = it.weight || 1; all += w; if (r.ok) got += w;
      const c0 = r.cases.find(x => !x.ok); rows.push({ id: it.id, ok: r.ok, n: it.cases.length, why: c0 ? caseFeedback(c0, code, {}, 'write').msg : '' });
      ps.checks[it.id] = r.ok;
    }
    const testsPct = all ? Math.round(100 * got / all) : 0;
    const qs = (await explainPy(code, 3)).map(q => { const idx = shuffle(q.options.map((_, i) => i)); return { ...q, options: idx.map(i => q.options[i]), answer: idx.indexOf(q.answer) }; });
    res.innerHTML = `<p>Tests done: <b>${testsPct}%</b> of the checklist passes. Now three questions about your own code.</p>${qs.length ? `<form class="pjex">${qs.map((q, k) => `<fieldset class="pjq"><legend><b>Question ${k + 1}.</b> Line ${q.line} of your program:</legend>${pyBlock(q.code, { numbers: false })}<p>${md(q.q)}</p>${q.options.map((o, i) => `<label class="ck"><input type="radio" name="q${k}" value="${i}"> ${md(o)}</label>`).join('')}</fieldset>`).join('')}<button class="btn" type="submit">Finish my submission</button></form>` : '<p class="muted">Your program is short enough that there is nothing to ask about. The tests make the whole score.</p><button class="btn" id="pjFin" type="button">Finish my submission</button>'}`;
    const finish = answers => {
      const right = qs.filter((q, k) => answers[k] === q.answer).length;
      const pct = qs.length ? Math.round(testsPct * TEST_SHARE / 100 + EXPLAIN_SHARE * right / qs.length) : testsPct;
      const last = { at: new Date().toISOString(), pct, tests: testsPct, explain: right, asked: qs.length, rows, qs: qs.map((q, k) => ({ q: q.q, line: q.line, code: q.code, ok: answers[k] === q.answer, right: q.options[q.answer], why: q.why })), level: lv };
      if (!isAdmin || tries.length < 2) tries.push({ at: last.at, pct, tests: testsPct, explain: right, asked: qs.length, level: lv });
      ps.last = last; ps.best = Math.max(ps.best ?? 0, pct); store.save(); if (pct >= PASS) confetti(); rerender();
    };
    const form = $('.pjex', res); if (form) form.onsubmit = e => { e.preventDefault(); const a = qs.map((_, k) => { const x = form.querySelector(`input[name=q${k}]:checked`); return x ? +x.value : -1; }); if (a.includes(-1)) return toast('Answer all three questions first.'); finish(a); };
    const fin = $('#pjFin', res); if (fin) fin.onclick = () => finish([]);
  };
}

function resultHTML(r, items) {
  const name = id => (items.find(x => x.id === id) || { text: id }).text;
  return `<div class="card inner ${r.pct >= PASS ? 'okbox' : 'warnbox'}"><h3>Last submission: ${r.pct}% ${r.pct >= PASS ? '· passed ✓' : '· not passed yet'}</h3>
   <p class="small">Checklist tests ${r.tests}% (worth ${TEST_SHARE}%) · explain your code ${r.explain} of ${r.asked} (worth ${EXPLAIN_SHARE}%)</p>
   <ul class="ticks pjrows">${r.rows.map(x => `<li class="${x.ok ? 'ok' : 'no'}">${x.ok ? '✓' : '✗'} ${md(name(x.id))}${x.ok ? '' : `<br><span class="small">${md(x.why)}</span>`}</li>`).join('')}</ul>
   ${r.qs && r.qs.length ? `<h4>Explain your code</h4><ul class="pjrows">${r.qs.map(q => `<li class="${q.ok ? 'ok' : 'no'}">${q.ok ? '✓' : '✗'} Line ${q.line}: ${md(q.q)}${q.ok ? '' : `<br><span class="small">The answer: ${md(q.right)}. ${md(q.why)}</span>`}</li>`).join('')}</ul>` : ''}</div>`;
}
