# Sheetah's Python lab harness. It runs inside Pyodide (in a Web Worker) and does three jobs:
#   run   - run a learner's program with typed-in input, a step limit and a sandbox folder
#   trace - the same, recording every line for the step-through panel
#   check - run the learner's code and the model answer on hidden cases and compare them
# Everything comes back as plain JSON so the page never has to touch Python objects.
import ast, base64, builtins, io, json, os, sys, traceback

LAB_FILE = 'main.py'
SANDBOX = '/lab'
_real_input = builtins.input


class StepLimit(Exception):
    pass


def _short(v, n=80):
    try:
        r = repr(v)
    except Exception:
        r = '<?>'
    return r if len(r) <= n else r[:n - 1] + '…'


def _kind(v):
    t = type(v).__name__
    if t in ('function', 'builtin_function_or_method'):
        return 'function'
    return t


def _show_vars(d):
    out = []
    for k, v in d.items():
        if k.startswith('__') or k in ('_sheetah',):
            continue
        t = type(v).__name__
        if t in ('module',) or (t == 'function' and getattr(v, '__module__', None) != '__main__' and k not in d.get('__sheetah_user_fns__', ())):
            continue
        if t == 'type' and getattr(v, '__module__', '') != '__main__':
            continue
        if t == 'function':
            out.append([k, 'function ' + k + '()', 'function'])
        elif t == 'DataFrame':
            cols = [str(x) for x in list(v.columns)[:6]]
            out.append([k, '%d row%s × %d column%s: %s%s' % (v.shape[0], '' if v.shape[0] == 1 else 's', v.shape[1], '' if v.shape[1] == 1 else 's', ', '.join(cols), '…' if v.shape[1] > 6 else ''), 'DataFrame'])
        elif t == 'Series':
            out.append([k, '%d values%s: %s' % (len(v), (' named ' + str(v.name)) if v.name is not None else '', _short(list(v.head(5)), 60)), 'Series'])
        elif t == 'Workbook':
            out.append([k, 'workbook with sheets ' + ', '.join(repr(x) for x in v.sheetnames), 'Workbook'])
        elif t == 'Worksheet':
            out.append([k, 'sheet %r, %d rows × %d columns' % (v.title, v.max_row, v.max_column), 'Worksheet'])
        elif t in ('Cell', 'MergedCell'):
            out.append([k, 'cell %s holding %s' % (getattr(v, 'coordinate', '?'), _short(v.value, 40)), 'Cell'])
        elif t in ('TextIOWrapper', 'BufferedReader', 'BufferedWriter'):  # an open file: say which one, not Python's long repr
            out.append([k, '%s file %s, mode "%s"' % ('closed' if v.closed else 'open', getattr(v, 'name', '?'), getattr(v, 'mode', '?')), 'file'])
        else:
            out.append([k, _short(v), t])
    return out


BINARY_EXT = ('.xlsx', '.xlsm', '.xls', '.png', '.jpg', '.jpeg', '.gif', '.pdf', '.docx', '.pptx', '.zip')


def _reset_sandbox(files):
    """Text files are plain strings; binary files (an Excel workbook) come as {'b64': ...}.
    A name may hold folders, like "branches/pune.xlsx": they are made as needed."""
    import shutil
    os.makedirs(SANDBOX, exist_ok=True)
    os.chdir(SANDBOX)
    for name in os.listdir(SANDBOX):
        p = os.path.join(SANDBOX, name)
        if os.path.isdir(p):
            shutil.rmtree(p, ignore_errors=True)
        else:
            os.remove(p)
    for name, data in (files or {}).items():
        p = os.path.join(SANDBOX, name)
        if os.path.dirname(p) != SANDBOX:
            os.makedirs(os.path.dirname(p), exist_ok=True)
        if isinstance(data, dict):
            with open(p, 'wb') as f:
                f.write(base64.b64decode(data.get('b64', '')))
        else:
            with open(p, 'w', encoding='utf-8') as f:
                f.write(data)


def _read_sandbox(previews=True):
    out = {}
    names = []
    for root, dirs, fs in os.walk(SANDBOX):
        dirs.sort()
        for n in fs:
            names.append(os.path.relpath(os.path.join(root, n), SANDBOX).replace(os.sep, '/'))
    for name in sorted(names, key=lambda n: (n.count('/'), n)):
        p = os.path.join(SANDBOX, name)
        if len(out) >= 60:
            break
        if name.lower().endswith(BINARY_EXT):
            with open(p, 'rb') as f:
                raw = f.read()
            d = {'b64': base64.b64encode(raw[:3000000]).decode('ascii'), 'size': len(raw)}
            if previews and name.lower().endswith(('.xlsx', '.xlsm')):
                d['preview'] = xlsx_preview(raw)
            out[name] = d
            continue
        try:
            with open(p, encoding='utf-8') as f:
                out[name] = f.read()[:3000000 if name.lower().endswith(('.html', '.htm', '.svg')) else 20000]
        except Exception:
            out[name] = '(not a text file)'
    return out


# ---------- Excel workbooks ----------
def _cell_text(v):
    if v is None:
        return ''
    if isinstance(v, float):
        return ('%.10g' % v) if abs(v) < 1e15 else repr(v)
    if hasattr(v, 'isoformat'):
        t = v.isoformat()
        return t[:-9] if t.endswith('T00:00:00') else t.replace('T', ' ')
    return str(v)


CHART_KINDS = {'barChart': 'bar', 'bar3DChart': 'bar', 'lineChart': 'line', 'line3DChart': 'line', 'pieChart': 'pie', 'pie3DChart': 'pie',
               'doughnutChart': 'doughnut', 'areaChart': 'area', 'scatterChart': 'scatter'}
CF_OPS = {'lessThan': ('less than', lambda v, a, b: v < a), 'lessThanOrEqual': ('at most', lambda v, a, b: v <= a), 'greaterThan': ('more than', lambda v, a, b: v > a),
          'greaterThanOrEqual': ('at least', lambda v, a, b: v >= a), 'equal': ('equal to', lambda v, a, b: v == a), 'notEqual': ('not equal to', lambda v, a, b: v != a),
          'between': ('between', lambda v, a, b: a <= v <= b), 'notBetween': ('not between', lambda v, a, b: not (a <= v <= b))}


def _ref(f):
    """'Summary'!$B$2:$B$4 -> ('Summary', 'B2:B4')"""
    f = (f or '').replace('$', '')
    if '!' not in f:
        return None, f
    sh, rng = f.rsplit('!', 1)
    return sh.strip("'"), rng


def _ref_values(wb, f):
    sh, rng = _ref(f)
    try:
        ws = wb[sh] if sh else wb.active
        cells = ws[rng]
    except Exception:
        return []
    if not isinstance(cells, tuple):
        cells = ((cells,),)
    elif cells and not isinstance(cells[0], tuple):
        cells = (cells,)
    return [c.value for row in cells for c in row]


def _chart_title(ch):
    t = ch.title
    try:
        if t is not None and t.tx is not None and t.tx.rich is not None:
            return ''.join(r.t for p in t.tx.rich.p for r in (p.r or []))
    except Exception:
        pass
    return ''


def _series_name(wb, s):
    try:
        if s.tx is not None and s.tx.strRef is not None:
            v = _ref_values(wb, s.tx.strRef.f)
            return str(v[0]) if v and v[0] is not None else ''
        if s.tx is not None and s.tx.v is not None:
            return str(s.tx.v)
    except Exception:
        pass
    return ''


def _charts(wb, ws):
    out = []
    for ch in getattr(ws, '_charts', []):
        d = {'kind': CHART_KINDS.get(ch.tagname, ch.tagname.replace('Chart', '')), 'title': _chart_title(ch), 'series': []}
        if getattr(ch, 'barDir', None) == 'bar':
            d['dir'] = 'across'
        try:
            d['at'] = '%s%d' % (_col(ch.anchor._from.col + 1), ch.anchor._from.row + 1)
        except Exception:
            d['at'] = ''
        for s in ch.series:
            vf = s.val.numRef.f if s.val is not None and s.val.numRef is not None else ''
            cf = ''
            if s.cat is not None:
                cf = s.cat.strRef.f if s.cat.strRef is not None else (s.cat.numRef.f if s.cat.numRef is not None else '')
            d['series'].append({'name': _series_name(wb, s), 'vals': _ref(vf)[1], 'cats': _ref(cf)[1],
                                'v': [x if isinstance(x, (int, float)) else None for x in _ref_values(wb, vf)][:40],
                                'c': [_cell_text(x) for x in _ref_values(wb, cf)][:40] if cf else []})
        out.append(d)
    return out


def _cf_rules(ws):
    out = []
    try:
        for cf in ws.conditional_formatting:
            for r in cf.rules:
                fill = None
                try:
                    if r.dxf is not None and r.dxf.fill is not None:
                        fill = r.dxf.fill.fgColor.rgb if isinstance(r.dxf.fill.fgColor.rgb, str) else None
                        if (not fill or fill.endswith('000000')) and isinstance(r.dxf.fill.bgColor.rgb, str):
                            fill = r.dxf.fill.bgColor.rgb
                except Exception:
                    fill = None
                out.append({'range': str(cf.sqref), 'type': r.type, 'op': r.operator or '', 'f': [str(x) for x in (r.formula or [])], 'bg': (fill or '')[-6:]})
    except Exception:
        pass
    return out


def _cf_describe(r):
    if r['type'] == 'cellIs' and r['op'] in CF_OPS:
        return 'cells in %s %s %s' % (r['range'], CF_OPS[r['op']][0], ' and '.join(r['f']))
    return '%s rule on %s' % (r['type'], r['range'])


