// Render the actual owner calendar with real React/date-fns. Only decorative UI
// imports are replaced; item grouping, day cells, selection and action gates run.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const calendarFile = path.resolve(__dirname, '../../client/src/components/parking-schedule-calendar.tsx');
const source = fs.readFileSync(calendarFile, 'utf8');
const sourceSHA256 = crypto.createHash('sha256').update(source).digest('hex');

if (!process.argv.includes('--zone')) {
  const zones = ['UTC', 'America/Chicago', 'America/Los_Angeles', 'Pacific/Auckland', 'Asia/Tokyo'];
  const results = zones.map((zone) => {
    const child = spawnSync(process.execPath, [__filename, '--zone'], {
      env: { ...process.env, TZ: zone }, encoding: 'utf8',
    });
    assert.equal(child.error, undefined);
    assert.ok(child.stdout.trim(), child.stderr || `No result from ${zone}`);
    const result = JSON.parse(child.stdout);
    assert.equal(result.zone, zone);
    return result;
  });
  const cases = results.flatMap((result) => result.cases);
  const failed = cases.filter((result) => result.status === 'FAIL');
  const report = {
    at: new Date().toISOString(), sourceSHA256,
    scope: 'Actual ParkingScheduleCalendar React SSR, actual date-fns; decorative UI imports only replaced. No browser, API, DB, payment or server actions.',
    pass: cases.length - failed.length, fail: failed.length, zones: results,
  };
  if (process.env.MEALSCOUT_CALENDAR_REPORT) {
    fs.writeFileSync(process.env.MEALSCOUT_CALENDAR_REPORT, JSON.stringify(report, null, 2));
  }
  console.log(`Owner calendar date markers: ${report.pass}/${cases.length} PASS; ${failed.length} FAIL; ${zones.join(', ')}`);
  for (const result of failed) console.log(`FAIL ${result.zone}: ${result.name}: ${result.error}`);
  process.exitCode = failed.length ? 1 : 0;
} else {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const dates = require('date-fns');
  const ts = require('typescript');
  const ast = ts.createSourceFile(calendarFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.equal(ast.parseDiagnostics.length, 0);
  const element = (tag) => ({ children, ...props }) => {
    const safe = {};
    for (const [key, value] of Object.entries(props)) {
      if (['className', 'type', 'disabled', 'onClick'].includes(key) || key.startsWith('aria-')) safe[key] = value;
    }
    return React.createElement(tag, safe, children);
  };
  const mod = { exports: {} };
  const customRequire = (id) => {
    if (id === '@/components/ui/button') return { Button: element('button') };
    if (id === '@/components/ui/badge') return { Badge: element('span') };
    if (id === '@/components/ui/card') return { Card: element('div'), CardContent: element('div') };
    if (id === '@/lib/relative-time') return { formatRelativeTime: () => null };
    if (id === 'lucide-react') return { ChevronLeft: () => null, ChevronRight: () => null };
    return require(id);
  };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { module: mod, exports: mod.exports, require: customRequire, Date });
  const Calendar = mod.exports.ParkingScheduleCalendar;
  assert.equal(typeof Calendar, 'function');
  const cases = [];
  const check = (name, run) => {
    try { run(); cases.push({ zone: process.env.TZ, name, status: 'PASS' }); }
    catch (error) { cases.push({ zone: process.env.TZ, name, status: 'FAIL', error: error.message }); }
  };
  const render = (props) => renderToStaticMarkup(React.createElement(Calendar, props));
  const buttons = (html) => [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .map((match) => ({ attributes: match[1], body: match[2] }));
  const cell = (html, date, required = true) => {
    const label = dates.format(dates.parseISO(date), 'EEEE, MMMM d, yyyy');
    const found = buttons(html).find((button) => button.attributes.includes(`aria-label="${label}"`));
    if (required) assert.ok(found, `Missing actual calendar day cell ${label}`);
    return found;
  };
  const keys = ['2026-10-19', '2026-03-08', '2026-11-01', '2027-01-01', '2028-02-29', '2026-04-01'];
  for (const key of keys) {
    for (const representation of ['date-only', 'utc-marker', 'local-Date']) {
      check(`${key} ${representation} marker, selected details and adjacent day`, () => {
        const date = representation === 'date-only' ? key : representation === 'utc-marker'
          ? `${key}T00:00:00.000Z` : dates.parseISO(key);
        const items = ['manual', 'booking', 'accepted_interest'].map((type) => ({
          id: type, type, date, title: `Synthetic ${type} ${key}`, startTime: '10:00', endTime: '11:00',
        }));
        const html = render({ initialDate: key, items });
        const selected = cell(html, key);
        assert.ok(selected.attributes.includes('aria-pressed="true"'), 'Requested local date remains selected');
        // The cell intentionally displays two labels and a +1 overflow badge.
        for (const item of items.slice(0, 2)) assert.ok(selected.body.includes(item.title), `${item.type} marker stays on ${key}`);
        assert.ok(selected.body.includes('>3</span>'), 'Day marker counts all three stop types');
        let adjacentCells = 0;
        for (const offset of [-1, 1]) {
          const neighborKey = dates.format(dates.addDays(dates.parseISO(key), offset), 'yyyy-MM-dd');
          const neighbor = cell(html, neighborKey, false);
          if (!neighbor) continue; // A month beginning Sunday omits the previous Saturday.
          adjacentCells++;
          for (const item of items) assert.ok(!neighbor.body.includes(item.title), 'Adjacent day must not inherit marker');
        }
        assert.ok(adjacentCells > 0, 'At least one adjacent day must be visible for comparison');
        assert.ok(html.includes('3 stops scheduled'), 'Selected-day details use the same date key as the grid');
        for (const item of items) assert.ok(html.includes(item.title), 'All stop types remain in selected-day details');
        assert.ok(!html.includes('No stops scheduled'), 'Populated selected day must not report an empty schedule');
      });
    }
  }
  for (const offset of [-1, 0, 1]) {
    check(`UTC marker day ${offset}: existing cancel/report day boundaries`, () => {
      const key = dates.format(dates.addDays(new Date(), offset), 'yyyy-MM-dd');
      const html = render({
        initialDate: key, onCancelBooking() {}, onAddReport() {},
        items: [{ id: 'booking', type: 'booking', bookingId: 'synthetic-booking', reportKey: 'booking:synthetic',
          date: `${key}T00:00:00.000Z`, title: 'Synthetic booking', startTime: '10:00', endTime: '11:00' }],
      });
      assert.equal(html.includes('Cancel booking'), offset >= 0, 'Cancellation remains available from today onward');
      assert.equal(html.includes('Add day report'), offset <= 0, 'Reports remain available today and earlier');
    });
  }
  const result = { zone: process.env.TZ, cases };
  console.log(JSON.stringify(result));
  process.exitCode = cases.some((result) => result.status === 'FAIL') ? 1 : 0;
}
