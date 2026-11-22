'use strict';

const resultDiscipline = row => row.discipline || 'SBD';
const isUnplacedResult = row => row.status === 'DNF' || row.status === 'OVERWEIGHT' || row.status === 'NS';

function recordPlaces(row) {
  if (row.class_places?.length) return row.class_places;
  if (row.registration_divisions?.length) return row.registration_divisions.map(division => ({division, place: null}));
  return [{division: row.division || row.age_division, place: row.class_place}];
}

function rankingWeightClass(gender, weightClass, singleMeet = false) {
  if (gender === 'F' && weightClass === '72') return '76';
  if (!singleMeet && gender === 'F' && weightClass === '43') return '47';
  if (!singleMeet && gender === 'M' && weightClass === '53') return '59';
  return weightClass;
}

function matchesFilters(row, filters) {
  const gl = filters.sort === 'gl';
  return resultDiscipline(row) === (filters.discipline || 'SBD') &&
    (!filters.years?.length || filters.years.includes(row.year)) &&
    (!filters.genders.length || filters.genders.includes(row.gender)) &&
    (!filters.divisions?.length || recordPlaces(row).some(place => filters.divisions.includes(place.division))) &&
    (gl || ((!filters.classes.length || filters.classes.includes(row.weight_class)) &&
      (!filters.meetTypes?.length || filters.meetTypes.includes(row.meet_type))));
}

function numericClass(weightClass) {
  if (!weightClass) return Infinity;
  return parseFloat(weightClass) + (weightClass.endsWith('+') ? 0.5 : 0);
}

const singleLifts = ['squat', 'bench', 'deadlift'];
const classSortByMetric = Object.freeze({total: 'total', squat: 'classSquat', bench: 'classBench', deadlift: 'classDeadlift'});
const metricByClassSort = new Map(Object.entries(classSortByMetric).map(([metric, sort]) => [sort, metric]));

function isClassSort(sort) {
  return metricByClassSort.has(sort);
}

function rankingMetric(sort) {
  return metricByClassSort.get(sort) || (sort === 'gl' || singleLifts.includes(sort) ? sort : 'total');
}

function bestPerformance(a, b, metric) {
  if (isUnplacedResult(a) || isUnplacedResult(b)) {
    if (isUnplacedResult(a) !== isUnplacedResult(b)) return isUnplacedResult(a) ? 1 : -1;
    return String(b.meet_date).localeCompare(String(a.meet_date));
  }
  const gl = (b.gl ?? -Infinity) - (a.gl ?? -Infinity);
  const weight = (a.bodyweight ?? Infinity) - (b.bodyweight ?? Infinity);
  if (metric === 'gl') return gl || (b.total ?? b.bench) - (a.total ?? a.bench) || weight;
  if (singleLifts.includes(metric)) return (b[metric] ?? -Infinity) - (a[metric] ?? -Infinity) || weight || b.total - a.total || gl;
  return b.total - a.total || weight || gl;
}

function displayOrder(a, b, metric) {
  if (isUnplacedResult(a) || isUnplacedResult(b)) {
    if (isUnplacedResult(a) !== isUnplacedResult(b)) return isUnplacedResult(a) ? 1 : -1;
    return a.name_sort.localeCompare(b.name_sort);
  }
  const score = (b[metric] ?? -Infinity) - (a[metric] ?? -Infinity);
  if (score) return score;
  const weight = (a.bodyweight ?? Infinity) - (b.bodyweight ?? Infinity);
  if (metric !== 'gl' && weight) return weight;
  if (a.name_sort === b.name_sort) return 0;
  return a.name_sort < b.name_sort ? -1 : 1;
}

function assignRanks(records, metric, assign) {
  const sorted = [...records].sort((a, b) => displayOrder(a, b, metric));
  const totalsWithoutWeighIn = metric === 'total'
    ? new Set(sorted.filter(row => !isUnplacedResult(row) && row.bodyweight == null).map(row => row.total)) : null;
  let rank = 0;
  sorted.forEach((row, index) => {
    if (isUnplacedResult(row) || row[metric] == null) {
      assign(row, null);
      return;
    }
    const previous = sorted[index - 1];
    const tied = previous && row[metric] === previous[metric] && (metric === 'gl' ||
      (row.bodyweight ?? null) === (previous.bodyweight ?? null) ||
      (metric === 'total' && totalsWithoutWeighIn.has(row.total)));
    if (!tied) rank = index + 1;
    assign(row, rank);
  });
}

function rankResults(records, filters) {
  const metric = filters.discipline === 'B' && filters.sort !== 'gl' ? 'bench' : rankingMetric(filters.sort);
  const byClass = isClassSort(filters.sort);
  const groups = new Map();
  for (const row of records) {
    if (!matchesFilters(row, filters)) continue;
    const weightClass = byClass ? row.weight_class : null;
    const groupKey = `${row.gender}/${weightClass || ''}`;
    if (!groups.has(groupKey)) groups.set(groupKey, {gender: row.gender, weightClass, athletes: new Map()});
    const athletes = groups.get(groupKey).athletes;
    const previous = athletes.get(row.athlete_id);
    if (!previous || bestPerformance(row, previous, metric) < 0) athletes.set(row.athlete_id, row);
  }
  const ordered = [...groups.values()].sort((a, b) => {
    if (a.gender !== b.gender) return a.gender === 'M' ? -1 : 1;
    return numericClass(a.weightClass) - numericClass(b.weightClass) || 0;
  });
  return ordered.map(({gender, weightClass, athletes}) => {
    const rows = [];
    assignRanks(athletes.values(), metric, (row, rank) => rows.push({...row, rank: byClass && !weightClass ? null : rank}));
    return {gender, weightClass, rows};
  });
}

function liftPlacings(records, metric) {
  metric = rankingMetric(metric);
  const places = new Map();
  if (!singleLifts.includes(metric)) return places;
  const groups = new Map();
  for (const row of records) {
    if (isUnplacedResult(row)) continue;
    const registrations = row.class_places?.length ? row.class_places
      : [{division: row.division || row.age_division, place: row.class_place}];
    const entries = [];
    places.set(row.record_id, entries);
    for (const registration of registrations) {
      const entry = {division: registration.division, place: null};
      entries.push(entry);
      if (row.place_basis === 'guest' || !entry.division || !(Number(registration.place) > 0)) continue;
      const actualClass = row.placement_weight_class || row.weight_class;
      const key = JSON.stringify([row.meet_id, resultDiscipline(row), row.gender, actualClass, entry.division]);
      if (!groups.has(key)) groups.set(key, new Map());
      groups.get(key).set(row, entry);
    }
  }
  for (const members of groups.values()) {
    assignRanks(members.keys(), metric, (row, rank) => { members.get(row).place = rank; });
  }
  return places;
}

globalThis.rankResults = rankResults;
globalThis.classSortByMetric = classSortByMetric;
globalThis.isClassSort = isClassSort;
globalThis.rankingMetric = rankingMetric;
globalThis.liftPlacings = liftPlacings;

(() => {
  'use strict';

  // Only entries created by the router can have a known in-site predecessor.
  const previousPath = 'ipfcnPreviousPath';
  const canGoBack = () => history.state?.[previousPath] === location.pathname;
  window.IPFcnNavigation = Object.freeze({
    pushState(state, title, ...url) {
      const destination = new URL(url[0] ?? location.href, location.href);
      const internal = destination.origin === location.origin && destination.pathname === location.pathname;
      history.pushState(internal ? {...state, [previousPath]: location.pathname} : state, title, ...url);
    },
    replaceState(state, title, ...url) {
      history.replaceState(canGoBack() ? {...state, [previousPath]: location.pathname} : state, title, ...url);
    }
  });

  function backWithinSite() {
    if (canGoBack()) {
      history.back();
      return true;
    }
    // A shared URL can be the first entry in this tab. Use its in-site parent.
    const view = document.body.dataset.view;
    if (view === 'meet' || view === 'athlete') {
      document.getElementById(view === 'meet' ? 'meet-back' : 'back-to-rankings').click();
      return true;
    }
    if (view === 'records') {
      const url = new URL(location.href);
      url.hash = new URLSearchParams(url.hash.slice(1)).get('discipline') === 'B' ? 'discipline=B' : '#';
      location.replace(url.href);
      return true;
    }
    return false;
  }

  const controls = 'a, button, label, input, textarea, select, summary, form, [contenteditable]:not([contenteditable="false"]), [role="slider"], [role="listbox"]';
  const overlays = 'dialog[open], [aria-modal="true"], details.filter[open], #athlete-matches:not([hidden]), #meet-athlete-matches:not([hidden])';
  const visible = node => node.getClientRects().length > 0;
  let swipe = null;
  function horizontalScroller(target) {
    for (let node = target; node && node !== document.body; node = node.parentElement) {
      if (node.scrollWidth > node.clientWidth + 1 && /^(auto|scroll|overlay)$/.test(getComputedStyle(node).overflowX)) return true;
    }
    return false;
  }
  function blocked(target) {
    return target.closest(controls) || horizontalScroller(target) ||
      [...document.querySelectorAll(overlays)].some(visible) ||
      document.activeElement?.matches('input:not([type=checkbox]):not([type=radio]), textarea, [contenteditable="true"]') ||
      window.getSelection()?.isCollapsed === false;
  }
  document.addEventListener('touchstart', event => {
    swipe = null;
    if (event.defaultPrevented || event.touches.length !== 1 || !(event.target instanceof Element)) return;
    const finger = event.touches[0];
    // Screen edges belong to the operating system and to Safari's own history gestures.
    const edge = Math.min(34, Math.max(24, innerWidth * .06));
    if (finger.clientX <= edge || finger.clientX >= innerWidth - edge || blocked(event.target)) return;
    swipe = {id: finger.identifier, x: finger.clientX, y: finger.clientY, scroll: window.scrollY,
      url: location.href, started: performance.now()};
  }, {passive: true});
  document.addEventListener('touchmove', event => {
    if (!swipe) return;
    const finger = event.touches[0];
    if (event.touches.length !== 1 || finger.identifier !== swipe.id) { swipe = null; return; }
    const dx = swipe.x - finger.clientX, dy = Math.abs(finger.clientY - swipe.y);
    if (dx < -22 || (dy > 22 && dy > dx) || Math.abs(window.scrollY - swipe.scroll) > 8) swipe = null;
  }, {passive: true});
  document.addEventListener('touchcancel', () => { swipe = null; }, {passive: true});
  document.addEventListener('touchend', event => {
    const start = swipe;
    swipe = null;
    if (!start || event.defaultPrevented || event.touches.length || location.href !== start.url ||
        performance.now() - start.started > 1100 || Math.abs(window.scrollY - start.scroll) > 8) return;
    const finger = event.changedTouches[0];
    if (!finger || finger.identifier !== start.id) return;
    const dx = start.x - finger.clientX, dy = Math.abs(finger.clientY - start.y);
    const minimum = Math.max(75, Math.min(125, innerWidth * .23));
    if (dx >= minimum && dy <= Math.min(55, dx * .36) && backWithinSite() && event.cancelable) event.preventDefault();
  }, {passive: false});
})();