def _cf_paint(ws, rules, fmt, max_rows, max_cols):
    """Colour the preview's cells the way Excel would, for simple "cell value is …" rules."""
    from openpyxl.utils.cell import range_boundaries
    for r in rules:
        if r['type'] != 'cellIs' or r['op'] not in CF_OPS or not r['bg']:
            continue
        try:
            nums = [float(x) for x in r['f']]
        except Exception:
            continue
        a, b = nums[0], nums[1] if len(nums) > 1 else None
        for part in r['range'].split():
            try:
                c1, r1, c2, r2 = range_boundaries(part)
            except Exception:
                continue
            for row in range(r1, min(r2, max_rows) + 1):
                for col in range(c1, min(c2, max_cols) + 1):
                    v = ws.cell(row, col).value
                    if isinstance(v, (int, float)) and not isinstance(v, bool) and CF_OPS[r['op']][1](v, a, b):
                        fmt.setdefault('%d,%d' % (row, col), {})['bg'] = r['bg']


def xlsx_preview(raw, max_rows=40, max_cols=15):
    """What's inside a workbook, for the page to draw as sheets: values and formulas as typed, plus a little formatting."""
    try:
        import openpyxl
        wb = openpyxl.load_workbook(io.BytesIO(raw))
    except Exception as e:
        return {'error': 'Sheetah couldn\'t open this as a workbook (%s).' % type(e).__name__}
    sheets = []
    for ws in wb.worksheets:
        nr, nc = ws.max_row or 0, ws.max_column or 0
        if nr == 1 and nc == 1 and ws['A1'].value is None:
            nr = nc = 0
        rows, fmt = [], {}
        for r in range(1, min(nr, max_rows) + 1):
            row = []
            for c in range(1, min(nc, max_cols) + 1):
                cell = ws.cell(r, c)
                row.append(_cell_text(cell.value))
                f = {}
                if cell.font is not None and cell.font.b:
                    f['b'] = 1
                if cell.number_format and cell.number_format != 'General' and cell.value is not None:
                    f['nf'] = cell.number_format
                fill = cell.fill.fgColor.rgb if cell.fill is not None and cell.fill.fill_type == 'solid' and isinstance(cell.fill.fgColor.rgb, str) else None
                if fill:
                    f['bg'] = fill[-6:]
                if f:
                    fmt['%d,%d' % (r, c)] = f
            rows.append(row)
        widths = {}
        for letter, dim in ws.column_dimensions.items():
            if dim.width and dim.customWidth:
                widths[letter] = round(dim.width, 1)
        sh = {'name': ws.title, 'rows': rows, 'maxRow': nr, 'maxCol': nc, 'fmt': fmt, 'widths': widths,
              'freeze': ws.freeze_panes if isinstance(ws.freeze_panes, str) else None}
        charts, cf = _charts(wb, ws), _cf_rules(ws)
        if cf:
            _cf_paint(ws, cf, fmt, max_rows, max_cols)
            sh['cf'] = [dict(r, say=_cf_describe(r)) for r in cf]
        if charts:
            sh['charts'] = charts
        sheets.append(sh)
    return {'sheets': sheets, 'active': wb.sheetnames.index(wb.active.title) if wb.active is not None else 0}


def _col(c):
    s = ''
    while c:
        c, r = divmod(c - 1, 26)
        s = chr(65 + r) + s
    return s


def _same(a, b):
    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool) and not isinstance(b, bool):
        return abs(a - b) <= 1e-9 * max(1, abs(a), abs(b))
    if a in (None, '') and b in (None, ''):
        return True
    if isinstance(a, str) and isinstance(b, str):
        return a.rstrip() == b.rstrip()
    return a == b


def xlsx_diff(got, want, fmt=False, limit=6, sheets=None, parts=None):
    """Differences between the learner's workbook and the model's, in words: missing sheets, then cells.
    fmt=True also compares bold, number formats and fills. sheets limits the check to those sheets;
    parts picks what is compared (any of cells, fmt, charts, rules), for project checklists that test one thing at a time."""
    if parts is not None:
        parts = set(parts)
        fmt = 'fmt' in parts
    cells = parts is None or 'cells' in parts
    import openpyxl
    try:
        g = openpyxl.load_workbook(io.BytesIO(base64.b64decode(got['b64'])))
    except Exception:
        return ['Your file isn\'t a workbook Excel can open.']
    w = openpyxl.load_workbook(io.BytesIO(base64.b64decode(want['b64'])))
    out = []
    names = [x for x in w.sheetnames if sheets is None or x in sheets]
    for name in names:
        if name not in g.sheetnames:
            out.append('There is no sheet called "%s" (your sheets: %s).' % (name, ', '.join('"%s"' % x for x in g.sheetnames)))
    extra = [x for x in g.sheetnames if x not in w.sheetnames]
    if extra and not out and sheets is None:
        out.append('There is an extra sheet: %s.' % ', '.join('"%s"' % x for x in extra))
    for name in names:
        if name not in g.sheetnames:
            continue
        gs, ws_ = g[name], w[name]
        nr, nc = max(gs.max_row, ws_.max_row), max(gs.max_column, ws_.max_column)
        for r in range(1, nr + 1):
            for c in range(1, nc + 1):
                a, b = gs.cell(r, c), ws_.cell(r, c)
                ref = '%s!%s%d' % (name, _col(c), r) if len(w.sheetnames) > 1 else '%s%d' % (_col(c), r)
                if not _same(a.value, b.value):
                    if not cells:
                        continue
                    out.append('%s holds %s; it should hold %s.' % (ref, repr(a.value) if a.value not in (None, '') else 'nothing', repr(b.value) if b.value not in (None, '') else 'nothing'))
                elif fmt and b.value not in (None, ''):
                    if bool(a.font.b) != bool(b.font.b):
                        out.append('%s should %sbe bold.' % (ref, '' if b.font.b else 'not '))
                    elif (a.number_format or 'General') != (b.number_format or 'General'):
                        out.append('%s has number format %r; it should be %r.' % (ref, a.number_format, b.number_format))
                    else:
                        fa = a.fill.fgColor.rgb if a.fill.fill_type == 'solid' else None
                        fb = b.fill.fgColor.rgb if b.fill.fill_type == 'solid' else None
                        if (fa or '')[-6:] != (fb or '')[-6:]:
                            out.append('%s should %s.' % (ref, 'have the fill colour %s' % (fb or '')[-6:] if fb else 'have no fill'))
                if len(out) >= limit:
                    return out
    for name in names:
        if name not in g.sheetnames:
            continue
        out += _diff_extras(name, g, w, fmt, len(w.sheetnames) > 1, parts)
        if len(out) >= limit:
            return out[:limit]
    return out


def _diff_extras(name, g, w, fmt, many, parts=None):
    """Charts and conditional formats always; frozen panes and column widths when formatting is checked."""
    out = []
    on = ' on "%s"' % name if many else ''
    gc, wc = _charts(g, g[name]), _charts(w, w[name])
    if parts is not None and 'charts' not in parts:
        gc = wc = []
    if len(gc) != len(wc):
        if not wc:
            out.append('There should be no chart%s (yours has %d).' % (on, len(gc)))
        elif not gc:
            out.append('There should be a %s chart%s, titled "%s". Yours has none.' % (wc[0]['kind'], on, wc[0]['title']) if len(wc) == 1 else 'There should be %d charts%s. Yours has none.' % (len(wc), on))
        else:
            out.append('There should be %d chart%s%s; yours has %d.' % (len(wc), '' if len(wc) == 1 else 's', on, len(gc)))
    else:
        for k, (a, b) in enumerate(zip(gc, wc)):
            which = 'The chart%s' % on if len(wc) == 1 else 'Chart %d%s' % (k + 1, on)
            if a['kind'] != b['kind']:
                out.append('%s should be a %s chart, not a %s chart.' % (which, b['kind'], a['kind']))
            elif (a['title'] or '').strip() != (b['title'] or '').strip():
                out.append('%s should be titled "%s"%s.' % (which, b['title'], ' (yours: "%s")' % a['title'] if a['title'] else ' (yours has no title)'))
            elif len(a['series']) != len(b['series']):
                out.append('%s should show %d series of data; yours shows %d.' % (which, len(b['series']), len(a['series'])))
            else:
                for sa, sb in zip(a['series'], b['series']):
                    if sa['vals'] != sb['vals']:
                        out.append('%s should take its values from %s (yours: %s).' % (which, sb['vals'], sa['vals'] or 'nothing'))
                        break
                    if sa['cats'] != sb['cats']:
                        out.append('%s should take its labels from %s (yours: %s).' % (which, sb['cats'] or 'nowhere', sa['cats'] or 'nowhere'))
                        break
                    if (sa['name'] or '') != (sb['name'] or ''):
                        out.append('%s\'s series should be named "%s" (yours: "%s"): include the header cell and titles_from_data=True.' % (which, sb['name'], sa['name']))
                        break
    gr, wr = _cf_rules(g[name]), _cf_rules(w[name])
    if parts is not None and 'rules' not in parts:
        gr = wr = []
    key = lambda r: (r['range'], r['type'], r['op'], tuple(r['f']), r['bg'])
    if sorted(map(key, gr)) != sorted(map(key, wr)):
        miss = [r for r in wr if key(r) not in set(map(key, gr))]
        extra = [r for r in gr if key(r) not in set(map(key, wr))]
        if miss:
            r = miss[0]
            close = [x for x in gr if x['range'] == r['range'] and x['op'] == r['op'] and x['f'] == r['f']]
            if close:
                out.append('The colour rule for %s%s should fill with %s (yours: %s).' % (_cf_describe(r), on, r['bg'] or 'no colour', close[0]['bg'] or 'no colour'))
            else:
                out.append('There should be a colour rule%s: %s%s.' % (on, _cf_describe(r), ', filled %s' % r['bg'] if r['bg'] else ''))
        elif extra:
            out.append('There is an extra colour rule%s: %s.' % (on, _cf_describe(extra[0])))
    if fmt:
        fa, fb = g[name].freeze_panes, w[name].freeze_panes
        if (fa or None) != (fb or None):
            out.append('%s should %s.' % ('"%s"' % name if many else 'The sheet', 'freeze panes at %s' % fb if fb else 'not freeze panes') + ('' if not fa else ' (yours: %s)' % fa))
        for letter, dim in w[name].column_dimensions.items():
            if dim.width and dim.customWidth:
                ga = g[name].column_dimensions[letter].width if letter in g[name].column_dimensions and g[name].column_dimensions[letter].customWidth else None
                if ga is None or abs(ga - dim.width) > 0.6:
                    out.append('Column %s%s should be %g wide (yours: %s).' % (letter, on, round(dim.width, 1), '%g' % round(ga, 1) if ga else 'the standard width'))
                    break
    return out


