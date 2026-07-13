/* Shared schedule config, CSV parsing, and date helpers for all calendar views. */
const ScheduleData = (() => {
  const CSV_BASE = 'https://recscheduler.blob.core.windows.net/csv-daily-transfer/schedule';
  const FITNESS_CSV_URL = `${CSV_BASE}/FR.csv`;
  const TEST_FITNESS_CSV_URL = './test-schedule.csv';

  const CENTERS = {
    community: {
      label: 'Community Center',
      dropinFile: './GMCC_Drop_In_Schedule.csv',
      fitnessFacility: 'Greater Midland Community Center',
    },
    tennis: {
      label: 'Tennis Center',
      dropinFile: './GMCC_Drop_In_Schedule.csv',
      fitnessFacility: null,
    },
    coleman: {
      label: 'Coleman Family Center',
      dropinFile: './GMCC_Drop_In_Schedule.csv',
      fitnessFacility: null,
    },
    north: {
      label: 'North Family Center',
      dropinFile: './GMCC_Drop_In_Schedule.csv',
      fitnessFacility: null,
    },
  };

  const DROPIN_CATEGORY_MAP = {
    aquatics: /^aquatics$/i,
    courtSports: /^court\s*sports?$/i,
    community: /^community$/i,
    childWatch: /^child\s*watch$/i,
  };

  const FITNESS_LOC_RULES = [
    { match: /^Court\s*3\s*MAC\s*Gym/i, sub:'mac',         label:'MAC Gym' },
    { match: /^Studio\s*1/i,             sub:'studio1',     label:'Studio 1' },
    { match: /^Studio\s*2/i,             sub:'studio2',     label:'Studio 2' },
    { match: /^Lap Pool All Lanes/i,     sub:'aquatics',    label:'Aquatics' },
  ];

  const PALETTE = {
    red:['bg-red-100','text-red-800','border-red-500'],
    orange:['bg-orange-100','text-orange-800','border-orange-500'],
    yellow:['bg-yellow-100','text-yellow-800','border-yellow-500'],
    green:['bg-green-100','text-green-800','border-green-500'],
    teal:['bg-teal-100','text-teal-800','border-teal-500'],
    cyan:['bg-cyan-100','text-cyan-800','border-cyan-500'],
    blue:['bg-blue-100','text-blue-800','border-blue-500'],
    purple:['bg-purple-100','text-purple-800','border-purple-500'],
    indigo:['bg-indigo-100','text-indigo-800','border-indigo-500'],
    pink:['bg-pink-100','text-pink-800','border-pink-500'],
    gray:['bg-gray-200','text-gray-800','border-gray-500'],
  };

  const ACTIVITY_COLORS = {
    'LAP SWIM':'blue', 'REC SWIM':'green',
    'BASKETBALL':'orange', 'VOLLEYBALL':'yellow', 'PICKLEBALL':'red',
    'DEFAULT':'gray',
  };

  function getColorForActivity(name) {
    const upper = String(name).toUpperCase();
    for (const [k, c] of Object.entries(ACTIVITY_COLORS)) if (upper.includes(k)) return c;
    return ACTIVITY_COLORS.DEFAULT;
  }

  function parseTime12h(t) {
    const [time, apRaw='AM'] = String(t).trim().split(' ');
    const [hh, mm='0'] = time.split(':').map(Number);
    let h = hh % 12; if (apRaw.toUpperCase() === 'PM') h += 12;
    return h + (+mm / 60);
  }

  function parseDateFlexible(s) {
    const x = String(s).trim();
    if (x.includes('/')) { const [mm, dd, yyyy] = x.split('/').map(Number); return new Date(yyyy, mm - 1, dd); }
    if (x.includes('-')) { const [yyyy, mm, dd] = x.split('-').map(Number); return new Date(yyyy, mm - 1, dd); }
    return new Date(x);
  }

  function stripRoomCode(loc) {
    return String(loc || '').trim().replace(/^\uFEFF/, '').replace(/\s*\(\s*\d+\s*\)\s*$/, '').trim();
  }

  function cleanActivityName(name) {
    return String(name || '').replace(/\s*\([ML]\)\s*/gi, ' ').replace(/\s*reservations?\s*/gi, '').trim();
  }

  function classifyFitnessLocation(locationRaw) {
    const simple = stripRoomCode(locationRaw);
    for (const rule of FITNESS_LOC_RULES) if (rule.match.test(simple)) return rule;
    return null;
  }

  function mapDropInCategory(category) {
    const cat = String(category || '').trim();
    for (const [sub, pattern] of Object.entries(DROPIN_CATEGORY_MAP)) if (pattern.test(cat)) return sub;
    return null;
  }

  function emptyEventStore() {
    return {
      dropin: {
        aquatics: { label:'Aquatics', events:[] },
        courtSports: { label:'Court Sports', events:[] },
        community: { label:'Community', events:[] },
        childWatch: { label:'Child Watch', events:[] },
      },
      fitness: {
        aquatics: { label:'Aquatics', events:[] },
        studio1: { label:'Studio 1', events:[] },
        studio2: { label:'Studio 2', events:[] },
        mac: { label:'MAC Gym', events:[] },
      },
    };
  }

  function dropinCsvUrl(cfg) {
    const file = cfg.dropinFile || '';
    if (file.startsWith('./') || file.startsWith('/')) return file;
    return `${CSV_BASE}/${file}`;
  }

  function ev(name, location, dayIndex, start, end, colorKey, type, sub) {
    const [bg, text, border] = PALETTE[colorKey];
    return {
      id: `${name}-${dayIndex}-${start}`,
      name, location, dayIndex, start, end,
      color: { bg, text, border }, type, sub, date: null,
    };
  }

  const eqFacility = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

  function findHeaderIndex(headers, pattern) {
    return headers.findIndex(h => pattern.test(h));
  }

  function csvToRows(text) {
    const rows = []; let row = []; let field = ''; let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
        else field += c;
      } else {
        if (c === '"') inQuotes = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
        else if (c !== '\r') field += c;
      }
    }
    if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
    return rows.map(r => r.map(s => String(s).trim()));
  }

  async function fetchCsvText(url, fallbackUrl) {
    try {
      const res = await fetch(url, { cache:'no-store' });
      if (!res.ok) throw new Error(res.status);
      return await res.text();
    } catch {
      const res = await fetch(fallbackUrl, { cache:'no-store' });
      if (!res.ok) throw new Error(`Could not load CSV from ${url}`);
      return await res.text();
    }
  }

  function parseDropInCSV(csvText, dropinStore) {
    const rows = csvToRows(csvText);
    if (!rows.length) return;

    const headers = rows[0].map(h => String(h).trim().toLowerCase());
    const idx = {
      category: findHeaderIndex(headers, /^category$/),
      location: findHeaderIndex(headers, /^location$/),
      date: findHeaderIndex(headers, /date/),
      start: findHeaderIndex(headers, /start/),
      end: findHeaderIndex(headers, /end/),
      activity: findHeaderIndex(headers, /activity/),
    };
    if (Object.values(idx).some(i => i < 0)) return;

    for (const cols of rows.slice(1)) {
      if (!cols || !cols.some(c => String(c).trim())) continue;

      const sub = mapDropInCategory(cols[idx.category]);
      if (!sub) continue;

      const location = String(cols[idx.location] || '').trim();
      const activityName = cleanActivityName(cols[idx.activity]);
      const eventDate = parseDateFlexible(cols[idx.date]);
      if (isNaN(+eventDate) || !activityName) continue;

      const startHour = parseTime12h(cols[idx.start]);
      const endHour = parseTime12h(cols[idx.end]);
      const dayIndex = (eventDate.getDay() + 6) % 7;
      const colorKey = getColorForActivity(activityName);
      const e = ev(activityName, location, dayIndex, startHour, endHour, colorKey, 'dropin', sub);
      e.date = eventDate;
      dropinStore[sub].events.push(e);
    }
  }

  function parseFitnessCSV(csvText, fitnessStore, facilityName) {
    const rows = csvToRows(csvText);
    for (const cols of rows.slice(1)) {
      if (!cols || cols.length < 9) continue;

      const facility = cols[0], locationRaw = cols[1], dateStr = cols[3],
            startTime = cols[4], endTime = cols[5], category = cols[6], activity = cols[7];

      if (!eqFacility(facility, facilityName)) continue;
      if (category !== 'Scheduled Program') continue;

      const loc = classifyFitnessLocation(locationRaw);
      if (!loc) continue;

      const eventDate = parseDateFlexible(dateStr);
      if (isNaN(+eventDate)) continue;

      const activityName = cleanActivityName(activity);
      const colorKey = getColorForActivity(activityName);
      const e = ev(
        activityName, loc.label,
        (eventDate.getDay() + 6) % 7,
        parseTime12h(startTime), parseTime12h(endTime),
        colorKey, 'fitness', loc.sub,
      );
      e.date = eventDate;
      fitnessStore[loc.sub].events.push(e);
    }
  }

  function resolveFitnessFacility(cfg) {
    if (cfg.fitnessFacility) return cfg.fitnessFacility;
    // Centers sharing the community drop-in file also share its group fitness for now.
    if (cfg.dropinFile === CENTERS.community.dropinFile) {
      return CENTERS.community.fitnessFacility;
    }
    return null;
  }

  async function loadAllCenterData() {
    const fitnessText = await fetchCsvText(FITNESS_CSV_URL, TEST_FITNESS_CSV_URL);
    const centerKeys = Object.keys(CENTERS);
    const dropinTexts = await Promise.all(centerKeys.map(async key => {
      const cfg = CENTERS[key];
      const url = dropinCsvUrl(cfg);
      const fallback = cfg.testDropinFile || './GMCC_Drop_In_Schedule.csv';
      return fetchCsvText(url, fallback);
    }));

    const out = {};
    centerKeys.forEach((key, i) => {
      const cfg = CENTERS[key];
      out[key] = emptyEventStore();
      parseDropInCSV(dropinTexts[i], out[key].dropin);
      const fitnessFacility = resolveFitnessFacility(cfg);
      if (fitnessFacility) parseFitnessCSV(fitnessText, out[key].fitness, fitnessFacility);
    });
    return out;
  }

  const getMonday = d => {
    const x = new Date(d); const day = (x.getDay() + 6) % 7;
    x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - day); return x;
  };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const ymd = d => {
    const x = new Date(d);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  };
  const labelDate = d => d.toLocaleDateString(undefined, { month:'short', day:'numeric' });

  function formatTime(hour) {
    const h = Math.floor(hour), m = Math.round((hour - h) * 60);
    const h12 = (h % 12) || 12, ap = h < 12 ? 'AM' : 'PM';
    const mm = m === 0 ? '00' : String(m).padStart(2, '0');
    return `${h12}:${mm} ${ap}`;
  }

  function formatTimeRange(start, end) {
    return `${formatTime(start)}-${formatTime(end)}`;
  }

  function formatTimeRangeMultiline(start, end) {
    return { start: `${formatTime(start)}-`, end: formatTime(end) };
  }

  function startOfDay(d) {
    const x = new Date(d); x.setHours(0, 0, 0, 0); return x;
  }

  function sameDay(a, b) {
    return ymd(a) === ymd(b);
  }

  function flattenCenterStore(store) {
    const events = [];
    for (const type of Object.keys(store)) {
      for (const sub of Object.keys(store[type])) events.push(...store[type][sub].events);
    }
    return events;
  }

  function eventsOnDate(events, date) {
    return events
      .filter(e => e.date && sameDay(e.date, date))
      .sort((a, b) => a.start - b.start || a.end - b.end);
  }

  function getCenterEventsForDate(allCenterEvents, centerKey, date) {
    const store = allCenterEvents[centerKey];
    if (!store) return [];
    return eventsOnDate(flattenCenterStore(store), date);
  }

  function getTodayEventsByCenter(allCenterEvents, date) {
    const out = {};
    for (const key of Object.keys(CENTERS)) {
      out[key] = getCenterEventsForDate(allCenterEvents, key, date);
    }
    return out;
  }

  function filterWeek(all, weekStart) {
    const weekEnd = addDays(weekStart, 6);
    const out = emptyEventStore();
    for (const type of Object.keys(all)) {
      for (const sub of Object.keys(all[type])) {
        for (const e of all[type][sub].events) {
          if (e.date >= weekStart && e.date <= weekEnd) {
            const daysDiff = Math.floor((startOfDay(e.date) - startOfDay(weekStart)) / (1000 * 60 * 60 * 24));
            out[type][sub].events.push({ ...e, dayIndex: daysDiff });
          }
        }
      }
    }
    return out;
  }

  function centerHasFitness(centerKey) {
    return Boolean(resolveFitnessFacility(CENTERS[centerKey] || {}));
  }

  function parseViewDate(param) {
    if (!param) return startOfDay(new Date());
    const d = parseDateFlexible(param);
    return isNaN(+d) ? startOfDay(new Date()) : startOfDay(d);
  }

  return {
    CSV_BASE,
    CENTERS,
    PALETTE,
    emptyEventStore,
    loadAllCenterData,
    getMonday,
    addDays,
    ymd,
    labelDate,
    formatTime,
    formatTimeRange,
    formatTimeRangeMultiline,
    filterWeek,
    centerHasFitness,
    parseViewDate,
    getCenterEventsForDate,
    getTodayEventsByCenter,
    ev,
    getColorForActivity,
  };
})();
