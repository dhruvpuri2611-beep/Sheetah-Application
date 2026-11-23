// Course levels (Beginner, Intermediate, Master) for courses that have them, such as the Python courses.
// A learner picks a level per course. Levels stack: Intermediate includes every Beginner lesson.
// Progress at a level = lessons finished at or below it ÷ all lessons at or below it.
import { store } from './store.js';
export const LEVEL_ORDER = ['B', 'I', 'M'];
export const LEVEL_NAMES = { B: 'Beginner', I: 'Intermediate', M: 'Master' };
export const hasLevels = c => !!(c && c.levels && c.levels.length);
export const rank = lv => LEVEL_ORDER.indexOf(lv || 'B');
export function chosenLevel(c) { if (!hasLevels(c)) return null; const v = (store.d.levels || {})[c.id]; return c.levels.some(l => l.id === v) ? v : null; }
// the level that decides what's shown: the chosen one, or the course's first level until one is picked
export const activeLevel = c => chosenLevel(c) || (hasLevels(c) ? c.levels[0].id : null);
export function setLevel(c, lv) { store.d.levels = store.d.levels || {}; store.d.levels[c.id] = lv; store.save(); }
export const lessonLevel = l => l.level || 'B';
// is this lesson part of the learner's level? (lessons above it are "stretch" lessons: shown greyed, still open)
export const inLevel = (c, l, lv = activeLevel(c)) => !hasLevels(c) || rank(lessonLevel(l)) <= rank(lv);
export const isStretch = (c, l) => hasLevels(c) && !inLevel(c, l);
export const levelLessons = (c, lessons, lv) => hasLevels(c) ? lessons.filter(l => inLevel(c, l, lv)) : lessons;
const doneId = id => !!(store.d.lessons[id] && store.d.lessons[id].status === 'done');
// one row per level the course offers: done / total at or below that level
export function levelBreakdown(c) {
  const all = []; for (const m of c.modules) for (const l of m.lessons) all.push(l);
  return c.levels.map(L => { const ls = all.filter(l => rank(lessonLevel(l)) <= rank(L.id)); const done = ls.filter(l => doneId(l.id)).length; return { ...L, name: L.name || LEVEL_NAMES[L.id], done, total: ls.length, pct: ls.length ? done / ls.length : 0 }; });
}
// lessons ticked because a shared lecture was finished in another course (the shared library arrives with wave 2)
export const sharedTicks = () => [];
// project and exam records are kept per level for courses with levels ("py1@B"), and per course otherwise ("c1")
export const recKey = (c, lv = activeLevel(c)) => hasLevels(c) ? `${c.id}@${lv}` : c.id;
// the exam set for the learner's level: course.exam, with that level's own numbers when it has them
export const examFor = c => { const E = c.exam || {}; const lv = activeLevel(c); return { ...E, ...((E.byLevel || {})[lv] || {}), level: hasLevels(c) ? lv : null }; };