def _error_info(e, code):
    lines = code.split('\n')
    info = {'type': type(e).__name__, 'msg': str(e), 'line': None, 'text': ''}
    if isinstance(e, SyntaxError):
        info['line'] = e.lineno
        info['msg'] = e.msg
        info['offset'] = e.offset
        if e.lineno and 0 < e.lineno <= len(lines):
            info['text'] = lines[e.lineno - 1]
        tb = 'File "main.py", line %s\n    %s\n%s: %s' % (e.lineno, info['text'].strip(), info['type'], e.msg)
        info['tb'] = tb
        return info
    frames = [f for f in traceback.extract_tb(e.__traceback__) if f.filename == LAB_FILE]
    if frames:
        info['line'] = frames[-1].lineno
        if 0 < frames[-1].lineno <= len(lines):
            info['text'] = lines[frames[-1].lineno - 1]
    parts = ['Traceback (most recent call last):']
    for f in frames:
        parts.append('  File "main.py", line %s, in %s' % (f.lineno, f.name))
        if 0 < f.lineno <= len(lines):
            parts.append('    ' + lines[f.lineno - 1].strip())
    parts.append('%s: %s' % (info['type'], info['msg']) if info['msg'] else info['type'])
    info['tb'] = '\n'.join(parts)
    return info


# ---------- Charts (matplotlib) ----------
# A lab that draws with matplotlib runs on the 'Agg' backend (no window). After the run, every open figure comes back
# twice: as a small PNG to show, and as plain data (title, labels, bars, lines, points, slices) so a check can say in words
# what is different, instead of comparing pictures.
def _mpl_begin(code):
    if 'matplotlib' not in sys.modules and 'matplotlib' not in (code or '') and '.plot' not in (code or ''):
        return
    os.environ['MPLBACKEND'] = 'Agg'
    try:
        import matplotlib
        matplotlib.use('Agg', force=True)
        import matplotlib.pyplot as plt
    except Exception:
        return
    plt.close('all')
    matplotlib.rcdefaults()
    matplotlib.rcParams['svg.hashsalt'] = 'sheetah'
    plt.show = lambda *a, **k: None  # a lab has no window: the charts are shown under the output instead


def _val(v):
    if type(v).__name__ == 'datetime64':
        v = str(v)
    elif hasattr(v, 'item') and not isinstance(v, (str, bytes)):
        try:
            v = v.item()
        except Exception:
            pass
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        f = float(v)
        if f != f:
            return None
        r = round(f, 6)
        return int(r) if r == int(r) and abs(r) < 1e15 else r
    if hasattr(v, 'isoformat'):
        t = v.isoformat()
        return t[:-9] if t.endswith('T00:00:00') else t
    t = str(v)
    if len(t) > 19 and t[10:11] == 'T' and t[11:19] == '00:00:00' and set(t[19:]) <= set('.0'):
        return t[:10]  # numpy dates
    return t


def _hex(c):
    try:
        from matplotlib.colors import to_hex
        return to_hex(c, keep_alpha=False)
    except Exception:
        return ''


def _tick_label(ticks, labels, pos, near=False):
    for t, l in zip(ticks, labels):
        if abs(t - pos) < 1e-6 and l:
            return l
    if near:  # grouped bars sit either side of their category's tick
        best = min(((abs(t - pos), l) for t, l in zip(ticks, labels) if l), default=None)
        if best and best[0] < 0.5:
            return best[1]
    return _val(pos)


def _ax_data(ax):
    from matplotlib.container import BarContainer
    from matplotlib.patches import Wedge
    from matplotlib.collections import PathCollection
    d = {'title': ax.get_title() or ax.get_title('left') or ax.get_title('right'), 'xlabel': ax.get_xlabel(), 'ylabel': ax.get_ylabel(),
         'xlim': [_val(v) for v in ax.get_xlim()], 'ylim': [_val(v) for v in ax.get_ylim()], 'kinds': [],
         'bars': [], 'lines': [], 'refs': [], 'points': [], 'pie': [], 'texts': [], 'legend': [],
         'spines': {k: s.get_visible() for k, s in ax.spines.items()},
         'grid': any(l.get_visible() for l in ax.get_xgridlines() + ax.get_ygridlines())}
    xt, xl = list(ax.get_xticks()), [t.get_text() for t in ax.get_xticklabels()]
    yt, yl = list(ax.get_yticks()), [t.get_text() for t in ax.get_yticklabels()]
    d['xticks'] = [t for t in xl if t][:40]
    d['yticks'] = [t for t in yl if t][:40]
    in_bars = set()
    for c in ax.containers:
        if not isinstance(c, BarContainer) or not c.patches:
            continue
        ps = list(c.patches)
        in_bars.update(id(p) for p in ps)
        horiz = getattr(c, 'orientation', None) == 'horizontal'
        vals = [_val(p.get_width() if horiz else p.get_height()) for p in ps]
        pos = [(p.get_y() + p.get_height() / 2) if horiz else (p.get_x() + p.get_width() / 2) for p in ps]
        touch = len(ps) > 1 and all(abs((ps[i].get_x() + ps[i].get_width()) - ps[i + 1].get_x()) < 1e-9 for i in range(len(ps) - 1)) and not horiz
        lab = c.get_label() or ''
        b = {'label': '' if lab.startswith('_') else lab, 'horizontal': horiz, 'hist': touch, 'values': vals[:200], 'n': len(ps),
             'cats': [_tick_label(yt, yl, q, not touch) if horiz else _tick_label(xt, xl, q, not touch) for q in pos][:200],
             'colors': [_hex(p.get_facecolor()) for p in ps][:200]}
        base = [_val(p.get_x() if horiz else p.get_y()) for p in ps]
        if any(v for v in base):
            b['bottom'] = base[:200]
        if touch:
            b['edges'] = [_val(ps[0].get_x())] + [_val(p.get_x() + p.get_width()) for p in ps][:200]
        d['bars'].append(b)
        k = 'hist' if touch else ('barh' if horiz else 'bar')
        if k not in d['kinds']:
            d['kinds'].append(k)
    for ln in ax.get_lines():
        lab = ln.get_label() or ''
        x, y = list(ln.get_xdata(orig=True)), list(ln.get_ydata(orig=True))
        if ln.get_transform() != ax.transData:  # axhline / axvline: a reference line across the chart
            yax = ln.get_transform() == ax.get_yaxis_transform()
            d['refs'].append({'axis': 'y' if yax else 'x', 'at': _val((y if yax else x)[0]) if (y if yax else x) else None, 'label': '' if lab.startswith('_') else lab, 'color': _hex(ln.get_color())})
            continue
        d['lines'].append({'label': '' if lab.startswith('_') else lab, 'x': [_val(v) for v in x[:300]], 'y': [_val(v) for v in y[:300]], 'n': len(x),
                           'color': _hex(ln.get_color()), 'style': str(ln.get_linestyle()), 'marker': str(ln.get_marker())})
        if 'line' not in d['kinds']:
            d['kinds'].append('line')
    for c in ax.collections:
        if isinstance(c, PathCollection):
            off = c.get_offsets()
            lab = c.get_label() or ''
            d['points'].append({'label': '' if lab.startswith('_') else lab, 'x': [_val(p[0]) for p in off[:300]], 'y': [_val(p[1]) for p in off[:300]], 'n': len(off)})
            if 'scatter' not in d['kinds']:
                d['kinds'].append('scatter')
    wedges = [p for p in ax.patches if isinstance(p, Wedge)]
    if wedges:
        total = sum((w.theta2 - w.theta1) for w in wedges) or 1
        d['pie'] = [{'label': w.get_label() if not (w.get_label() or '_').startswith('_') else '', 'share': round(float(w.theta2 - w.theta1) / float(total), 4), 'color': _hex(w.get_facecolor())} for w in wedges]
        d['kinds'].append('pie')
    d['texts'] = [t.get_text() for t in ax.texts if t.get_text() and t.get_visible()][:40]
    try:
        ss = ax.get_subplotspec()
        if ss is not None and getattr(ax, '_colorbar', None) is None:  # a colour bar's own axes isn't a panel of the layout
            nr, nc = ss.get_geometry()[:2]
            d['place'] = [nr, nc, ss.rowspan.start, ss.rowspan.stop, ss.colspan.start, ss.colspan.stop]
    except Exception:
        pass
    leg = ax.get_legend()
    if leg is not None and leg.get_visible():
        d['legend'] = [t.get_text() for t in leg.get_texts()]
    return d


def _figures(dpi=80):
    plt = sys.modules.get('matplotlib.pyplot')
    if plt is None:
        return []
    out = []
    for num in plt.get_fignums()[:6]:
        fig = plt.figure(num)
        f = {'size': [round(float(v), 2) for v in fig.get_size_inches()]}
        try:
            buf = io.BytesIO()
            fig.savefig(buf, format='png', dpi=dpi, bbox_inches='tight', metadata={'Software': None})  # this draws the chart, which also fills in the tick labels
            f['png'] = base64.b64encode(buf.getvalue()).decode('ascii')
        except Exception as e:
            f['png'] = ''
            f['drawErr'] = '%s: %s' % (type(e).__name__, e)
        st = getattr(fig, '_suptitle', None)
        f['suptitle'] = st.get_text() if st is not None else ''
        try:
            f['axes'] = [_ax_data(ax) for ax in fig.axes if ax.get_visible()]
            if any(getattr(ax, '_colorbar', None) is not None for ax in fig.axes):  # a colour bar re-grids its chart, differently in each matplotlib: no layout to compare
                for d in f['axes']:
                    d.pop('place', None)
        except Exception as e:
            f['axes'] = []
            f['dataErr'] = '%s: %s' % (type(e).__name__, e)
        out.append(f)
    plt.close('all')
    return out