'use strict';

(async () => {
  const root = document.documentElement;
  const languageSelect = document.getElementById('language-select');
  let language = root.lang === 'en' ? 'en' : 'zh';
  const tr = (zh, en) => language === 'en' ? en : zh;
  const catalog = window.IPFcnCatalog;
  const store = window.IPFcnData;
  const byMeet = store.meets;
  const meetTitle = (row, locale = language) => locale === 'en' ? row.meet_name_en || row.meet_name : row.meet_name;
  const athleteName = (row, locale = language) => locale === 'en' ? row.name_en || row.name : row.name;
  const translations = [];
  for (const attribute of ['', 'placeholder', 'aria-label', 'title']) {
    const key = 'data-i18n-en' + (attribute ? '-' + attribute : '');
    for (const node of document.querySelectorAll('[' + key + ']')) {
      const chinese = attribute ? node.getAttribute(attribute) : node.textContent;
      const english = node.getAttribute(key);
      translations.push(() => {
        if (attribute) node.setAttribute(attribute, tr(chinese, english));
        else node.textContent = tr(chinese, english);
      });
    }
  }
  function translatePage() {
    root.lang = tr('zh-CN', 'en');
    languageSelect.value = language;
    translations.forEach(apply => apply());
  }
  let scopes = [];
  let rankRows = [];
  let rankCounts = null;
  let archiveRows;
  let activeMeetRows;
  let routeVersion = 0;
  let requestedHref;
  const filters = {years: [], genders: [], classes: [], divisions: [], meetTypes: [], discipline: 'SBD', sort: 'gl'};
  // Only a manual gender choice narrows the options in the weight-class menu.
  const sections = document.getElementById('rankings');
  const form = document.querySelector('.filters');
  const rankingView = document.getElementById('ranking-view');
  const athleteView = document.getElementById('athlete-view');
  const archiveRecords = document.getElementById('athlete-records');
  const rankingTitle = document.getElementById('page-heading').textContent;
  const rankingSubtitle = document.getElementById('page-subtitle').textContent;
  const recordsView = document.getElementById('records-view');
  const recordsContent = document.getElementById('records-content');
  const recordsSelect = document.getElementById('records-discipline');
  const projectNav = document.querySelector('.project-nav');
  const modeBlock = document.querySelector('.mast-mode');
  const archiveTitle = 'IPFcn运动员成绩档案';
  const archiveSubtitle = 'IPFcn ATHLETE RESULTS ARCHIVE';
  const meetNames = {domestic: '国内赛', international: '国际赛'};
  const disciplineName = value => value === 'B' ? tr('卧推举单项', 'Bench Press') : tr('力量举三项', 'Powerlifting');
  const emptyMark = '—';
  function statusLabel(row) {
    if (row.status === 'NS') return tr('未到场 / NS', 'No show / NS');
    return row.status === 'OVERWEIGHT' ? tr('称重超重', 'Overweight') : tr('未完赛 / DNF', 'DNF');
  }
  const shownColumn = (key, discipline) => discipline !== 'B' || !['squat', 'deadlift', 'total'].includes(key);
  function meetsHomeScope(row) {
    return (!filters.years.length || filters.years.includes(row.year)) &&
      (!filters.meetTypes.length || filters.meetTypes.includes(row.meet_type));
  }
  const visibleGroupSize = 25;
  const listAll = new Set();
  const genderName = {M: '男子', F: '女子'};
  const genderLabel = sex => tr(genderName[sex], sex === 'M' ? 'Men' : 'Women');
  const meetTypeLabel = type => tr(meetNames[type], type === 'domestic' ? 'Domestic' : 'International');
  const classText = value => value ? tr(value.replace('+', '以上'), value) : '—';
  const englishDivisions = {
    '少年组': 'Sub-Junior', '青年组': 'Junior', '公开组': 'Open', '大学生组': 'University',
    '大师组': 'Masters', '大师一组': 'Masters I', '大师二组': 'Masters II',
    '大师三组': 'Masters III', '大师四组': 'Masters IV', '视障公开组': 'Visually Impaired Open',
    '特奥组': 'Special Olympics', '特奥少年组': 'Special Olympics Sub-Junior',
    '特奥青年组': 'Special Olympics Junior', '特奥公开组': 'Special Olympics Open'
  };
  const divisionLabel = value => tr(value, englishDivisions[value] || value);
  function ordinal(place) {
    const suffix = (place % 100 >= 11 && place % 100 <= 13) ? 'th' : ({1: 'st', 2: 'nd', 3: 'rd'}[place % 10] || 'th');
    return place + suffix;
  }
  const divisionOrder = ['少年组', '青年组', '公开组', '大师组', '大师一组', '大师二组', '大师三组', '大师四组', '大学生组'];
  function divisionsForRows(rows) {
    const available = new Set(rows.flatMap(row => recordPlaces(row).map(place => place.division)).filter(Boolean));
    return [...divisionOrder.filter(value => available.has(value)),
      ...[...available].filter(value => !divisionOrder.includes(value)).sort((a, b) => a.localeCompare(b, 'zh-CN'))];
  }
  const limits = {years: [], genders: ['M', 'F'], divisions: [], meetTypes: Object.keys(meetNames), classes: []};
  let rankingPanelReady = false;
  function initHomeFilters(rows) {
    if (rankingPanelReady) return;
    scopes = rows;
    const latest = Math.max(2017, ...catalog.meets.map(row => row.year));
    limits.years = Array.from({length: latest - 2017 + 1}, (_, i) => latest - i);
    limits.classes = [...new Set(rows.map(row => row.weight_class).filter(Boolean))].sort((a,b) => numericClass(a)-numericClass(b));
    limits.divisions = divisionsForRows(rows);
    rankingPanel.populate();
    rankingPanelReady = true;
  }
  const allText = {years: '全部年份', genders: '男女全部', classes: '全部级别', meetTypes: '全部赛事', divisions: '全部年龄组'};
  const allEnglish = {years: 'All years', genders: 'Men and women', classes: 'All classes', meetTypes: 'All meet types', divisions: 'All divisions'};
  const allLabel = key => tr(allText[key], allEnglish[key]);
  const athleteKey = row => row.gender + '/' + row.athlete_id;
  const meetView = document.getElementById('meet-view');
  const meetForm = meetView.querySelector('form');
  const meetSections = document.getElementById('meet-rankings');
  const meetSearchInput = document.getElementById('meet-athlete-search');
  let currentMeet = null;
  let meetSearchIndex = [];
  const searchInput = document.getElementById('athlete-search');
  const searchMatches = document.getElementById('athlete-matches');
  const searchStatus = document.getElementById('search-status');
  function athleteSearchEntry(record, classes, aliases) {
    const names = new Set();
    for (const name of [record.name, record.name_sort, athleteName(record, 'en'), ...aliases].filter(Boolean)) {
      names.add(searchKey(name));
      const parts = name.trim().split(/\s+/);
      if (parts.length > 1) names.add(searchKey([...parts.slice(1), parts[0]].join('')));
    }
    return {record, names: [...names], classes};
  }
  // Venue names are search terms, including the local and English forms from the meet records.
  const meetVenues = {
    'ipfcn-nationals-2020': '成都 Chengdu',
    'ipfcn-central-2021': '武汉 Wuhan', 'ipfcn-north-2021': '北京 Beijing',
    'ipfcn-southwest-2021': '重庆 Chongqing', 'ipfcn-south-2021': '珠海 Zhuhai',
    'ipf-china-2303': '北京 Beijing', 'ipf-china-2301': '扬州 Yangzhou',
    'ipf-china-2307': '珠海 Zhuhai', 'ipf-china-2405': '珠海 Zhuhai',
    'ipf-china-2408': '泉州 Quanzhou', 'ipf-china-2502': '中山 Zhongshan',
    'ipfcn-greater-bay-2025': '中山 Zhongshan', 'ipfcn-nationals-2025': '泉州 Quanzhou',
    'ipfcn-east-2026': '无锡 Wuxi', 'ipfcn-nationals-2026': '无锡 Wuxi',
    'ipfcn-south-2026': '中山 Zhongshan', 'ipfcn-north-2026': '北京 Beijing 廊坊 Langfang',
    'ipfcn-southwest-2026': '成都 Chengdu', 'ipfcn-central-2026': '永旺梦乐城 AEON Mall',
    'goodlift-808': '香港 Hong Kong Xianggang 中国 China',
    'goodlift-820': '圣朱利安斯 Saint Julian’s St Julians 马耳他 Malta',
    'goodlift-883': '新山 柔佛 Johor Bahru 马来西亚 Malaysia',
    'goodlift-947': '德鲁斯基宁凯 Druskininkai 立陶宛 Lithuania',
    'goodlift-991': '塔什干 Tashkent 乌兹别克斯坦 Uzbekistan',
    'goodlift-1045': '开姆尼茨 Chemnitz 德国 Germany', 'goodlift-1083': '姬路 Himeji 日本 Japan',
    'goodlift-1122': '伊斯坦布尔 Istanbul 土耳其 Türkiye Turkey',
    'goodlift-1142': '海南 Hainan 中国 China', 'goodlift-1161': '海南 Hainan 中国 China',
    'goodlift-1165': '海南 Hainan 中国 China', 'goodlift-1170': '德鲁斯基宁凯 Druskininkai 立陶宛 Lithuania',
    'goodlift-1207': '太阳城 Sun City 南非 South Africa'
  };
  // The 2021 archived tables publish the year. Tournament reports establish their relative order.
  const earlyMeetOrder = ['ipfcn-north-2021', 'ipfcn-south-2021', 'ipfcn-southwest-2021', 'ipfcn-central-2021'];
  const competitionKeywords = [
    ['全国锦标赛', '全锦赛 全国赛 quanguo quanjinsai'],
    ['世界经典力量举公开锦标赛', '世锦赛 世界赛 shijinsai'],
    ['世界少年暨青年', '世青赛 shiqingsai'],
    ['亚洲经典力量举锦标赛', '亚锦赛 yajinsai'],
    ['亚洲公开组暨大师组', '亚锦赛 yajinsai'],
    ['亚洲少年暨青年', '亚青赛 yaqingsai'],
    ['大学生', 'daxuesheng'], ['粤港澳大湾区', '大湾区 dawanqu'],
    ['华北', 'huabei'], ['华东', 'huadong'], ['华中', 'huazhong'], ['华南', 'huanan'], ['西南', 'xinan']
  ];
  const meetsNewestFirst = [...byMeet.values()].sort((a, b) => {
    const byDate = b.meet_start.localeCompare(a.meet_start) || b.meet_end.localeCompare(a.meet_end);
    if (byDate) return byDate;
    if (earlyMeetOrder.includes(a.meet_id) && earlyMeetOrder.includes(b.meet_id)) {
      return earlyMeetOrder.indexOf(a.meet_id) - earlyMeetOrder.indexOf(b.meet_id);
    }
    return a.meet_id.localeCompare(b.meet_id, 'en');
  });
  function indexMeets() {
    return meetsNewestFirst.map((record, order) => {
      const names = [...(record.alternate_names || []), record.meet_name, record.meet_name_en || '', meetTitle(record, 'zh'), meetTitle(record, 'en'),
        meetVenues[record.meet_id] || '', record.meet_type === 'international' ? '国际赛 international' : '国内赛 domestic'];
      if (record.meet_type === 'domestic') names.push(record.meet_name.replace(/IPF(?![A-Za-z])/g, 'IPFcn'));
      for (const [title, keywords] of competitionKeywords) {
        if (record.meet_name.includes(title)) names.push(...keywords.split(' '));
      }
      return {kind: 'meet', record, order, names: names.map(searchKey)};
    });
  }
  const meetSelect = document.getElementById('meet-select');
  function refreshMeetSelect() {
    const meets = meetsNewestFirst.filter(row => meetsHomeScope(row) &&
      row.disciplines.includes(filters.discipline));
    const emptyLabel = filters.meetTypes.length === 1 ? tr('当前筛选条件下暂无赛事', 'No competitions match these filters')
      : tr('所选年份暂无赛事', 'No competitions for the selected years');
    const empty = element('option', meets.length ? tr('选择赛事', 'Select a competition') : emptyLabel);
    empty.value = '';
    const choices = meets.map(record => {
      const option = element('option', meetTitle(record));
      option.value = record.meet_id;
      return option;
    });
    meetSelect.replaceChildren(empty, ...choices);
    meetSelect.disabled = !meets.length;
    meetSelect.value = '';
  }
  const fields = {
    rank: ['排名', 'RANK', 70], name: ['姓名', 'NAME', 230], year: ['年份', 'YEAR', 70],
    weight_class: ['级别', 'CLASS / kg', 100], bodyweight: ['体重', 'BW / kg', 120],
    squat: ['蹲举', 'SQUAT / kg', 128], bench: ['卧推举', 'BENCH PRESS / kg', 128],
    deadlift: ['硬举', 'DEADLIFT / kg', 128], total: ['总成绩', 'TOTAL / kg', 155], gl: ['GL系数', 'IPF GL', 159]
  };
  const resultColumns = Object.keys(fields);
  fields.team = ['代表队', 'TEAM', 70];
  fields.meet_name = ['赛事与日期', 'COMPETITION / DATE', 295];
  fields.class_place = ['级别名次', 'CLASS PLACE', 188];
  const columnTitles = {rank: 'Rank', name: 'Name', year: 'Year', weight_class: 'Class', bodyweight: 'BW',
    squat: 'Squat', bench: 'Bench Press', deadlift: 'Deadlift', total: 'Total', gl: 'IPF GL', team: 'Team',
    meet_name: 'Competition / Date', class_place: 'Class place'};
  const historyColumns = ['meet_name', 'class_place', 'weight_class', 'bodyweight', 'squat', 'bench', 'deadlift', 'total', 'gl'];
  const medals = ['', '🥇', '🥈', '🥉'];
  const modeTitles = {
    gl: ['GL系数总排名', 'Overall GL Rankings'], total: ['级别总成绩排名', 'Total Rankings by Weight Class'],
    classSquat: ['级别蹲举排名', 'Squat Rankings by Weight Class'],
    classBench: ['级别卧推举排名', 'Bench Press Rankings by Weight Class'],
    classDeadlift: ['级别硬举排名', 'Deadlift Rankings by Weight Class']
  };
  const metricNamesEn = {gl: 'IPF GL points', total: 'total', squat: 'squat', bench: 'bench press', deadlift: 'deadlift'};
  function restoreSort(value) {
    if (value === 'totalOverall') return 'total';
    if (singleLifts.includes(value)) return classSortByMetric[value];
    return isClassSort(value) ? value : 'gl';
  }
  function element(tag, text, cls) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  }
  function bilingual(node, zh, en, caption = en) {
    node.append(element('span', tr(zh, en)));
    if (language === 'zh') node.append(element('small', caption));
  }
  function searchKey(name) {
    return name.normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]/gu, '');
  }
  function searchScore(entry, query, terms) {
    if (entry.kind === 'meet') {
      const names = entry.names;
      const year = String(entry.record.year);
      if (!terms.every(term => term === year || names.some(name => name.includes(term)))) return null;
      if (names.includes(query)) return 0;
      if (query === year || names.some(name => name.startsWith(query))) return 1;
      return 2;
    }
    if (entry.names.includes(query)) return 0;
    if (entry.names.some(name => name.startsWith(query))) return 1;
    return entry.names.some(name => name.includes(query)) ? 2 : null;
  }
  function setupSearch(searchInput, searchMatches, searchStatus, source, linkFor, withMeets = false) {
    let searchResults = [];
    let renderedValue = '';
    let searchVersion = 0;
    let pressedPointer = null;
    let releaseTimer;
    function clearPress() {
      clearTimeout(releaseTimer);
      pressedPointer = null;
    }
    function closeMatches() {
      searchVersion++;
      searchMatches.hidden = true;
      searchStatus.textContent = '';
      clearPress();
    }
    async function showMatches() {
      const version = ++searchVersion;
      const inputValue = searchInput.value;
      const query = searchKey(inputValue);
      if (!query) {
        searchResults = [];
        searchMatches.replaceChildren();
        closeMatches();
        return;
      }
      // Isolate the year even in unspaced Chinese, e.g. 2025华南 or 泉州2025.
      const terms = searchInput.value.replace(/(20\d{2})(?:\s*年)?/g, ' $1 ').trim()
        .split(/\s+/).map(searchKey).filter(Boolean);
      let entries;
      try {
        entries = await source();
      } catch (error) {
        if (version === searchVersion) {
          searchMatches.hidden = true;
          searchStatus.textContent = tr('搜索暂时无法加载。', 'Search could not be loaded.');
          renderedValue = '';
        }
        return;
      }
      if (version !== searchVersion) return;
      renderedValue = inputValue;
      searchResults = [];
      for (const entry of entries) {
        const score = searchScore(entry, query, terms);
        if (score !== null) searchResults.push({entry, score});
      }
      searchResults.sort((a, b) => {
        if (a.entry.kind !== b.entry.kind) return a.entry.kind === 'meet' ? 1 : -1;
        if (a.entry.kind === 'meet') return a.entry.order - b.entry.order;
        return a.score - b.score || a.entry.record.name_sort.localeCompare(b.entry.record.name_sort);
      });
      const fragment = document.createDocumentFragment();
      const nameCounts = new Map();
      for (const {entry} of searchResults) {
        if (entry.kind === 'meet') continue;
        const name = athleteName(entry.record);
        nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
      }
      for (const {entry} of searchResults) {
        const row = entry.record;
        if (entry.kind === 'meet') {
          const link = homeMeetLink(row);
          link.append(element('small', tr('赛事', 'Competition')));
          fragment.append(link);
          continue;
        }
        const link = linkFor(row);
        link.dataset.kind = 'athlete';
        let details = [genderLabel(row.gender), entry.classes.map(value => optionText('classes', value)).join(' / ')].filter(Boolean).join(' · ');
        if (nameCounts.get(athleteName(row)) > 1) {
          const score = resultDiscipline(row) === 'B' ? tr('卧推举 ', 'Bench press ') + row.bench : tr('总成绩 ', 'Total ') + row.total;
          details += ' · ' + row.year + ' · ' + (isUnplacedResult(row) ? statusLabel(row) : score + ' kg');
        }
        link.append(element('small', details));
        fragment.append(link);
      }
      if (!searchResults.length) fragment.append(element('p', withMeets
        ? tr('未找到匹配的运动员或赛事', 'No matching athletes or competitions')
        : tr('未找到匹配的运动员', 'No matching athletes'), 'no-athletes'));
      searchMatches.replaceChildren(fragment);
      searchMatches.scrollTop = 0;
      searchMatches.hidden = false;
      const n = searchResults.length;
      searchStatus.textContent = withMeets ? tr('找到 ' + n + ' 条结果', n + (n === 1 ? ' result' : ' results')) :
        tr('找到 ' + n + ' 位运动员', n + (n === 1 ? ' athlete' : ' athletes'));
    }
    const lookup = searchInput.closest('.athlete-lookup');
    function updateQuery() {
      if (pressedPointer === null && (searchMatches.hidden || searchInput.value !== renderedValue)) showMatches();
    }
    // Keep the tapped link in the DOM if the keyboard commits text during the press.
    searchMatches.addEventListener('pointerdown', event => {
      if (!event.target.closest('a') || !plainClick(event) || event.isPrimary === false) return;
      clearPress();
      pressedPointer = event.pointerId;
      if (document.activeElement === searchInput) event.preventDefault();
    });
    function resumeInput() {
      clearPress();
      if (!searchMatches.hidden) updateQuery();
    }
    function releasePointer(event) {
      if (pressedPointer !== event.pointerId) return;
      if (event.type === 'pointercancel' || !searchMatches.contains(event.target)) {
        resumeInput();
        return;
      }
      // Some keyboards send their final input between pointerup and the native click.
      // Release abandoned presses as well (e.g. after a long press without a click).
      releaseTimer = setTimeout(resumeInput, 600);
    }
    document.addEventListener('pointerup', releasePointer);
    document.addEventListener('pointercancel', releasePointer);
    searchMatches.addEventListener('click', clearPress, true);
    searchInput.addEventListener('input', updateQuery);
    searchInput.addEventListener('focus', updateQuery);
    lookup.addEventListener('focusout', event => {
      if (pressedPointer === null && event.relatedTarget && !lookup.contains(event.relatedTarget)) closeMatches();
    });
    document.addEventListener('click', event => {
      if (!lookup.contains(event.target)) closeMatches();
    });
    lookup.addEventListener('keydown', async event => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        searchInput.focus();
        closeMatches();
        return;
      }
      if (event.key === 'Enter' && event.target === searchInput) {
        event.preventDefault();
        if (searchMatches.hidden || searchInput.value !== renderedValue) await showMatches();
        const links = [...searchMatches.querySelectorAll('a')];
        if (!links.length) return;
        const exact = links.filter((_, index) => searchResults[index].score === 0);
        if (links.length === 1) links[0].click();
        else if (exact.length === 1) exact[0].click();
        else links[0].focus();
        return;
      }
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault();
      if (searchMatches.hidden || searchInput.value !== renderedValue) await showMatches();
      const links = [...searchMatches.querySelectorAll('a')];
      if (!links.length) return;
      const next = links.indexOf(event.target) + (event.key === 'ArrowDown' ? 1 : -1);
      if (next < 0) searchInput.focus();
      else links[Math.min(next, links.length - 1)].focus();
    });
    return {close: closeMatches, refresh: showMatches};
  }
  function optionText(key, value) {
    if (key === 'genders') return genderLabel(value);
    if (key === 'meetTypes') return meetTypeLabel(value);
    if (key === 'classes') return value.endsWith('+') ? tr(parseFloat(value) + ' kg 以上', value + ' kg') : value + ' kg';
    if (key === 'divisions') return divisionLabel(value);
    return String(value);
  }
  function updateFilter(detail, filters) {
    const key = detail.dataset.key;
    const selected = filters[key];
    for (const input of detail.querySelectorAll('input')) {
      const value = key === 'years' ? Number(input.value) : input.value;
      input.checked = input.value === '*' ? !selected.length : selected.includes(value);
    }
    const display = selected.map(value => optionText(key, value));
    const summary = detail.querySelector('.selection');
    summary.textContent = display.length ? display.join(tr('、', ', ')) : allLabel(key);
    summary.title = summary.textContent;
  }
  function checkbox(key, value) {
    const label = element('label');
    const input = element('input');
    input.type = 'checkbox';
    input.value = value;
    label.append(input, element('span', value === '*' ? allLabel(key) : optionText(key, value)));
    return label;
  }
  function setupFilterPanel(form, filters, limits, initialClasses, scopedRecords, changed) {
    const panel = {manualGenders: [], classesByGender: initialClasses};
    const modes = document.getElementById(form === meetForm ? 'meet-sort' : 'sort');
    const classMetricField = form.querySelector('.class-metric-field');
    const classMetric = classMetricField.querySelector('select');
    function syncDiscipline() {
      if (form !== meetForm) {
        const appearing = scopedRecords().filter(row => resultDiscipline(row) === filters.discipline);
        panel.classesByGender = new Map(limits.genders.map(gender => {
          const used = new Set(appearing.filter(row => row.gender === gender).map(row => row.weight_class));
          return [gender, limits.classes.filter(value => used.has(value))];
        }));
      }
      if (filters.discipline === 'B' && filters.sort !== 'gl') filters.sort = 'classBench';
    }
    function syncSort() {
      const byClass = isClassSort(filters.sort);
      const mode = byClass ? 'total' : 'gl';
      form.dataset.mode = mode;
      for (const button of modes.querySelectorAll('[data-mode]')) {
        button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
      }
      for (const field of form.querySelectorAll('[data-key="classes"], [data-key="meetTypes"]')) {
        field.hidden = !byClass;
        if (field.hidden && field.tagName === 'DETAILS') field.open = false;
      }
      classMetricField.hidden = !byClass || filters.discipline === 'B';
      classMetric.value = byClass ? rankingMetric(filters.sort) : 'total';
    }
    function refreshClasses(detail) {
      const genders = panel.manualGenders.length ? panel.manualGenders : limits.genders;
      const available = new Set(genders.flatMap(gender => panel.classesByGender.get(gender)));
      filters.classes = filters.classes.filter(value => available.has(value));
      if (filters.classes.length === available.size) filters.classes = [];
      const groups = element('div', undefined, 'class-groups');
      for (const gender of genders) {
        const group = element('fieldset');
        group.append(element('legend', tr(genderName[gender] + '级别', gender === 'M' ? "Men’s classes" : "Women’s classes")));
        for (const value of panel.classesByGender.get(gender)) group.append(checkbox('classes', value));
        groups.append(group);
      }
      detail.querySelector('.options').replaceChildren(checkbox('classes', '*'), groups);
      updateFilter(detail, filters);
    }
    function gendersForClasses() {
      if (!filters.classes.length) return panel.manualGenders;
      const scope = panel.manualGenders.length ? panel.manualGenders : limits.genders;
      const matches = scope.filter(gender =>
        panel.classesByGender.get(gender).some(value => filters.classes.includes(value)));
      return matches.length === limits.genders.length ? [] : matches;
    }
    function syncFilters() {
      if (filters.sort === 'gl') {
        filters.classes = [];
        if (filters.meetTypes) filters.meetTypes = [];
        filters.genders = [...panel.manualGenders];
      }
      syncDiscipline();
      syncSort();
      for (const detail of form.querySelectorAll('details')) {
        if (detail.dataset.key === 'classes') refreshClasses(detail);
        else if (detail.dataset.key === 'divisions' && form !== meetForm) {
          limits.divisions = divisionsForRows(scopedRecords().filter(row => resultDiscipline(row) === filters.discipline));
          filters.divisions = filters.divisions.filter(value => limits.divisions.includes(value));
          detail.querySelector('.options').replaceChildren(...['*', ...limits.divisions].map(value => checkbox('divisions', value)));
          updateFilter(detail, filters);
        }
        else updateFilter(detail, filters);
      }
    }
    function bindPanel() {
      for (const detail of form.querySelectorAll('details')) {
        const key = detail.dataset.key;
        const options = detail.querySelector('.options');
        options.addEventListener('change', event => {
          if (detail.hidden) return;
          const choices = [...options.querySelectorAll('input')].filter(input => input.value !== '*');
          const selected = new Set(choices.filter(input => input.checked).map(input => input.value));
          let selection = event.target.value === '*' || choices.every(input => selected.has(input.value))
            ? [] : limits[key].filter(value => selected.has(String(value)));
          if (key === 'genders') {
            const inferred = !panel.manualGenders.length && filters.genders.length === 1;
            if (inferred && event.target.checked && event.target.value !== '*') selection = [event.target.value];
            panel.manualGenders = selection;
            filters.genders = selection;
            syncFilters();
          } else {
            filters[key] = selection;
            if (key === 'meetTypes' || key === 'years') {
              syncFilters();
              filters.genders = gendersForClasses();
              updateFilter(form.querySelector('[data-key=genders]'), filters);
            }
            if (key === 'classes') {
              filters.genders = gendersForClasses();
              updateFilter(form.querySelector('[data-key=genders]'), filters);
            }
            updateFilter(detail, filters);
          }
          changed();
        });
        detail.addEventListener('toggle', () => {
          if (detail.open) for (const peer of form.querySelectorAll('details[open]')) if (peer !== detail) peer.open = false;
        });
      }
      document.addEventListener('click', event => {
        for (const detail of form.querySelectorAll('details[open]')) if (!detail.contains(event.target)) detail.open = false;
      });
      document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        const open = form.querySelector('details[open]');
        if (open) { open.open = false; open.querySelector('summary').focus(); }
      });
      form.addEventListener('submit', event => event.preventDefault());
      modes.addEventListener('click', event => {
        const button = event.target.closest('button[data-mode]');
        if (!button || button.getAttribute('aria-pressed') === 'true') return;
        filters.sort = button.dataset.mode === 'total' && filters.discipline === 'B' ? 'classBench' : button.dataset.mode;
        syncFilters();
        changed();
      });
      classMetric.addEventListener('change', () => {
        filters.sort = classSortByMetric[classMetric.value];
        changed();
      });
    }
    panel.sync = syncFilters;
    panel.gendersForClasses = gendersForClasses;
    panel.populate = () => {
      for (const detail of form.querySelectorAll('details')) {
        const key = detail.dataset.key;
        if (key !== 'classes') detail.querySelector('.options').replaceChildren(...['*', ...limits[key]].map(value => checkbox(key, value)));
      }
      syncFilters();
    };
    bindPanel();
    return panel;
  }
  function format(key, row) {
    if (key === 'weight_class') return classText(row.weight_class);
    if (key === 'rank' && isUnplacedResult(row)) return emptyMark;
    if (row[key] == null) return emptyMark;
    if (key === 'bodyweight' || key === 'gl') return row[key].toFixed(2);
    return String(row[key]);
  }
  function appendNameWithStatus(cell, name, record) {
    if (!isUnplacedResult(record)) {
      cell.append(name);
      return;
    }
    const line = element('span', undefined, 'name-with-status');
    if (!name.title) name.title = name.textContent;
    line.append(name, element('span', statusLabel(record), 'result-status-label'));
    cell.append(line);
  }
  function addHead(table, keys, metric) {
    const widths = keys.map(key => fields[key][2]);
    const sum = widths.reduce((a, b) => a + b, 0);
    const cols = element('colgroup');
    const head = element('thead'); const row = element('tr');
    keys.forEach((key, index) => {
      const col = element('col'); col.style.width = `${100 * widths[index] / sum}%`; cols.append(col);
      const th = element('th', undefined, key); th.scope = 'col';
      if (key === 'class_place' && singleLifts.includes(metric)) {
        const english = columnTitles[metric] + ' rank';
        bilingual(th, fields[metric][0] + '排名', english, english.toUpperCase());
      } else {
        bilingual(th, fields[key][0], columnTitles[key], fields[key][1]);
      }
      if (language === 'en' && fields[key][1].endsWith('/ kg')) th.append(element('small', 'kg'));
      row.append(th);
    });
    head.append(row); table.append(cols, head);
  }
  function archiveCell(key, record, placings) {
    const cell = element('td', undefined, key + (key === (resultDiscipline(record) === 'B' ? 'bench' : 'total') ? ' primary' : ''));
    if (key === 'meet_name') {
      const link = element('a', undefined, 'meet-link');
      const params = new URLSearchParams({meet: record.meet_id});
      if (resultDiscipline(record) === 'B') params.set('discipline', 'B');
      link.href = '#' + params.toString();
      link.append(element('span', meetTitle(record)));
      link.addEventListener('click', event => {
        if (!plainClick(event)) return;
        event.preventDefault();
        const region = link.closest('.table-scroll');
        window.IPFcnNavigation.replaceState({...history.state, archivePosition: {scrollY: window.scrollY, scrollLeft: region.scrollLeft, record: record.record_id}}, '');
        window.IPFcnNavigation.pushState({meetOrigin: location.hash}, '', link.href);
        showRoute();
      });
      appendNameWithStatus(cell, link, record);
      let date = record.date_precision === 'year' ? record.year + tr('年', '') : record.meet_date || String(record.year);
      if (record.meet_end_date && record.meet_end_date !== record.meet_date) {
        date = tr('赛期 ', '') + date + tr(' 至 ', ' – ') + record.meet_end_date;
      }
      cell.append(element('small', date, 'meet-date'));
      cell.title = meetTitle(record, 'en');
    } else if (key === 'class_place') {
      for (const {division, place} of placings || recordPlaces(record)) {
        const line = element('div', undefined, 'placing');
        if (medals[place]) {
          const medal = element('span', medals[place], 'medal');
          medal.setAttribute('aria-hidden', 'true');
          line.append(medal);
        }
        line.append(element('span', place != null ? tr('第 ' + place + ' 名', ordinal(place)) : record.place_basis === 'guest' ? tr('来宾', 'Guest') : emptyMark));
        if (division) line.append(element('small', divisionLabel(division)));
        cell.append(line);
      }
    } else if (key === 'weight_class') {
      cell.textContent = classText(record.placement_weight_class || record.weight_class);
    } else {
      cell.textContent = format(key, record);
    }
    return cell;
  }
  const meetLiftPlaces = new Map();
  function competitionLiftPlaces(record, metric) {
    const key = record.meet_id + '/' + metric;
    if (!meetLiftPlaces.has(key)) meetLiftPlaces.set(key, liftPlacings(currentMeet.rows, metric));
    return meetLiftPlaces.get(key).get(record.record_id);
  }
  function plainClick(event) {
    return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
  }
  function saveRankingPosition(recordId, focusControl) {
    const scrollRegions = [...sections.querySelectorAll('.table-scroll')].map(region => region.scrollLeft);
    const ranking = {filters, manualGenders: rankingPanel.manualGenders, expanded: [...listAll],
      scrollY: window.scrollY, scrollRegions, focus: recordId, focusControl};
    if (focusControl) ranking.search = searchInput.value;
    window.IPFcnNavigation.replaceState({ranking}, '');
  }
  function homeMeetHash(row) {
    const params = new URLSearchParams({meet: row.meet_id});
    if (filters.discipline === 'B') params.set('discipline', 'B');
    if (filters.sort !== 'gl') params.set('sort', filters.sort);
    return '#' + params.toString();
  }
  function openHomeMeet(row, focusControl) {
    saveRankingPosition(null, focusControl);
    window.IPFcnNavigation.pushState({fromRankings: true}, '', homeMeetHash(row));
    showRoute();
  }
  function homeMeetLink(row) {
    const link = element('a', meetTitle(row), 'athlete meet-search-link');
    link.dataset.kind = 'meet';
    link.href = homeMeetHash(row);
    link.addEventListener('click', event => {
      if (!plainClick(event)) return;
      event.preventDefault();
      openHomeMeet(row, 'search');
    });
    return link;
  }
  function createAthleteLink(record, fromSearch = false) {
    const link = element('a', athleteName(record), 'athlete');
    const id = athleteKey(record);
    link.href = '#athlete=' + encodeURIComponent(id);
    link.title = tr('查看' + record.name + '的比赛成绩', 'View results for ' + athleteName(record, 'en'));
    link.addEventListener('click', event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      saveRankingPosition(record.record_id, fromSearch ? 'search' : '');
      window.IPFcnNavigation.pushState({fromRankings: true}, '', link.href);
      showRoute();
    });
    return link;
  }
  function resultRow(record, keys, index, singleMeet = false) {
    const tr = element('tr', undefined, 'result' + (index % 2 ? ' alternate' : ''));
    tr.dataset.record = record.record_id;
    const primary = rankingMetric((singleMeet ? meetFilters : filters).sort);
    for (const key of keys) {
      if (key === 'class_place') {
        let places = !isUnplacedResult(record) && resultDiscipline(record) === 'SBD' && singleLifts.includes(primary)
          ? competitionLiftPlaces(record, primary) : recordPlaces(record);
        if (singleMeet && meetFilters.divisions.length && (isUnplacedResult(record) || record.discipline === 'B' || singleLifts.includes(primary))) {
          places = places.filter(p => meetFilters.divisions.includes(p.division));
        }
        tr.append(archiveCell(key, record, places));
        continue;
      }
      const td = element('td', undefined, key + (key === primary ? ' primary' : ''));
      if (key === 'name') {
        const name = record.has_profile
          ? (singleMeet ? meetProfileLink(record) : createAthleteLink(record))
          : element('span', athleteName(record), 'athlete');
        appendNameWithStatus(td, name, record);
      } else { td.textContent = format(key, record); }
      tr.append(td);
    }
    return tr;
  }
  function addGroup(table, group, keys, singleMeet = false) {
    const body = element('tbody'); const id = `${group.gender}/${group.weightClass || ''}`;
    body.dataset.group = id;
    if (group.weightClass || (singleMeet && isClassSort(meetFilters.sort))) {
      const wc = group.weightClass; const tr = element('tr', undefined, 'group');
      const th = element('th'); th.colSpan = keys.length; th.scope = 'rowgroup';
      if (wc) {
        const kg = parseFloat(wc); const open = wc.endsWith('+');
        bilingual(th, open ? `${kg}公斤以上级` : `${kg}公斤级`, wc + ' kg', open ? `OVER ${kg} KG` : `${kg} KG`);
      } else {
        bilingual(th, '级别未记录', 'Weight class not recorded');
      }
      tr.append(th); body.append(tr);
    }
    const shown = singleMeet || listAll.has(id) ? group.rows.length : Math.min(visibleGroupSize, group.rows.length);
    for (let i = 0; i < shown; i++) body.append(resultRow(group.rows[i], keys, i, singleMeet));
    if (shown < (group.totalCount ?? group.rows.length)) {
      const count = (group.totalCount ?? group.rows.length) - shown;
      function control(atStart) {
        const row = element('tr', undefined, atStart ? 'more more-top' : 'more');
        const cell = element('td');
        cell.colSpan = keys.length;
        const label = atStart ? tr(`显示更多（${count} 名）`, `Show ${count} more`) : tr(`显示其余 ${count} 名`, `Show ${count} more`);
        const button = element('button', label, atStart ? 'show-more-top' : 'show-more');
        button.type = 'button';
        button.addEventListener('click', expand);
        cell.append(button); row.append(cell);
        return row;
      }
      const top = control(true);
      const bottom = control(false);
      body.insertBefore(top, body.querySelector('.result'));
      body.append(bottom);
      async function expand(event) {
        const fromTop = top.contains(event.currentTarget);
        const buttons = [top.querySelector('button'), bottom.querySelector('button')];
        buttons.forEach(button => { button.disabled = true; });
        listAll.add(id);
        if (group.totalCount > group.rows.length) {
          await refreshHomeResults();
          buttons.forEach(button => { button.disabled = false; });
        } else {
          const fragment = document.createDocumentFragment();
          for (let i = shown; i < group.rows.length; i++) fragment.append(resultRow(group.rows[i], keys, i));
          top.remove(); bottom.replaceWith(fragment);
        }
        const expanded = sections.querySelector(`tbody[data-group="${id}"]`);
        const first = expanded?.querySelectorAll('tr.result')[fromTop ? 0 : shown];
        first?.querySelector('.athlete')?.focus({preventScroll: true});
      }
    }
    table.append(body);
  }
  function setMode(sort, discipline) {
    const [zh, en] = discipline === 'B' && sort === 'gl'
      ? ['卧推举单项GL系数排名', 'Bench Press GL Rankings'] : modeTitles[sort];
    document.getElementById('mode-zh').textContent = tr(zh, en);
    document.getElementById('mode-en').textContent = en.toUpperCase();
  }
  function tableSections(groups, keys, singleMeet = false, classCharts = null) {
    const fragment = document.createDocumentFragment();
    const {discipline} = singleMeet ? meetFilters : filters;
    for (const gender of limits.genders) {
      const entries = groups.filter(g => g.gender === gender); if (!entries.length) continue;
      const sex = genderName[gender]; const section = element('section', undefined, 'ranking-section');
      const heading = element('h2', undefined, 'section-bar');
      const english = (gender === 'M' ? 'Men’s ' : 'Women’s ') + (discipline === 'B' ? 'Bench Press' : 'Powerlifting');
      bilingual(heading, sex + disciplineName(discipline), english, english.toUpperCase());
      section.append(heading);
      const blocks = classCharts ? entries.map(entry => [entry]) : [entries];
      for (const block of blocks) {
        const scroll = element('div', undefined, 'table-scroll'); scroll.tabIndex = 0;
        scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', tr(`${sex}排名表`, genderLabel(gender) + ' rankings'));
        const table = element('table', undefined, singleMeet ? 'ranking meet-table' : 'ranking');
        if (discipline === 'B') table.classList.add('bench-results');
        if (keys.includes('team')) table.classList.add('international-table');
        table.setAttribute('aria-label', genderLabel(gender) + tr('', ' · ') + document.getElementById('mode-zh').textContent);
        table.dataset.gender = gender;
        addHead(table, keys, rankingMetric((singleMeet ? meetFilters : filters).sort));
        for (const entry of block) addGroup(table, entry, keys, singleMeet);
        scroll.append(table); section.append(scroll);
        if (classCharts && block[0].weightClass) {
          const host = element('div');
          section.append(host);
          classCharts.push({host, gender, weightClass: block[0].weightClass, rows: block[0].classRows});
        }
      }
      fragment.append(section);
    }
    return fragment;
  }
  function render() {
    refreshMeetSelect();
    const metric = rankingMetric(filters.sort);
    setMode(filters.sort, filters.discipline);
    const ranked = filters.discipline === 'B' ? rankRows.filter(row => isUnplacedResult(row) || (filters.sort === 'gl' ? row.gl != null : row.weight_class)) : rankRows;
    const groups = rankResults(ranked, filters);
    if (rankCounts) for (const g of groups) g.totalCount = rankCounts[g.gender];
    const keys = resultColumns.filter(key => shownColumn(key, filters.discipline) && (!isClassSort(filters.sort) || key !== 'weight_class'));
    const fragment = tableSections(groups, keys);
    if (!groups.length) {
      const empty = element('div', undefined, 'empty'); empty.append(element('p', tr('没有符合当前筛选条件的成绩', 'No results match these filters.')));
      const reset = element('button', tr('清除筛选', 'Clear filters')); reset.type = 'button';
      reset.addEventListener('click', () => {
        rankingPanel.manualGenders = [];
        for (const key of Object.keys(limits)) filters[key] = [];
        rankingPanel.sync(); listAll.clear(); refreshHomeResults(); form.querySelector('details:not([hidden]) summary').focus();
      });
      empty.append(reset); fragment.append(empty);
    }
    sections.replaceChildren(fragment);
    const count = groups.reduce((n, g) => n + (g.totalCount ?? g.rows.length), 0);
    document.getElementById('result-status').textContent = tr(`${fields[metric][0]}排名，${count}条结果`, `${count} results ranked by ${metricNamesEn[metric]}`);
  }
  function buildArchive(id) {
    const results = archiveRows;
    const title = tr(archiveTitle, 'IPFcn Athlete Results Archive');
    document.getElementById('page-heading').textContent = title;
    document.getElementById('page-subtitle').textContent = archiveSubtitle;
    document.getElementById('mode-zh').textContent = tr('比赛成绩', 'Competition Results');
    document.getElementById('mode-en').textContent = 'COMPETITION RESULTS';
    if (!results) {
      document.title = tr('未找到运动员', 'Athlete not found') + ' · ' + title;
      archiveRecords.replaceChildren(element('h2', tr('未找到该运动员', 'Athlete not found'), 'empty'));
      return;
    }
    const sorted = [...results].sort((a, b) => b.year - a.year ||
      (b.meet_date || '').localeCompare(a.meet_date || '') || b.total - a.total || b.gl - a.gl ||
      String(a.record_id).localeCompare(String(b.record_id)));
    const athlete = sorted[0];
    const name = athleteName(athlete);
    const englishResults = athlete.gender === 'M' ? "Men’s Results" : "Women’s Results";
    document.getElementById('mode-zh').textContent = tr(genderName[athlete.gender] + '比赛成绩', englishResults);
    document.getElementById('mode-en').textContent = englishResults.toUpperCase();
    document.title = name + ' · ' + title;
    const content = document.createDocumentFragment();
    content.append(element('h2', name, 'archive-name'));
    for (const type of ['international', 'domestic']) {
      const performances = sorted.filter(row => row.meet_type === type);
      if (!performances.length) continue;
      const section = element('section', undefined, 'archive-meet-type');
      section.dataset.meetType = type;
      const count = new Set(performances.map(row => row.meet_id)).size;
      const heading = element('h2', undefined, 'section-bar');
      bilingual(heading, meetNames[type] + ' · ' + count + ' 场', meetTypeLabel(type) + ' · ' + count +
        (count === 1 ? ' meet' : ' meets'), type.toUpperCase());
      section.append(heading);
      for (const discipline of ['SBD', 'B']) {
        const records = performances.filter(row => resultDiscipline(row) === discipline);
        if (!records.length) continue;
        const subtitle = element('h3', undefined, 'archive-discipline');
        bilingual(subtitle, disciplineName(discipline), disciplineName(discipline), discipline === 'B' ? 'BENCH PRESS' : 'POWERLIFTING');
        const region = element('div', undefined, 'table-scroll');
        region.tabIndex = 0; region.setAttribute('role', 'region');
        const description = [name, meetTypeLabel(type), disciplineName(discipline)].join(' · ');
        region.setAttribute('aria-label', description);
        const table = element('table', undefined, 'ranking archive-table');
        table.setAttribute('aria-label', description);
        const keys = historyColumns.filter(key => shownColumn(key, discipline));
        if (discipline === 'B') table.classList.add('bench-results');
        addHead(table, keys);
        const body = element('tbody');
        body.dataset.meetType = type;
        body.dataset.discipline = discipline;
        records.forEach((record, index) => {
          const row = element('tr', undefined, 'result' + (index % 2 ? ' alternate' : ''));
          row.dataset.record = record.record_id;
          for (const key of keys) row.append(archiveCell(key, record));
          body.append(row);
        });
        table.append(body); region.append(table); section.append(subtitle, region);
      }
      content.append(section);
    }
    archiveRecords.replaceChildren(content);
  }

  const meetFilters = {years: [], genders: [], classes: [], divisions: [], discipline: 'SBD', sort: 'gl'};
  const meetLimits = {genders: [], classes: [], divisions: []};
  const meetParams = {genders: 'gender', classes: 'class', divisions: 'division'};
  const meetBack = document.getElementById('meet-back');
  const archiveBack = document.getElementById('back-to-rankings');
  const clearAthlete = document.getElementById('meet-reset-athlete');
  let selectedAthlete = '';

  function meetHash(athlete = '', resetFilters = false) {
    const params = new URLSearchParams({meet: currentMeet.id});
    if (athlete) params.set('athlete', athlete);
    if (meetFilters.discipline === 'B') params.set('discipline', 'B');
    if (!resetFilters) {
      for (const [key, parameter] of Object.entries(meetParams)) {
        const options = key === 'genders' ? meetPanel.manualGenders : meetFilters[key];
        for (const value of options) params.append(parameter, value);
      }
    }
    if (meetFilters.sort !== 'gl') params.set('sort', meetFilters.sort);
    return '#' + params.toString();
  }
  function saveMeetPosition(record, search) {
    window.IPFcnNavigation.replaceState({...history.state, meetPosition: {
      record, search, scrollY: window.scrollY,
      scrollLeft: [...meetSections.querySelectorAll('.table-scroll')].map(el => el.scrollLeft)
    }}, '');
  }
  function meetProfileLink(record) {
    const link = element('a', athleteName(record), 'athlete athlete-link');
    link.href = '#athlete=' + encodeURIComponent(athleteKey(record));
    link.title = tr('查看' + record.name + '的比赛成绩', 'View results for ' + athleteName(record, 'en'));
    link.addEventListener('click', event => {
      if (!plainClick(event)) return;
      event.preventDefault();
      saveMeetPosition(record.record_id);
      window.IPFcnNavigation.pushState({fromMeet: location.hash}, '', link.href);
      showRoute();
    });
    return link;
  }
  function meetSearchLink(record) {
    const key = athleteKey(record);
    const rows = currentMeet.byAthlete.get(key);
    const inSelection = rows.some(row => matchesFilters(row, meetFilters) && matchesDivision(row));
    const link = element('a', athleteName(record), 'athlete athlete-link');
    link.href = meetHash(key, !inSelection);
    link.addEventListener('click', event => {
      if (!plainClick(event)) return;
      event.preventDefault();
      if (!selectedAthlete) {
        saveMeetPosition(record.record_id, meetSearchInput.value);
        window.IPFcnNavigation.pushState({meetOrigin: history.state?.meetOrigin, backToAll: location.hash}, '', link.href);
      } else {
        window.IPFcnNavigation.replaceState({...history.state, meetPosition: null}, '', link.href);
      }
      showRoute();
    });
    return link;
  }
  function matchesDivision(row) {
    return !meetFilters.divisions.length || recordPlaces(row).some(p => meetFilters.divisions.includes(p.division));
  }
  function prepareMeet(id, rows) {
    const athletes = new Map();
    const byRecord = new Map();
    for (const row of rows) {
      const key = athleteKey(row);
      if (!athletes.has(key)) athletes.set(key, []);
      athletes.get(key).push(row);
      byRecord.set(row.record_id, row);
    }
    currentMeet = {id, rows, byAthlete: athletes, byRecord};
    meetLimits.genders = limits.genders.filter(gender => rows.some(row => row.gender === gender));
    meetLimits.classes = [...new Set(rows.map(row => row.weight_class).filter(Boolean))].sort((a, b) => numericClass(a) - numericClass(b));
    meetLimits.divisions = divisionsForRows(rows);
    meetPanel.classesByGender = new Map(meetLimits.genders.map(gender => [gender,
      meetLimits.classes.filter(value => rows.some(row => row.gender === gender && row.weight_class === value))]));
    meetSearchIndex = [...athletes.values()].map(records => {
      const classes = meetLimits.classes.filter(value => records.some(row => row.weight_class === value));
      return athleteSearchEntry(records[0], classes, records.flatMap(row => row.alternate_names || []));
    });
  }
  let disposeMeetCharts = null;
  function clearMeetCharts() {
    disposeMeetCharts?.();
    disposeMeetCharts = null;
  }
  function renderMeet() {
    clearMeetCharts();
    setMode(meetFilters.sort, meetFilters.discipline);
    // The ranking engine normally chooses a career best. Here every distinct performance is eligible.
    const rows = currentMeet.rows.map(row => ({...row, athlete_id: row.record_id}));
    const ranked = rankResults(rows, meetFilters);
    const groups = ranked.map(group => {
      const performances = group.rows.map(row => ({...currentMeet.byRecord.get(row.record_id), rank: row.rank}));
      return {...group, classRows: performances, rows: performances.filter(row => !selectedAthlete || athleteKey(row) === selectedAthlete)};
    }).filter(group => group.rows.length);
    const teamColumns = currentMeet.rows[0].meet_type === 'international' ? ['team'] : [];
    const keys = ['rank', 'name', ...teamColumns, 'class_place', 'weight_class', 'bodyweight', 'squat', 'bench', 'deadlift', 'total', 'gl']
      .filter(key => shownColumn(key, meetFilters.discipline) && (!isClassSort(meetFilters.sort) || key !== 'weight_class'));
    const classCharts = [];
    const fragment = tableSections(groups, keys, true, isClassSort(meetFilters.sort) ? classCharts : null);
    if (!groups.length) {
      const box = element('div', undefined, 'empty');
      box.append(element('p', tr('没有符合当前筛选条件的成绩', 'No results match these filters.')));
      const reset = element('button', tr('清除本场筛选', 'Clear meet filters')); reset.type = 'button';
      reset.addEventListener('click', () => {
        const person = currentMeet.byAthlete.has(selectedAthlete) ? selectedAthlete : '';
        window.IPFcnNavigation.replaceState({...history.state, meetPosition: null}, '', meetHash(person, true));
        showRoute();
      });
      box.append(reset); fragment.append(box);
    }
    const glHost = element('div');
    fragment.append(glHost);
    meetSections.replaceChildren(fragment);
    disposeMeetCharts = window.IPFcnRecords.renderMeet({language,
      metric: meetFilters.discipline === 'B' ? 'bench' : rankingMetric(meetFilters.sort),
      classCharts, glChart: {host: glHost, rows: currentMeet.rows}});
    document.getElementById('meet-athlete-filter').hidden = !selectedAthlete;
    const selected = currentMeet.byAthlete.get(selectedAthlete)?.[0];
    document.getElementById('meet-selected-name').textContent = selectedAthlete ? (selected ? athleteName(selected) : tr('未找到本场运动员', 'Athlete not found in this meet')) : '';
    clearAthlete.href = meetHash();
    const count = groups.reduce((n, group) => n + group.rows.length, 0);
    const metric = rankingMetric(meetFilters.sort);
    document.getElementById('meet-result-status').textContent = tr(`本场${fields[metric][0]}排名，${count}条结果`,
      `${count} results in this meet ranked by ${metricNamesEn[metric]}`);
  }
  function setBackLink(link, hash, label, english) {
    link.href = hash || '#';
    const destinations = {'RECORDS & DISTRIBUTIONS': 'records and distributions', 'RANKINGS': 'rankings', 'ATHLETE ARCHIVE': 'athlete profile', 'MEET RESULTS': 'meet results'};
    link.replaceChildren(document.createTextNode('← ' + tr(label, 'Back to ' + destinations[english]) + ' '));
    if (language === 'zh') link.append(element('small', english));
  }
  function showMeet(hash, translating) {
    const id = hash.get('meet');
    const rows = activeMeetRows;
    const heading = document.getElementById('page-heading');
    const sub = document.getElementById('page-subtitle');
    rankingView.hidden = true; athleteView.hidden = true; meetView.hidden = false;
    meetForm.hidden = !rows;
    meetForm.previousElementSibling.hidden = !rows;
    const origin = history.state?.meetOrigin;
    const fromRecords = history.state?.fromRecords;
    setBackLink(meetBack, origin || fromRecords, origin ? '返回运动员档案' : fromRecords ? '返回纪录与分布' : '返回排行榜',
      origin ? 'ATHLETE ARCHIVE' : fromRecords ? 'RECORDS & DISTRIBUTIONS' : 'RANKINGS');
    if (!rows) {
      currentMeet = null;
      heading.textContent = tr('未找到该赛事', 'Competition not found'); sub.textContent = 'COMPETITION RESULTS';
      document.title = heading.textContent + ' · IPFcn';
      document.getElementById('mode-zh').textContent = tr('赛事成绩', 'Meet Results');
      document.getElementById('mode-en').textContent = 'MEET RESULTS';
      document.getElementById('meet-date').textContent = '';
      document.getElementById('meet-athlete-filter').hidden = true;
      meetSections.replaceChildren(); return;
    }
    meetFilters.discipline = resultDiscipline(rows[0]);
    if (currentMeet?.rows !== rows) prepareMeet(id, rows);
    for (const [key, parameter] of Object.entries(meetParams)) {
      const requested = hash.getAll(parameter).map(value => key === 'classes' && value === '72' ? '76' : value);
      meetFilters[key] = meetLimits[key].filter(value => requested.includes(value));
    }
    meetPanel.manualGenders = [...meetFilters.genders];
    meetFilters.sort = restoreSort(hash.get('sort'));
    meetPanel.populate();
    meetFilters.genders = meetPanel.gendersForClasses();
    updateFilter(meetForm.querySelector('[data-key=genders]'), meetFilters);
    selectedAthlete = hash.get('athlete') || '';
    if (hash.has('class') && (meetFilters.sort === 'gl' || hash.getAll('class').includes('72'))) {
      window.IPFcnNavigation.replaceState(history.state, '', meetHash(selectedAthlete));
    }
    const record = rows[0];
    heading.textContent = meetTitle(record);
    sub.textContent = meetTitle(record, 'en');
    document.title = meetTitle(record) + ' · IPFcn';
    const start = record.meet_start || record.meet_date || String(record.year);
    const end = record.meet_end || record.meet_end_date;
    document.getElementById('meet-date').textContent = record.date_precision === 'year' ? record.year + tr('年', '') : end && start !== end ? start + tr(' 至 ', ' – ') + end : start;
    if (selectedAthlete) setBackLink(meetBack, meetHash(), '返回本场比赛', 'MEET RESULTS');
    renderMeet();
    if (translating) return;
    const saved = history.state?.meetPosition;
    for (const detail of meetForm.querySelectorAll('details[open]')) detail.open = false;
    meetSearchInput.value = saved?.search || '';
    focusHeading();
    if (saved) {
      meetSections.querySelectorAll('.table-scroll').forEach((region, i) => { region.scrollLeft = saved.scrollLeft[i] || 0; });
      if (saved.search) meetSearchInput.focus({preventScroll: true});
      else [...meetSections.querySelectorAll('tr[data-record]')].find(row => row.dataset.record === saved.record)?.querySelector('.athlete')?.focus({preventScroll: true});
    }
    window.scrollTo(0, saved?.scrollY || 0);
  }
  function focusHeading() {
    const heading = document.getElementById('page-heading');
    heading.tabIndex = -1; heading.focus({preventScroll: true});
  }
  function homeHref(discipline) {
    const params = new URLSearchParams();
    if (discipline === 'B') params.set('discipline', 'B');
    if (isClassSort(filters.sort)) params.set('sort', discipline === filters.discipline ? filters.sort :
      discipline === 'B' ? 'classBench' : 'total');
    return '#' + params;
  }
  const recordsHref = discipline => discipline === 'B' ? '#records&discipline=B' : '#records';
  function meetProjectHref(discipline) {
    const params = new URLSearchParams(meetHash(selectedAthlete).slice(1));
    if (discipline === 'B') params.set('discipline', 'B'); else params.delete('discipline');
    if (meetFilters.sort !== 'gl' && meetFilters.discipline !== discipline) {
      params.set('sort', discipline === 'B' ? 'classBench' : 'total');
    }
    if (selectedAthlete && !currentMeet.byAthlete.get(selectedAthlete)?.some(row =>
      (row.meet_disciplines || [resultDiscipline(row)]).includes(discipline))) params.delete('athlete');
    return '#' + params;
  }
  function syncNavigation(view, discipline) {
    const isMeet = view === 'meet' && !!currentMeet;
    for (const link of projectNav.querySelectorAll('a')) {
      const project = link.dataset.project;
      const active = project ? (view === 'home' || isMeet) && project === discipline : view === 'records';
      const available = !project || !isMeet || byMeet.get(currentMeet.id).disciplines.includes(project);
      if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
      if (available) {
        link.href = project ? isMeet ? meetProjectHref(project) : homeHref(project) : recordsHref(discipline);
        link.removeAttribute('aria-disabled');
      } else {
        link.removeAttribute('href'); link.setAttribute('aria-disabled', 'true');
      }
    }
  }
  function saveRecordsPosition(link) {
    window.IPFcnNavigation.replaceState({...history.state, recordsPosition: {scrollY: window.scrollY, href: link?.hash || ''}}, '');
  }
  projectNav.addEventListener('click', event => {
    const link = event.target.closest('a');
    if (!link || !link.hasAttribute('href') || !plainClick(event)) return;
    event.preventDefault();
    if (link.getAttribute('aria-current') === 'page') return;
    const fromHome = !rankingView.hidden;
    if (fromHome) saveRankingPosition(null, link.id);
    if (!recordsView.hidden) saveRecordsPosition();
    if (!meetView.hidden && currentMeet && link.dataset.project) {
      window.IPFcnNavigation.replaceState({...history.state, meetPosition: null}, '', link.href);
    } else {
      window.IPFcnNavigation.pushState(null, '', link.href);
    }
    showRoute(false, fromHome && link.id === 'nav-records');
  });

  let chartState = null;
  function showRecords(hash, translating, applyRankingSelection) {
    rankingView.hidden = true; athleteView.hidden = true; meetView.hidden = true;
    const discipline = hash.get('discipline') === 'B' ? 'B' : 'SBD';
    recordsSelect.value = discipline;
    syncNavigation('records', discipline);
    const title = tr('纪录与分布', 'Records & Distributions');
    document.getElementById('page-heading').textContent = title;
    document.getElementById('page-subtitle').textContent = 'RECORDS & DISTRIBUTIONS';
    document.title = title + ' · IPFcn';
    if (applyRankingSelection || chartState?.discipline !== discipline || chartState?.language !== language) {
      window.IPFcnRecords.render(recordsContent, {
        records: rankRows, language, discipline, athleteName, applyRankingSelection,
        meetName: meetTitle, recordFederations: catalog.recordFederations,
        athleteHref: r => r.has_profile ? '#athlete=' + encodeURIComponent(athleteKey(r)) : null,
        meetHref: r => byMeet.has(r.meet_id) ? '#' + new URLSearchParams(
          resultDiscipline(r) === 'B' ? {meet:r.meet_id, discipline:'B'} : {meet:r.meet_id}) : null,
        genderFilter: filters.genders.length === 1 ? filters.genders[0] : '',
        classFilter: filters.classes.length === 1 ? filters.classes[0] : ''
      });
      chartState = {language, discipline};
    }
    if (translating) return;
    const position = history.state?.recordsPosition;
    const link = position?.href && [...recordsContent.querySelectorAll('a[href]')].find(a => a.hash === position.href);
    if (link) link.focus({preventScroll: true}); else focusHeading();
    window.scrollTo(0, position?.scrollY || 0);
  }
  recordsSelect.addEventListener('change', () => {
    saveRecordsPosition();
    window.IPFcnNavigation.pushState(null, '', recordsHref(recordsSelect.value));
    showRoute();
    recordsSelect.focus({preventScroll: true});
  });
  recordsContent.addEventListener('click', event => {
    const link = event.target.closest('a[href]');
    if (!link || !plainClick(event) || !/^#(athlete|meet)=/.test(link.getAttribute('href'))) return;
    event.preventDefault();
    saveRecordsPosition(link);
    window.IPFcnNavigation.pushState({fromRecords: location.hash}, '', link.href);
    showRoute();
  });

  function showError(error, retry) {
    const box = element('div', undefined, 'empty');
    const button = element('button', tr('重试', 'Retry'));
    box.setAttribute('role', 'alert');
    box.append(element('p', tr('成绩暂时无法加载。', 'Results could not be loaded.')), button);
    button.addEventListener('click', retry, {once: true});
    const view = [recordsView, meetView, athleteView, rankingView].find(node => !node.hidden);
    (view || rankingView).prepend(box);
    box.dataset.loadError = '';
    delete root.dataset.languagePending;
    console.error(error);
  }
  function homeData(discipline, prefs, expanded) {
    const preview = prefs.sort === 'gl' && !prefs.years?.length &&
      !prefs.divisions?.length && !expanded;
    return preview ? store.preview(discipline) : store.ranks(discipline, prefs.years || []).then(rows => ({rows, counts: null}));
  }
  async function refreshHomeResults() {
    const version = ++routeVersion;
    document.querySelector('[data-load-error]')?.remove();
    try {
      const result = await homeData(filters.discipline, filters, listAll.size);
      if (version !== routeVersion) return;
      rankRows = result.rows; rankCounts = result.counts;
      render();
    } catch (error) {
      if (version === routeVersion) showError(error, refreshHomeResults);
    }
  }
  const meetViews = new WeakMap();
  function meetViewRows(rows) {
    if (!rows) return;
    if (!meetViews.has(rows)) meetViews.set(rows, rows.map(row => {
      const entered = row.placement_weight_class || row.weight_class;
      const displayed = rankingWeightClass(row.gender, entered, true);
      return entered === displayed && row.weight_class === displayed ? row : {...row, weight_class: displayed, placement_weight_class: entered};
    }));
    return meetViews.get(rows);
  }
  async function showRoute(translating = false, applyRankingSelection = false) {
    const version = ++routeVersion;
    requestedHref = location.href;
    document.querySelector('[data-load-error]')?.remove();
    let hash = new URLSearchParams(location.hash.slice(1));
    clearMeetCharts();
    const previous = hash.get('athlete');
    if (previous && Object.hasOwn(catalog.previousAthleteIds, previous)) {
      hash.set('athlete', catalog.previousAthleteIds[previous]);
      window.IPFcnNavigation.replaceState(history.state, '', '#' + hash.toString());
      requestedHref = location.href;
    }
    try {
      if (hash.has('records')) {
        const discipline = hash.get('discipline') === 'B' ? 'B' : 'SBD';
        const [rows] = await Promise.all([store.ranks(discipline, []), store.charts()]);
        if (version !== routeVersion) return;
        rankRows = rows;
      } else if (hash.has('meet')) {
        const id = hash.get('meet');
        const discipline = store.disciplineFor(id, hash.get('discipline') || 'SBD');
        const [rows] = await Promise.all([store.meetRows(id, discipline), discipline && store.charts()]);
        if (version !== routeVersion) return;
        activeMeetRows = meetViewRows(rows);
      } else if (hash.has('athlete')) {
        const archive = await store.archive(hash.get('athlete'));
        if (version !== routeVersion) return;
        if (archive.foreign) {
          const origin = new URLSearchParams((history.state?.fromMeet || '').replace(/^#/, ''));
          window.IPFcnNavigation.replaceState(null, '', '#' + (byMeet.has(origin.get('meet')) ? origin : ''));
          return showRoute(translating);
        }
        archiveRows = archive.rows;
      } else {
        const saved = translating ? null : history.state?.ranking;
        const discipline = hash.get('discipline') === 'B' || (!hash.has('discipline') && saved?.filters.discipline === 'B') ? 'B' : 'SBD';
        const prefs = {...(saved?.filters || filters)};
        if (hash.has('sort')) prefs.sort = restoreSort(hash.get('sort'));
        const [scope, result] = await Promise.all([store.scopes(), homeData(discipline, prefs, saved ? saved.expanded.length : listAll.size)]);
        if (version !== routeVersion) return;
        initHomeFilters(scope);
        rankRows = result.rows; rankCounts = result.counts;
      }
    } catch (error) {
      if (version === routeVersion) showError(error, () => showRoute(translating, applyRankingSelection));
      return;
    }
    document.body.dataset.view = hash.has('records') ? 'records' : hash.has('meet') ? 'meet' : hash.has('athlete') ? 'athlete' : 'home';
    window.IPFcnBranding();
    siteSearch.close(); meetSearch.close();
    recordsView.hidden = !hash.has('records');
    modeBlock.hidden = !recordsView.hidden;
    if (!recordsView.hidden) { showRecords(hash, translating, applyRankingSelection); return; }
    if (hash.has('meet')) {
      showMeet(hash, translating);
      syncNavigation('meet', meetFilters.discipline);
      return;
    }
    meetView.hidden = true;
    if (hash.has('athlete')) {
      rankingView.hidden = true;
      athleteView.hidden = false;
      const parent = history.state?.fromMeet;
      const fromRecords = history.state?.fromRecords;
      setBackLink(archiveBack, parent || fromRecords, parent ? '返回本场比赛' : fromRecords ? '返回纪录与分布' : '返回排行榜',
        parent ? 'MEET RESULTS' : fromRecords ? 'RECORDS & DISTRIBUTIONS' : 'RANKINGS');
      const origin = new URLSearchParams((parent || fromRecords || '').replace(/^#/, ''));
      syncNavigation('athlete', parent || fromRecords ? origin.get('discipline') || 'SBD' : filters.discipline);
      buildArchive(hash.get('athlete'));
      if (translating) return;
      const saved = history.state?.archivePosition;
      focusHeading();
      if (saved) {
        const row = [...archiveRecords.querySelectorAll('tr[data-record]')].find(item => item.dataset.record === saved.record);
        if (row) {
          row.closest('.table-scroll').scrollLeft = saved.scrollLeft;
          row.querySelector('.meet-link')?.focus({preventScroll: true});
        }
      }
      window.scrollTo(0, saved?.scrollY || 0);
      return;
    }
    const saved = translating ? null : history.state?.ranking;
    if (saved) {
      Object.assign(filters, {meetTypes: [], divisions: [], discipline: 'SBD'}, saved.filters);
      filters.classes = [...new Set(filters.classes.map(c => ({43: '47', 53: '59', 72: '76'}[c] || c)))];
      filters.sort = restoreSort(filters.sort);
      rankingPanel.manualGenders = saved.manualGenders ?? saved.filters.genders;
      if (!saved.manualGenders) filters.genders = rankingPanel.gendersForClasses();
      listAll.clear();
      saved.expanded.forEach(id => listAll.add(id));
      rankingPanel.sync();
    }
    const project = hash.get('discipline') === 'B' || (!hash.has('discipline') && saved?.filters.discipline === 'B') ? 'B' : 'SBD';
    if (filters.discipline !== project && filters.sort !== 'gl') filters.sort = 'total';
    if (hash.has('sort')) filters.sort = restoreSort(hash.get('sort'));
    filters.discipline = project;
    rankingPanel.sync();
    filters.genders = rankingPanel.gendersForClasses();
    updateFilter(form.querySelector('[data-key=genders]'), filters);
    syncNavigation('home', project);
    document.getElementById('page-heading').textContent = tr(rankingTitle, 'IPFcn Competition Results');
    document.getElementById('page-subtitle').textContent = rankingSubtitle;
    document.title = tr(rankingTitle, 'IPFcn Competition Results');
    athleteView.hidden = true; rankingView.hidden = false;
    render();
    if (translating) return;
    if (saved) {
      sections.querySelectorAll('.table-scroll').forEach((region, i) => { region.scrollLeft = saved.scrollRegions[i] || 0; });
      if (saved.focusControl?.startsWith('nav-')) {
        document.getElementById(saved.focusControl)?.focus({preventScroll: true});
      } else if (saved.focusControl === 'meet-select') {
        searchInput.value = saved.search || '';
        meetSelect.value = '';
        meetSelect.focus({preventScroll: true});
      } else if (saved.search) {
        searchInput.value = saved.search;
        searchInput.focus({preventScroll: true});
      } else {
        for (const row of sections.querySelectorAll('tr[data-record]')) {
          if (row.dataset.record === saved.focus) { row.querySelector('.athlete').focus({preventScroll: true}); break; }
        }
      }
      window.scrollTo(0, saved.scrollY);
    } else {
      window.scrollTo(0, 0);
    }
  }

  archiveBack.addEventListener('click', event => {
    if (!plainClick(event)) return;
    event.preventDefault();
    if (history.state?.fromRankings || history.state?.fromMeet || history.state?.fromRecords) { history.back(); return; }
    window.IPFcnNavigation.replaceState(null, '', location.pathname + location.search);
    showRoute();
  });
  function clearMeetAthlete(event) {
    if (!plainClick(event)) return;
    event.preventDefault();
    if (history.state?.backToAll) { history.back(); return; }
    window.IPFcnNavigation.replaceState(null, '', meetHash());
    showRoute();
  }
  clearAthlete.addEventListener('click', clearMeetAthlete);
  meetBack.addEventListener('click', event => {
    if (!plainClick(event)) return;
    if (currentMeet && selectedAthlete) { clearMeetAthlete(event); return; }
    event.preventDefault();
    if (history.state?.meetOrigin || history.state?.fromRankings || history.state?.fromRecords) { history.back(); return; }
    window.IPFcnNavigation.replaceState(null, '', location.pathname + location.search);
    showRoute();
  });
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  function restoreHistoryRoute() {
    const url = new URL(location.href);
    if (url.searchParams.has('lang') && url.searchParams.get('lang') !== language) {
      url.searchParams.set('lang', language);
      window.IPFcnNavigation.replaceState(history.state, '', url);
    }
    showRoute();
  }
  window.addEventListener('popstate', restoreHistoryRoute);
  window.addEventListener('hashchange', () => {
    if (requestedHref !== location.href) restoreHistoryRoute();
  });
  const rankingPanel = setupFilterPanel(form, filters, limits, new Map(), () => scopes.filter(meetsHomeScope), () => {
    const hash = homeHref(filters.discipline);
    if ((location.hash || '#') !== hash) window.IPFcnNavigation.replaceState(history.state, '', hash);
    listAll.clear();
    syncNavigation('home', filters.discipline);
    refreshHomeResults();
  });
  const meetPanel = setupFilterPanel(meetForm, meetFilters, meetLimits, new Map(), () => [], () => {
    window.IPFcnNavigation.replaceState({...history.state, meetPosition: null}, '', meetHash(selectedAthlete));
    if (selectedAthlete) setBackLink(meetBack, meetHash(), '返回本场比赛', 'MEET RESULTS');
    renderMeet();
    syncNavigation('meet', meetFilters.discipline);
  });
  let homeEntries;
  async function homeSearchEntries() {
    if (!homeEntries) {
      const entries = await store.search();
      homeEntries ??= [...entries.map(({record, classes, aliases}) => athleteSearchEntry(record, classes, aliases)), ...indexMeets()];
    }
    return homeEntries;
  }
  const siteSearch = setupSearch(searchInput, searchMatches, searchStatus, homeSearchEntries, row => createAthleteLink(row, true), true);
  const meetSearch = setupSearch(meetSearchInput, document.getElementById('meet-athlete-matches'),
    document.getElementById('meet-search-status'), () => meetSearchIndex, meetSearchLink);
  translatePage();
  meetSelect.addEventListener('change', () => {
    const row = byMeet.get(meetSelect.value);
    if (row) openHomeMeet(row, 'meet-select');
  });
  languageSelect.addEventListener('change', async () => {
    language = languageSelect.value === 'en' ? 'en' : 'zh';
    const url = new URL(location.href);
    url.searchParams.set('lang', language);
    window.IPFcnNavigation.replaceState(history.state, '', url);
    try { localStorage.setItem('ipfcn_result.language', language); } catch {}
    const view = [rankingView, athleteView, meetView, recordsView].find(node => !node.hidden);
    const scrollY = window.scrollY;
    const offsets = [...view.querySelectorAll('.table-scroll')].map(node => node.scrollLeft);
    const siteMatchesOpen = !searchMatches.hidden;
    const meetMatchesOpen = !document.getElementById('meet-athlete-matches').hidden;
    translatePage();
    if (rankingPanelReady) rankingPanel.populate();
    await showRoute(true);
    if (siteMatchesOpen && !rankingView.hidden) siteSearch.refresh();
    if (meetMatchesOpen && !meetView.hidden) meetSearch.refresh();
    view.querySelectorAll('.table-scroll').forEach((node, i) => { node.scrollLeft = offsets[i] || 0; });
    window.scrollTo(0, scrollY);
  });
  await showRoute();
  root.dataset.resultsReady = 'true';
  delete root.dataset.languagePending;
})();