KIND_WORDS = {'bar': 'a bar chart', 'barh': 'a sideways (horizontal) bar chart', 'line': 'a line chart', 'scatter': 'a scatter chart', 'pie': 'a pie chart', 'hist': 'a histogram'}


def _kinds_words(ks):
    return ' and '.join(KIND_WORDS.get(k, k) for k in ks) if ks else 'no chart marks at all'


def _close(a, b, tol=1e-6):
    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool):
        return abs(a - b) <= tol * max(1, abs(a), abs(b))
    return a == b


def _list_diff(what, got, want, cats=None, limit=3):
    """Plain words for two lists of values that should match."""
    if len(got) != len(want):
        return ['%s: expected %d, yours has %d.' % (what, len(want), len(got))]
    out = []
    for i, (g, w) in enumerate(zip(got, want)):
        if not _close(g, w):
            where = ('for %s' % (cats[i],)) if cats else ('number %d' % (i + 1))
            out.append('%s %s should be %s; yours is %s.' % (what, where, w, g))
            if len(out) >= limit:
                break
    return out


def _txt(s):
    return ' '.join(str(s or '').lower().split())


def chart_diff(got, want, spec=None):
    """Compare the charts a program drew with the model answer's. spec: True, or {'aspects': [...], 'text': 'present'|'exact'}.
    Aspects: data (the default set also has kind, title, labels, legend), colors, ylim0, spines, refs, texts, size."""
    spec = spec if isinstance(spec, dict) else {}
    aspects = set(spec.get('aspects') or ['kind', 'data', 'title', 'labels', 'legend', 'layout'])
    exact = spec.get('text') == 'exact'
    diffs = []
    if not got:
        return ['Your program didn\'t draw a chart. Draw it with plt.bar(...), plt.plot(...) or similar before the program ends.' if want else '']
    if len(got) != len(want):
        diffs.append('The expected answer draws %d chart%s; yours draws %d. Each plt.figure() or plt.subplots() starts a new one.' % (len(want), '' if len(want) == 1 else 's', len(got)))
        return diffs
    for fi, (gf, wf) in enumerate(zip(got, want)):
        pre = ('Chart %d: ' % (fi + 1)) if len(want) > 1 else ''
        if gf.get('drawErr'):
            diffs.append(pre + 'the chart couldn\'t be drawn: ' + gf['drawErr'])
            continue
        ga, wa = gf.get('axes', []), wf.get('axes', [])
        if len(ga) != len(wa):
            empty = sum(1 for x in ga if not x['kinds'])
            diffs.append(pre + 'the expected figure has %d chart area%s (axes); yours has %d.' % (len(wa), '' if len(wa) == 1 else 's', len(ga)) + (' %d of yours %s empty: hide panels you don\'t use with ax.set_visible(False).' % (empty, 'is' if empty == 1 else 'are') if len(ga) > len(wa) and empty else ''))
            continue
        if 'title' in aspects and wf.get('suptitle') and _txt(gf.get('suptitle')) != _txt(wf.get('suptitle')) and (exact or not gf.get('suptitle')):
            diffs.append(pre + 'the figure\'s overall title should be "%s".' % wf['suptitle'])
        if 'layout' in aspects and len(wa) > 1:
            gp, wp = [x.get('place') for x in ga], [x.get('place') for x in wa]
            if gp != wp and all(wp):
                rc = lambda q: '%d row%s and %d column%s' % (q[0], '' if q[0] == 1 else 's', q[1], '' if q[1] == 1 else 's')
                if any(q is None for q in gp) or {tuple(q[:2]) for q in gp} != {tuple(q[:2]) for q in wp}:
                    diffs.append(pre + 'the charts should be laid out in a grid of %s%s.' % (rc(wp[0]), '' if any(q is None for q in gp) else '; yours is %s' % rc(gp[0])))
                else:
                    for ai, (q, r) in enumerate(zip(gp, wp)):
                        if q != r:
                            spot = lambda z: 'row %s, column %s' % ('%d' % (z[2] + 1) if z[3] - z[2] == 1 else '%d to %d' % (z[2] + 1, z[3]), '%d' % (z[4] + 1) if z[5] - z[4] == 1 else '%d to %d' % (z[4] + 1, z[5]))
                            diffs.append(pre + 'panel %d (%s) should be at %s; yours is at %s.' % (ai + 1, wa[ai]['title'] or _kinds_words(wa[ai]['kinds']), spot(r), spot(q)))
                            break
        scale_off = {}
        for ai, (g, w) in enumerate(zip(ga, wa)):
            p = pre + (('panel %d: ' % (ai + 1)) if len(wa) > 1 else '')
            P = p[:1].upper() + p[1:] if p else ''
            if 'kind' in aspects and sorted(g['kinds']) != sorted(w['kinds']):
                diffs.append((P or '') + ('It' if not P else 'it') + (' should be %s; yours is %s.' % (_kinds_words(w['kinds']), _kinds_words(g['kinds'])) if g['kinds'] else ' should be %s; yours is empty: nothing is drawn on it.' % _kinds_words(w['kinds'])))
                continue
            if 'data' in aspects:
                if len(g['bars']) != len(w['bars']):
                    diffs.append(P + 'expected %d set%s of bars (one per series%s), yours has %d.' % (len(w['bars']), '' if len(w['bars']) == 1 else 's', ': ' + ', '.join(x['label'] for x in w['bars']) if all(x['label'] for x in w['bars']) else '', len(g['bars'])))
                gst, wst = any('bottom' in b for b in g['bars']), any('bottom' in b for b in w['bars'])
                if gst != wst and g['bars'] and w['bars']:
                    diffs.append(P + ('the bars should be stacked, each sitting on top of the one before (stacked=True, or bottom=); yours stand side by side.' if wst else 'the bars should stand side by side (grouped), not stacked on top of each other.'))
                for gb, wb in zip(g['bars'], w['bars']):
                    if gb['n'] != wb['n']:
                        diffs.append(P + 'expected %d bars, yours has %d.' % (wb['n'], gb['n']))
                        continue
                    if [str(c) for c in gb['cats']] != [str(c) for c in wb['cats']]:
                        if sorted(map(str, gb['cats'])) == sorted(map(str, wb['cats'])):
                            diffs.append(P + 'the bars are in a different order. Expected: %s.' % ', '.join(map(str, wb['cats'][:8])) + (' …' if wb['n'] > 8 else ''))
                        else:
                            diffs.append(P + 'the bars are for different things. Expected: %s; yours: %s.' % (', '.join(map(str, wb['cats'][:6])), ', '.join(map(str, gb['cats'][:6]))))
                        continue
                    diffs += [P + d for d in _list_diff('the bar', gb['values'], wb['values'], wb['cats'])]
                    if wb.get('edges') and not all(_close(a, b) for a, b in zip(gb.get('edges', []), wb['edges'])):
                        diffs.append(P + 'the histogram\'s bins are different: the expected edges are %s.' % ', '.join(map(str, wb['edges'][:8])))
                if len(g['lines']) != len(w['lines']):
                    diffs.append(P + 'expected %d line%s, yours has %d.' % (len(w['lines']), '' if len(w['lines']) == 1 else 's', len(g['lines'])))
                else:
                    for li, (gl, wl) in enumerate(zip(g['lines'], w['lines'])):
                        nm = ('the "%s" line' % wl['label']) if wl['label'] else ('line %d' % (li + 1) if len(w['lines']) > 1 else 'the line')
                        if gl['n'] != wl['n']:
                            diffs.append(P + '%s should have %d points; yours has %d.' % (nm, wl['n'], gl['n']))
                        elif [str(v) for v in gl['x']] != [str(v) for v in wl['x']] and not all(_close(a, b) for a, b in zip(gl['x'], wl['x'])):
                            diffs.append(P + '%s runs along different x values. Expected %s …' % (nm, ', '.join(map(str, wl['x'][:4]))))
                        else:
                            diffs += [P + d for d in _list_diff('%s\'s point' % nm, gl['y'], wl['y'], [str(v) for v in wl['x']])]
                if len(g['points']) != len(w['points']):
                    diffs.append(P + 'expected %d set%s of scatter points, yours has %d.' % (len(w['points']), '' if len(w['points']) == 1 else 's', len(g['points'])))
                for gp, wp in zip(g['points'], w['points']):
                    if gp['n'] != wp['n']:
                        diffs.append(P + 'expected %d points, yours has %d.' % (wp['n'], gp['n']))
                    elif sorted(zip(map(str, gp['x']), map(str, gp['y']))) != sorted(zip(map(str, wp['x']), map(str, wp['y']))):
                        diffs.append(P + 'the points are in different places: check which column goes across (x) and which goes up (y).')
                if w['pie'] or g['pie']:
                    gl, wl = [s['label'] for s in g['pie']], [s['label'] for s in w['pie']]
                    if len(g['pie']) != len(w['pie']):
                        diffs.append(P + 'expected %d slices, yours has %d.' % (len(w['pie']), len(g['pie'])))
                    elif gl != wl and any(wl):
                        diffs.append(P + 'the slices should be labelled %s.' % ', '.join(wl[:8]))
                    else:
                        diffs += [P + d for d in _list_diff('the slice\'s share', [s['share'] for s in g['pie']], [s['share'] for s in w['pie']], wl if any(wl) else None)]
            if 'title' in aspects and w['title'] and (not g['title'] or (exact and _txt(g['title']) != _txt(w['title']))):
                diffs.append(P + ('the chart needs a title, like "%s". Add plt.title(...) or ax.set_title(...).' % w['title'] if not g['title'] else 'the title should be "%s"; yours is "%s".' % (w['title'], g['title'])))
            if 'labels' in aspects:
                for ax_, nm in (('xlabel', 'across the bottom (x)'), ('ylabel', 'up the side (y)')):
                    if w[ax_] and (not g[ax_] or (exact and _txt(g[ax_]) != _txt(w[ax_]))):
                        diffs.append(P + ('the axis %s needs a label, like "%s".' % (nm, w[ax_]) if not g[ax_] else 'the axis %s should say "%s"; yours says "%s".' % (nm, w[ax_], g[ax_])))
            if 'legend' in aspects:
                if w['legend'] and not g['legend']:
                    diffs.append(P + 'the chart needs a legend, so readers know which colour is which. Give each series a label= and call legend().')
                elif w['legend'] and [_txt(t) for t in g['legend']] != [_txt(t) for t in w['legend']]:
                    diffs.append(P + 'the legend should list %s; yours lists %s.' % (', '.join(w['legend']), ', '.join(g['legend']) or 'nothing'))
                elif g['legend'] and not w['legend'] and len(w['lines']) + len(w['bars']) + len(w['points']) <= 1:
                    diffs.append(P + 'a chart with one series doesn\'t need a legend: the title says what it shows.')
            if 'colors' in aspects:
                for gb, wb in zip(g['bars'], w['bars']):
                    if gb['colors'] != wb['colors']:
                        hi = [c for c in wb['cats'] if wb['colors'][wb['cats'].index(c)] != wb['colors'][0]] if len(set(wb['colors'])) > 1 else []
                        diffs.append(P + ('the bars\' colours are different. Expected the bar%s for %s to stand out.' % ('' if len(hi) == 1 else 's', ', '.join(map(str, hi))) if hi else 'the bars\' colours are different from the expected ones.'))
            if 'ylim0' in aspects and w['ylim'][0] == 0 and g['ylim'][0] != 0:
                diffs.append(P + 'the y axis should start at 0 (yours starts at %s), or the bars exaggerate the differences.' % g['ylim'][0])
            if 'spines' in aspects:
                for k in ('top', 'right', 'left', 'bottom'):
                    if k in w['spines'] and g['spines'].get(k) != w['spines'][k]:
                        diffs.append(P + 'the %s border line (spine) should be %s.' % (k, 'shown' if w['spines'][k] else 'hidden'))
            if 'refs' in aspects and len(g['refs']) != len(w['refs']):
                diffs.append(P + 'expected %d reference line%s (axhline / axvline), yours has %d.' % (len(w['refs']), '' if len(w['refs']) == 1 else 's', len(g['refs'])))
            elif 'refs' in aspects:
                for gr, wr in zip(g['refs'], w['refs']):
                    if gr['axis'] != wr['axis'] or not _close(gr['at'], wr['at']):
                        diffs.append(P + 'the reference line should be at %s = %s; yours is at %s = %s.' % (wr['axis'], wr['at'], gr['axis'], gr['at']))
            if 'grid' in aspects and g['grid'] != w['grid']:
                diffs.append(P + ('add light grid lines: ax.grid(axis="y", alpha=0.3).' if w['grid'] else 'take the grid lines off: they add clutter here.'))
            if 'texts' in aspects:
                miss = [t for t in w['texts'] if _txt(t) not in [_txt(x) for x in g['texts']]]
                if miss:
                    diffs.append(P + 'the chart should have the note "%s" on it (ax.bar_label, ax.annotate or ax.text).' % miss[0])
            for ax_, k in (('y', 'ylim'), ('x', 'xlim')):
                if ('scales' if ax_ == 'y' else 'xscales') in aspects and len(w[k]) == 2 and all(isinstance(v, (int, float)) for v in w[k] + g[k]):
                    span = abs(w[k][1] - w[k][0]) or 1
                    if abs(g[k][0] - w[k][0]) > 0.05 * span or abs(g[k][1] - w[k][1]) > 0.05 * span:
                        f2 = lambda v: ('%.0f' % v) if abs(v) >= 10 else ('%.2g' % v)
                        if len(wa) > 1:
                            scale_off.setdefault(ax_, []).append((ai + 1, '%s to %s' % (f2(g[k][0]), f2(g[k][1])), '%s to %s' % (f2(w[k][0]), f2(w[k][1]))))
                        else:
                            diffs.append(P + 'the %s axis runs from %s to %s; expected about %s to %s.' % (ax_, f2(g[k][0]), f2(g[k][1]), f2(w[k][0]), f2(w[k][1])))
        for ax_, off in scale_off.items():
            nums = [str(o[0]) for o in off]
            which = 'Panel %s' % nums[0] if len(nums) == 1 else 'Panels %s and %s' % (', '.join(nums[:-1]), nums[-1])
            diffs.append(pre + '%s: the %s axis runs from %s; expected about %s%s. Share it (share%s=True) so the panels can be compared fairly.' % (which, ax_, off[0][1], off[0][2], '' if len(nums) == 1 else ', the same in every panel', ax_))
        if 'size' in aspects and gf.get('size') != wf.get('size'):
            diffs.append(pre + 'the figure should be %s × %s inches (figsize=(%s, %s)).' % tuple(wf['size'] * 2))
    return [d[:1].upper() + d[1:] for d in diffs[:8]]


def _html_parts(text):
    """What a reader sees on a web page: its title, headings, paragraphs, list items, pictures and tables, in order."""
    from html.parser import HTMLParser
    keep = {'title', 'h1', 'h2', 'h3', 'h4', 'p', 'li', 'figcaption', 'caption', 'th', 'td'}

    class _P(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.items, self.stack, self.buf, self.tables = [], [], [], []

        def handle_starttag(self, tag, attrs):
            a = dict(attrs)
            if tag == 'img':
                src = a.get('src') or ''
                if src.startswith('data:image/'):
                    head = src[5:src.find(',')] if ',' in src else src[5:]
                    src = 'an embedded %s picture' % head.split(';')[0].split('/')[-1].upper() + ('' if ';base64' in head else ' not marked ;base64, (browsers can\'t show it)')
                self.items.append(('img', src, a.get('alt') or ''))
                return
            if tag == 'table':
                self.tables.append([])
            if tag == 'tr' and self.tables:
                self.tables[-1].append([])
            if tag in keep:
                self.stack.append(tag)
                self.buf.append([])
            elif tag == 'br' and self.buf:
                self.buf[-1].append(' ')

        def handle_endtag(self, tag):
            if tag in keep and self.stack and self.stack[-1] == tag:
                self.stack.pop()
                t = ' '.join(''.join(self.buf.pop()).split())
                if tag in ('th', 'td'):
                    if self.tables and self.tables[-1]:
                        self.tables[-1][-1].append(t)
                else:
                    self.items.append((tag, t, ''))
                if self.buf:
                    self.buf[-1].append(t)
            if tag == 'table' and self.tables:
                self.items.append(('table', self.tables.pop(), ''))

        def handle_data(self, data):
            if self.buf:
                self.buf[-1].append(data)

    p = _P()
    try:
        p.feed(text or '')
        p.close()
    except Exception:
        pass
    p.items.extend(('open', t, '') for t in p.stack)  # tags never closed
    return p.items


HTML_WORDS = {'title': 'the page title (<title>)', 'h1': 'the main heading (<h1>)', 'h2': 'a heading (<h2>)', 'h3': 'a small heading (<h3>)', 'h4': 'a small heading (<h4>)',
              'p': 'a paragraph (<p>)', 'li': 'a list item (<li>)', 'figcaption': 'a caption (<figcaption>)', 'caption': 'a table caption', 'img': 'a picture (<img>)', 'table': 'a table (<table>)'}


def _html_section(items, name):
    """The items of one part of a page: '_top' is everything before the first <h2>; otherwise the <h2> with that text and what follows it, up to the next <h2>."""
    if name == '_top':
        k = next((i for i, x in enumerate(items) if x[0] == 'h2'), len(items))
        return items[:k]
    k = next((i for i, x in enumerate(items) if x[0] == 'h2' and _txt(x[1]) == _txt(name)), None)
    if k is None:
        return None
    e = next((i for i in range(k + 1, len(items)) if items[i][0] == 'h2'), len(items))
    return items[k:e]


def html_diff(got, want, limit=5, section=None):
    """Plain words for how a web page a program wrote differs from the expected one: what a reader sees, in order, not the spacing of the code.
    section: compare only one part of the page (see _html_section)."""
    if got is None:
        return ['Your program didn\'t write this page. Open it with open("…", "w") and write the HTML into it.']
    g, w = _html_parts(got), _html_parts(want)
    gopen = [x[1] for x in g if x[0] == 'open']
    g, w = [x for x in g if x[0] != 'open'], [x for x in w if x[0] != 'open']
    if gopen:
        return ['Your page opens <%s> but never closes it: end it with </%s>, or everything after it counts as part of it.' % (gopen[0], gopen[0])]
    if section:
        w = _html_section(w, section) or []
        gs = _html_section(g, section)
        if gs is None:
            return ['Your page has no section headed "%s": start it with <h2>%s</h2>.' % (section, section)]
        g = gs
        if not g and w:
            return ['The top of your page (before the first <h2>) should start with %s: "%s".' % (HTML_WORDS.get(w[0][0], w[0][0]), str(w[0][1])[:100])]
    if not g and w:
        return ['Your page has no headings, paragraphs or pictures a browser would show. Put the words inside tags like <h1>…</h1> and <p>…</p>.']
    out = []
    for i in range(max(len(g), len(w))):
        if i >= len(w):
            out.append('After "%s", your page has %s the expected page doesn\'t: %s.' % (str(w[-1][1])[:60] if w else '', HTML_WORDS.get(g[i][0], g[i][0]), str(g[i][1])[:80]))
            break
        if i >= len(g):
            more = w[i:]
            out.append('Your page stops too soon. Next it should have %s%s.' % (HTML_WORDS.get(more[0][0], more[0][0]), ': "%s"' % str(more[0][1])[:100] if more[0][0] not in ('img', 'table') else ' (%s)' % more[0][1] if more[0][0] == 'img' else ''))
            break
        (gt, gx, ga), (wt, wx, wa) = g[i], w[i]
        if gt != wt:
            out.append('Item %d of the page should be %s%s; yours is %s.' % (i + 1, HTML_WORDS.get(wt, wt), (': "%s"' % str(wx)[:100]) if wt not in ('img', 'table') else '', HTML_WORDS.get(gt, gt)))
            break
        if wt == 'img':
            if gx != wx:
                out.append('Picture %d should show %s; yours shows %s.' % (sum(1 for x in w[:i + 1] if x[0] == 'img'), wx or '(nothing)', gx or '(no src)'))
            elif wa and not ga:
                out.append('The picture %s needs alt text (alt="…"), so people who can\'t see it know what it shows: like "%s".' % (wx, wa))
        elif wt == 'table':
            if len(gx) != len(wx):
                out.append('The table should have %d rows (with the header); yours has %d.' % (len(wx), len(gx)))
            elif gx != wx:
                bad = next(k for k in range(len(wx)) if gx[k] != wx[k])
                out.append('Row %d of the table should read %s; yours reads %s.' % (bad + 1, ' | '.join(wx[bad]), ' | '.join(gx[bad])))
        elif _txt(gx) != _txt(wx):
            out.append('%s should read "%s"; yours reads "%s".' % (HTML_WORDS.get(wt, wt)[:1].upper() + HTML_WORDS.get(wt, wt)[1:], wx, gx))
        if len(out) >= limit:
            break
    return out


def _execute(code, stdin, trace=False, max_steps=1000000, max_trace=600, files=None, expr=None, setup=None, seed=None):
    """Run one program. Returns a dict: out, err (or None), steps (if trace), value (if expr), files."""
    out = io.StringIO()
    feed = list(stdin or [])
    asked = []

    def fake_input(prompt=''):
        prompt = str(prompt)
        out.write(prompt)
        if not feed:
            raise EOFError('input() asked for more than the %d line(s) of input given' % len(asked))
        v = str(feed.pop(0))
        out.write(v + '\n')
        asked.append(v)
        return v

    _reset_sandbox(files)
    g = {'__name__': '__main__', '__builtins__': builtins}
    steps = []
    count = [0]
    user_fns = set()
    try:
        tree = ast.parse(code, LAB_FILE)
        for n in ast.walk(tree):
            if isinstance(n, ast.FunctionDef):
                user_fns.add(n.name)
    except SyntaxError:
        pass
    g['__sheetah_user_fns__'] = tuple(user_fns)

    def snapshot(frame, event, arg):
        frames = []
        f = frame
        chain = []
        while f is not None:
            if f.f_code.co_filename == LAB_FILE:
                chain.append(f)
            f = f.f_back
        chain.reverse()
        for fr in chain:
            name = 'Global' if fr.f_code.co_name == '<module>' else fr.f_code.co_name + '()'
            frames.append({'name': name, 'vars': _show_vars(fr.f_globals if fr.f_code.co_name == '<module>' else fr.f_locals)})
        s = {'line': frame.f_lineno, 'ev': event, 'frames': frames, 'out': len(out.getvalue())}
        if event == 'return' and frame.f_code.co_name != '<module>':
            s['ret'] = _short(arg)
            s['fn'] = frame.f_code.co_name
        if event == 'call':
            s['fn'] = frame.f_code.co_name
        return s

    def tracer(frame, event, arg):
        if frame.f_code.co_filename != LAB_FILE:
            return None
        if event in ('line', 'call', 'return'):
            count[0] += 1
            if count[0] > max_steps:
                raise StepLimit()
            if trace and len(steps) < max_trace and not (event in ('return', 'call') and frame.f_code.co_name == '<module>'):
                steps.append(snapshot(frame, event, arg))
        return tracer

    err = None
    value = None
    old = sys.stdout, sys.stderr
    sys.stdout = out
    sys.stderr = out
    builtins.input = fake_input
    try:
        compiled = compile(code, LAB_FILE, 'exec')
        if seed is not None:  # a fixed seed makes random give the same numbers to the student's code and the model answer
            import random
            random.seed(seed)
        _mpl_begin(code)
        if setup:
            exec(setup, g)
        sys.settrace(tracer)
        try:
            exec(compiled, g)
        finally:
            sys.settrace(None)
        if expr:
            value = _short(eval(expr, g), 400)
    except StepLimit:
        err = {'type': 'StepLimit', 'msg': 'The program ran more than %d steps, so Sheetah stopped it. Is a loop running forever?' % max_steps, 'line': steps[-1]['line'] if steps else None, 'text': '', 'tb': ''}
    except BaseException as e:  # SystemExit, KeyboardInterrupt and friends too
        if isinstance(e, SystemExit):
            err = None
        else:
            err = _error_info(e, code)
    finally:
        sys.settrace(None)
        sys.stdout, sys.stderr = old
        builtins.input = _real_input
    res = {'out': out.getvalue()[:50000], 'err': err, 'inputsUsed': len(asked), 'inputsLeft': len(feed), 'steps_run': count[0]}
    if trace:
        steps.append({'line': None, 'ev': 'end', 'frames': [{'name': 'Global', 'vars': _show_vars(g)}], 'out': len(res['out'])})
        res['steps'] = steps
        res['truncated'] = count[0] > max_trace
    if expr is not None:
        res['value'] = value
    res['files'] = _read_sandbox()
    try:
        res['figures'] = _figures()
    except Exception as e:
        res['figures'] = []
        res['figErr'] = '%s: %s' % (type(e).__name__, e)
    try:
        os.chdir('/')
    except Exception:
        pass
    return res


def features(code):
    """What a program uses, for "use a loop" style rules and for cautions."""
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return {'ok': False, 'f': []}
    f = set()
    names = {
        ast.For: 'for', ast.While: 'while', ast.If: 'if', ast.FunctionDef: 'def', ast.Return: 'return', ast.JoinedStr: 'fstring',
        ast.ListComp: 'listcomp', ast.DictComp: 'dictcomp', ast.SetComp: 'setcomp', ast.GeneratorExp: 'genexp', ast.Match: 'match', ast.Try: 'try',
        ast.With: 'with', ast.Lambda: 'lambda', ast.ClassDef: 'class', ast.AugAssign: 'augassign', ast.Break: 'break', ast.Continue: 'continue',
        ast.Dict: 'dict', ast.List: 'list', ast.Tuple: 'tuple', ast.BoolOp: 'boolop', ast.IfExp: 'ifexp', ast.Import: 'import', ast.ImportFrom: 'import',
        ast.Assign: 'assign', ast.Subscript: 'subscript', ast.Slice: 'slice'
    }
    for n in ast.walk(tree):
        for k, v in names.items():
            if isinstance(n, k):
                f.add(v)
        if isinstance(n, ast.If) and n.orelse:
            if len(n.orelse) == 1 and isinstance(n.orelse[0], ast.If):
                f.add('elif')
            else:
                f.add('else')
        if isinstance(n, (ast.FunctionDef, ast.Lambda)):
            a = n.args
            if a.vararg:
                f.add('varargs')
            if a.kwarg:
                f.add('kwargs')
            if a.defaults or any(d is not None for d in a.kw_defaults):
                f.add('defaults')
            if a.kwonlyargs:
                f.add('kwonly')
        if isinstance(n, ast.FunctionDef):
            f.add('def:' + n.name)
            if n.decorator_list:
                f.add('decorator')
            if n.returns or any(x.annotation for x in n.args.args + n.args.kwonlyargs):
                f.add('hints')
            if ast.get_docstring(n):
                f.add('docstring')
            if any(isinstance(d, ast.FunctionDef) for d in n.body):
                f.add('nested-def')
            for d in n.args.defaults + [x for x in n.args.kw_defaults if x is not None]:
                if isinstance(d, (ast.List, ast.Dict, ast.Set)) or (isinstance(d, ast.Call) and isinstance(d.func, ast.Name) and d.func.id in ('list', 'dict', 'set')):
                    f.add('caution:mutable-default')
        if isinstance(n, (ast.FunctionDef, ast.ClassDef)):
            for d in n.decorator_list:
                d0 = d.func if isinstance(d, ast.Call) else d
                nm = d0.attr if isinstance(d0, ast.Attribute) else getattr(d0, 'id', '')
                if nm:
                    f.add('deco:' + nm)
        if isinstance(n, ast.ClassDef):
            f.add('class:' + n.name)
            if any(getattr(b, 'id', '').endswith(('Exception', 'Error')) for b in n.bases):
                f.add('exception-class')
            for b in n.body:  # a list or dict made once for the class and shared by every object
                if isinstance(b, ast.Assign) and isinstance(b.value, (ast.List, ast.Dict, ast.Set)):
                    f.add('caution:shared-class-list')
                if isinstance(b, ast.FunctionDef) and not b.decorator_list and not b.args.args:
                    f.add('caution:self-missing')
        if isinstance(n, ast.Try):
            if n.finalbody:
                f.add('finally')
            if n.orelse:
                f.add('try-else')
            for h in n.handlers:
                if h.type is None:
                    f.add('caution:bare-except')
                else:
                    for x in (h.type.elts if isinstance(h.type, ast.Tuple) else [h.type]):
                        if isinstance(x, ast.Name):
                            f.add('except:' + x.id)
        if isinstance(n, (ast.Yield, ast.YieldFrom)):
            f.add('yield')
        if isinstance(n, ast.Raise):
            f.add('raise')
        if isinstance(n, ast.Assert):
            f.add('assert')
        if isinstance(n, ast.Global):
            f.add('global')
        if isinstance(n, ast.Nonlocal):
            f.add('nonlocal')
        if isinstance(n, ast.Starred):
            f.add('starred')
        if isinstance(n, ast.keyword) and n.arg is None:
            f.add('kwargs-call')
        if isinstance(n, ast.Set):
            f.add('set')
        if isinstance(n, ast.Call):
            fn = n.func
            if isinstance(fn, ast.Name):
                f.add('call:' + fn.id)
            elif isinstance(fn, ast.Attribute):
                f.add('method:' + fn.attr)
        if isinstance(n, ast.BoolOp):
            f.add('and' if isinstance(n.op, ast.And) else 'or')
        if isinstance(n, ast.UnaryOp) and isinstance(n.op, ast.Not):
            f.add('not')
        if isinstance(n, ast.Compare):
            for op in n.ops:
                f.add('cmp:' + type(op).__name__)
            sides = [n.left] + list(n.comparators)
            if any(isinstance(op, (ast.Eq, ast.NotEq)) for op in n.ops) and any(
                    (isinstance(s, ast.Constant) and isinstance(s.value, float)) or (isinstance(s, ast.BinOp) and isinstance(s.op, ast.Div)) for s in sides):
                f.add('caution:float-eq')
        if isinstance(n, ast.For):
            target = n.iter.id if isinstance(n.iter, ast.Name) else None
            if target:
                for m in ast.walk(n):
                    if isinstance(m, ast.Call) and isinstance(m.func, ast.Attribute) and m.func.attr in ('remove', 'append', 'insert', 'pop', 'clear') \
                            and isinstance(m.func.value, ast.Name) and m.func.value.id == target:
                        f.add('caution:change-while-looping')
        if isinstance(n, ast.Assign) and isinstance(n.value, ast.Call) and isinstance(n.value.func, ast.Attribute) and n.value.func.attr in ('sort', 'append', 'reverse', 'extend', 'insert'):
            f.add('caution:none-method')
        if isinstance(n, ast.Expr) and isinstance(n.value, ast.Call) and isinstance(n.value.func, ast.Attribute) and n.value.func.attr in ('upper', 'lower', 'strip', 'replace', 'title') \
                and isinstance(n.value.func.value, ast.Name):
            f.add('caution:str-unchanged')
        if isinstance(n, (ast.For, ast.While)):
            for m in ast.walk(n):
                if isinstance(m, ast.Call) and isinstance(m.func, ast.Name) and m.func.id == 'open' and len(m.args) > 1 and isinstance(m.args[1], ast.Constant) and 'w' in str(m.args[1].value):
                    f.add('caution:w-in-loop')
        if isinstance(n, ast.Import):
            for a in n.names:
                f.add('import:' + a.name.split('.')[0])
        if isinstance(n, ast.ImportFrom) and n.module:
            f.add('import:' + n.module.split('.')[0])
        if isinstance(n, ast.Constant) and isinstance(n.value, str) and n.value:
            pass
    return {'ok': True, 'f': sorted(f)}


def _norm(s, loose=False):
    lines = [l.rstrip() for l in str(s).replace('\r\n', '\n').split('\n')]
    while lines and not lines[-1]:
        lines.pop()
    t = '\n'.join(lines)
    if loose:
        t = ' '.join(t.lower().split())
    return t


def check(student, model, cases, opts=None):
    """Run student and model code on each case. Returns {ok, cases:[...], features}."""
    opts = opts or {}
    results = []
    all_ok = True
    for i, c in enumerate(cases or [{}]):
        kw = dict(stdin=c.get('stdin'), files=c.get('files'), expr=c.get('expr'), setup=c.get('setup'), seed=c.get('seed'), max_steps=opts.get('maxSteps', 1000000))
        s = _execute(student, **kw)
        m = _execute(model, **kw)
        problems = []
        if s['err']:
            problems.append('error')
        if c.get('compare', opts.get('compare', 'out')) in ('out', 'both') and _norm(s['out'], opts.get('loose')) != _norm(m['out'], opts.get('loose')):
            problems.append('out')
        if c.get('expr') is not None and s.get('value') != m.get('value'):
            problems.append('value')
        file_diff = {}
        for fname in c.get('checkFiles', opts.get('checkFiles', [])):
            got, want = s['files'].get(fname), m['files'].get(fname, '')
            if fname.lower().endswith(('.png', '.jpg', '.jpeg', '.svg', '.pdf')):  # a saved chart: it must exist and be a picture; the chart itself is checked from the figure
                kind = fname.lower().rsplit('.', 1)[-1]
                magic = {'png': 'iVBOR', 'jpg': '/9j/', 'jpeg': '/9j/', 'pdf': 'JVBER'}.get(kind)
                ok_file = (isinstance(got, dict) and (not magic or got.get('b64', '').startswith(magic))) or (kind == 'svg' and isinstance(got, str) and '<svg' in got)
                if not ok_file:
                    problems.append('file:' + fname)
                    file_diff[fname] = {'got': None, 'want': '(a %s picture)' % kind.upper(), 'diffs': ['your program didn\'t save %s. Call plt.savefig("%s") (or fig.savefig) after drawing the chart.' % (fname, fname)], 'picture': True}
                continue
            if fname.lower().endswith(('.html', '.htm')) and isinstance(want, str):  # a web page: compare what a reader sees
                diffs = html_diff(got if isinstance(got, str) else None, want, section=c.get('htmlSection', opts.get('htmlSection')))
                if diffs:
                    problems.append('file:' + fname)
                    pics = lambda fs: {k: v for k, v in fs.items() if isinstance(v, dict) and k.lower().endswith(('.png', '.jpg', '.jpeg', '.gif'))}
                    file_diff[fname] = {'got': got, 'want': want, 'diffs': diffs, 'html': True, 'gotPics': pics(s['files']), 'wantPics': pics(m['files'])}
                continue
            if isinstance(want, dict):  # a workbook: compare what's in the cells, not the bytes
                diffs = ['Your program didn\'t save %s.' % fname] if not isinstance(got, dict) else xlsx_diff(got, want, fmt=c.get('fmt', opts.get('fmt', False)), sheets=c.get('sheets'), parts=c.get('parts'))
                if diffs:
                    problems.append('file:' + fname)
                    file_diff[fname] = {'got': got, 'want': want, 'diffs': diffs}
            elif _norm(got if got is not None else '\x00missing') != _norm(want):
                problems.append('file:' + fname)
                file_diff[fname] = {'got': got, 'want': want}
        chart = c.get('chart', opts.get('chart'))
        chart_diffs = []
        if chart:
            chart_diffs = [d for d in chart_diff(s.get('figures', []), m.get('figures', []), chart) if d]
            if chart_diffs:
                problems.append('chart')
        ok = not problems
        all_ok = all_ok and ok
        results.append({'ok': ok, 'problems': problems, 'stdin': c.get('stdin'), 'expr': c.get('expr'), 'hidden': c.get('hidden', i > 0),
                        'got': s['out'][-3000:], 'want': m['out'][-3000:], 'gotValue': s.get('value'), 'wantValue': m.get('value'),
                        'err': s['err'], 'modelErr': m['err'], 'label': c.get('label'), 'files': c.get('files'), 'fileDiff': file_diff,
                        'gotFigs': [{'png': f.get('png', '')} for f in s.get('figures', [])] if chart or s.get('figures') else [], 'wantFigs': [{'png': f.get('png', '')} for f in m.get('figures', [])] if chart else [], 'chartDiffs': chart_diffs})
        if not ok and opts.get('stopAtFirst', True):
            break
    return {'ok': all_ok, 'cases': results, 'features': features(student)['f']}


def explain_questions(code, n=3):
    """Three "explain your code" questions about the learner's own program: each points at one of their lines
    and asks what it does. Built from what the code uses, so every program gets questions about itself."""
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return []
    lines = code.split('\n')
    src = lambda node: lines[node.lineno - 1].strip() if 0 < node.lineno <= len(lines) else ''
    found = {}

    def add(key, node, q, options, answer, why):
        if key not in found:
            found[key] = {'id': key, 'line': node.lineno, 'code': src(node), 'q': q, 'options': options, 'answer': answer, 'why': why}

    for node in ast.walk(tree):
        if isinstance(node, ast.While):
            if isinstance(node.test, ast.Constant) and node.test.value is True:
                add('while-true', node, 'This line starts a loop with `while True:`. What makes it stop?',
                    ['A `break` inside it, when the user asks to stop', 'It stops by itself after 100 rounds', 'It stops when the condition becomes False', 'It can never stop'], 0,
                    '`while True` would run for ever; the `break` is the only way out.')
            else:
                add('while', node, 'This line starts a `while` loop. When does it stop repeating?',
                    ['When its condition is False at the top of a round', 'After it has run once', 'When a print() runs', 'Only when the program ends'], 0,
                    'The condition is checked before every round; False ends the loop.')
        elif isinstance(node, ast.For):
            it = ast.unparse(node.iter) if hasattr(ast, 'unparse') else 'the list'
            add('for', node, 'How many times does the code inside this `for` loop run?',
                ['Once for each item in `%s`' % it, 'Once', 'Until it finds a break', 'Twice'], 0, 'A for loop visits every item, one at a time.')
        elif isinstance(node, ast.FunctionDef):
            add('def', node, 'This line defines `%s()`. When does the code inside it run?' % node.name,
                ['Each time `%s(...)` is called' % node.name, 'Straight away, when Python reads the def line', 'Only once, at the end of the program', 'Never'], 0,
                'def only stores the instructions; a call runs them.')
        elif isinstance(node, ast.Return) and node.value is not None:
            add('return', node, 'What happens when Python reaches this `return` line?',
                ['The function stops and hands the value back to the line that called it', 'The value is printed', 'The program ends', 'The loop starts again'], 0,
                'return ends the function and gives back a value.')
        elif isinstance(node, ast.Try):
            for h in node.handlers:
                nm = ast.unparse(h.type) if h.type is not None else 'any error'
                if nm == 'ValueError':
                    add('except-value', h, 'When does the code under this `except ValueError:` run?',
                        ['When turning text into a number fails, for example the user types “abc”', 'Every time, after the try block', 'Only when the file is missing', 'Never: it is just a comment'], 0,
                        'float("abc") or int("abc") raises ValueError; except catches it.')
                elif nm == 'Exception':
                    add('except-any', h, 'When does the code under this `except Exception` line run?',
                        ['When any line in the try block above fails, for example a file that can’t be read: the program notes it and carries on', 'After every file, success or not', 'Only when a file is missing', 'Never'], 0,
                        'Exception catches any ordinary error, so one bad file doesn’t stop the report.')
                elif nm == 'FileNotFoundError':
                    add('except-file', h, 'When does the code under this `except FileNotFoundError:` run?',
                        ['When the file doesn’t exist yet, such as the very first run', 'Every time the program saves', 'When the user types a wrong command', 'When the file is empty'], 0,
                        'Opening a missing file for reading raises FileNotFoundError.')
        elif isinstance(node, ast.Call):
            f = node.func
            if isinstance(f, ast.Name) and f.id == 'open':
                mode = 'r'
                if len(node.args) > 1 and isinstance(node.args[1], ast.Constant):
                    mode = str(node.args[1].value)
                for kw in node.keywords:
                    if kw.arg == 'mode' and isinstance(kw.value, ast.Constant):
                        mode = str(kw.value.value)
                if 'w' in mode:
                    add('open-w', node, 'This line opens a file with `"w"`. What happens to what was already in the file?',
                        ['It is wiped, and the file is written again from the start', 'It is kept, and new lines go at the end', 'Nothing: "w" only reads', 'Python asks before changing it'], 0,
                        '"w" starts the file empty.')
                elif 'a' in mode:
                    add('open-a', node, 'This line opens a file with `"a"`. What happens to what was already in the file?',
                        ['It is kept, and what you write goes at the end', 'It is wiped first', 'Nothing can be written', 'The file is renamed'], 0,
                        '"a" means append: add to the end.')
                else:
                    add('open-r', node, 'This line opens a file without "w" or "a". What can the program do with it?',
                        ['Read it, but not change it', 'Only write to it', 'Delete it', 'Nothing until it is closed'], 0,
                        'The default mode is "r": read.')
            elif isinstance(f, ast.Name) and f.id in ('float', 'int') and node.args and isinstance(node.args[0], ast.Call) and isinstance(node.args[0].func, ast.Name) and node.args[0].func.id == 'input':
                add('convert-input', node, 'Why is `input()` wrapped in `%s()` on this line?' % f.id,
                    ['input() always gives text, and the maths needs a number', 'To make the input shorter', 'So the prompt is shown', 'It isn’t needed: input() gives a number'], 0,
                    '"20" is text; %s("20") is a number you can add.' % f.id)
            elif isinstance(f, ast.Attribute):
                if f.attr == 'append':
                    add('append', node, 'What does `.append(...)` do on this line?',
                        ['Adds one item to the end of the list', 'Replaces the whole list', 'Adds an item at the start', 'Prints the list'], 0, 'append grows a list by one, at the end.')
                elif f.attr == 'split':
                    add('split', node, 'What does `.split(...)` give back on this line?',
                        ['A list of the pieces of text between the separators', 'One number', 'The text with spaces removed', 'True or False'], 0, '"a,b".split(",") is ["a", "b"].')
                elif f.attr == 'get' and len(node.args) == 2:
                    add('get', node, 'What does `.get(key, %s)` give if the key isn’t in the dictionary yet?' % ast.unparse(node.args[1]),
                        ['`%s`, the default, instead of an error' % ast.unparse(node.args[1]), 'A KeyError', 'None, always', 'The last key added'], 0, 'get falls back to its second argument.')
                elif f.attr == 'groupby':
                    add('groupby', node, 'What does `.groupby(...)` on this line lead to, once a total like `.sum()` follows it?',
                        ['One row per group (say, per team or per branch), each with that group’s total', 'The same rows, sorted by the group', 'Only the first row of each group', 'A chart of the groups'], 0,
                        'groupby splits the rows by the column; sum() then gives one total per group.')
                elif f.attr == 'to_excel' and any(k.arg == 'index' for k in node.keywords):
                    add('to-excel-index', node, 'Why does this `to_excel(...)` line say `index=False`?',
                        ['So pandas’ row numbers (0, 1, 2 …) aren’t saved as an extra first column', 'So the header row is left out', 'So the file is saved faster', 'So the sheet is hidden'], 0,
                        'Without it, column A holds the index.')
                elif f.attr == 'concat' or (isinstance(f.value, ast.Name) and f.attr == 'concat'):
                    add('concat', node, 'What does `pd.concat(...)` do on this line?',
                        ['Stacks the tables one under another into one table', 'Joins them side by side by a key, like XLOOKUP', 'Adds up their numbers', 'Keeps only the rows in every table'], 0,
                        'concat stacks; merge looks things up.')
                elif f.attr == 'glob':
                    add('glob', node, 'What does `.glob(...)` give on this line?',
                        ['Every file in the folder whose name matches the pattern', 'The first file only', 'The folder’s size', 'The text inside the files'], 0,
                        '"*.xlsx" matches every name ending in .xlsx.')
                elif f.attr == 'to_numeric':
                    add('to-numeric', node, 'What does `pd.to_numeric(...)` do on this line?',
                        ['Turns text like "1,200" (once cleaned) into numbers; with errors="coerce", anything that still isn’t a number becomes blank (NaN)', 'Rounds the numbers', 'Turns numbers into text', 'Sorts the column'], 0,
                        'Numbers stored as text can’t be added until they’re converted.')
                elif f.attr == 'merge':
                    add('merge', node, 'What does `.merge(...)` do on this line?',
                        ['Looks up the matching row in the other table by the key column and adds its columns, like XLOOKUP', 'Stacks the two tables', 'Deletes rows that repeat', 'Adds the two tables’ numbers'], 0,
                        'merge joins tables on a shared column.')
                elif f.attr == 'save' and node.args:
                    add('wb-save', node, 'What happens if this `.save(...)` line is left out?',
                        ['None of the openpyxl changes reach the file: they stay in memory', 'The workbook is saved anyway', 'Python shows an error', 'Only the formats are lost'], 0,
                        'openpyxl edits a copy in memory until you save.')
                elif f.attr == 'dropna':
                    add('dropna', node, 'What does `.dropna(...)` give back on this line?',
                        ['A new table without the rows that have blanks (in the columns named)', 'The same table with blanks turned into 0', 'Only the blank rows', 'Nothing: it changes nothing'], 0,
                        'Keep the result, df = df.dropna(...), or it is lost.')
                elif f.attr == 'drop_duplicates':
                    add('dupes', node, 'What does `.drop_duplicates(...)` do on this line?',
                        ['Removes rows that repeat an earlier row, keeping the first', 'Removes every row that has a twin, both copies', 'Counts the repeats', 'Sorts the table'], 0,
                        'The first copy stays.')
                elif f.attr == 'read_excel':
                    add('read-excel', node, 'What does `pd.read_excel(...)` give back on this line?',
                        ['A table (DataFrame) of the sheet, with the first row as column names', 'The workbook’s file name', 'A list of sheet names', 'The first cell only'], 0,
                        'Each column of the sheet becomes a column of the table.')
                elif f.attr in ('lower', 'strip') and isinstance(f.value, ast.Call):
                    add('clean', node, 'Why does this line use `.strip()` and/or `.lower()` on the text?',
                        ['So “ ADD ” and “add” count as the same command', 'To make the text longer', 'To turn it into a number', 'Python needs it for every input'], 0, 'Cleaning input makes the program forgiving.')
        elif isinstance(node, ast.AugAssign) and isinstance(node.op, ast.Add) and isinstance(node.target, ast.Name):
            add('accumulate', node, 'This line does `%s += …`. What does `%s` hold when the loop has finished?' % (node.target.id, node.target.id),
                ['The running total of everything added to it', 'Only the last value added', 'How many times the loop ran, always', 'Zero'], 0, '+= adds on to what is already there.')
        elif isinstance(node, ast.JoinedStr):
            for v in node.values:
                if isinstance(v, ast.FormattedValue) and v.format_spec is not None and '.2f' in ast.unparse(v.format_spec):
                    add('fmt2', node, 'This f-string uses `:.2f`. How does the number 20 come out?',
                        ['20.00', '20', '20.2', '0.20'], 0, '.2f means exactly two digits after the point.')
        elif isinstance(node, ast.If) and node.orelse and len(node.orelse) == 1 and isinstance(node.orelse[0], ast.If):
            e = node.orelse[0]
            add('elif', e, 'When does Python check the condition on this `elif` line?',
                ['Only when every condition above it in the chain was False', 'Always, after the if above', 'Before the if above', 'Only when the if above was True'], 0, 'An if/elif chain runs at most one branch.')
    order = ['except-any', 'groupby', 'to-excel-index', 'concat', 'glob', 'to-numeric', 'merge', 'wb-save', 'dropna', 'dupes', 'read-excel', 'while-true', 'open-w', 'open-a', 'except-value', 'except-file', 'get', 'accumulate', 'def', 'return', 'convert-input', 'split', 'fmt2', 'append', 'clean', 'elif', 'for', 'while', 'open-r']
    picked = [found[k] for k in order if k in found][:n]
    return picked


def api(job_json):
    job = json.loads(job_json)
    kind = job.get('job')
    if kind == 'preview':
        return json.dumps(xlsx_preview(base64.b64decode(job['b64'])))
    if kind == 'run':
        r = _execute(job['code'], job.get('stdin'), trace=bool(job.get('trace')), files=job.get('files'), max_steps=job.get('maxSteps', 1000000), max_trace=job.get('maxTrace', 600), seed=job.get('seed'))
        r['features'] = features(job['code'])['f']
        return json.dumps(r)
    if kind == 'check':
        return json.dumps(check(job['code'], job['model'], job.get('cases'), job.get('opts')))
    if kind == 'features':
        return json.dumps(features(job['code']))
    if kind == 'explain':
        return json.dumps(explain_questions(job['code'], job.get('n', 3)))
    return json.dumps({'error': 'unknown job'})
