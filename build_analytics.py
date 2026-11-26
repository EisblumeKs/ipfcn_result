"""Pack the records page from the same eligible results as the annual ranking views."""
from collections import defaultdict
from fractions import Fraction
import json
from pathlib import Path
from statistics import mean, median

AGES = ('公开组', '少年组', '青年组', '大师一组', '大师二组', '大师三组', '大师四组')
YOUTH = {'少年组', '青年组'}
METRICS = {'B': ('bench',), 'SBD': ('squat', 'bench', 'deadlift', 'total')}
# Kept as tables so a result and a meet each have one identity even when they hold several marks.
RESULT_FIELDS = ('record_id', 'athlete_id', 'gender', 'name', 'name_en', 'has_profile',
                 'source_order', 'year', 'meet_date', 'meet_end_date', 'date_precision')
MEET_FIELDS = ('meet_id', 'discipline', 'meet_name', 'meet_name_en', 'meet_start', 'meet_end')
WORLD_EVENT = ('meet_id', 'meet_discipline', 'meet_name_zh', 'meet_name_en')
WORLD_FIELDS = ('gender', 'class', 'age_group', 'discipline', 'metric', 'value', 'name', 'country', 'date', 'standard')


def class_for(row, youth):
    weight = row.get('placement_weight_class') or row['weight_class']
    if row['gender'] == 'F' and weight == '72':
        return '76'
    if not youth:
        if row['gender'] == 'F' and weight == '43':
            return '47'
        if row['gender'] == 'M' and weight == '53':
            return '59'
    return weight


def class_key(gender, weight, youth):
    merged = not youth and (gender, weight) in (('F', '47'), ('M', '59'))
    return gender + '/' + weight + ('/merged' if merged else '')


def period(row):
    if row.get('date_precision') == 'year':
        start = end = str(row['year'])
    else:
        start = row.get('meet_date') or row.get('meet_start') or str(row['year'])
        end = row.get('meet_end_date') or (not row.get('meet_date') and row.get('meet_end')) or start
    return start + '-01-01' if len(start) == 4 else start, end + '-12-31' if len(end) == 4 else end


def counts_for_record(row):
    federation = row['record_federation']
    if row['meet_type'] == 'domestic':
        return federation == 'IPFcn' and row['year'] >= 2020
    return (row['meet_type'] == 'international' and federation in ('APF', 'IPF')
            and row.get('team', '').strip().lower() in ('chn', 'china', '中国'))


def class_sort(value):
    return float(value.rstrip('+')), value.endswith('+')


def sample(rows, metrics):
    # Per-athlete maxima are taken again across all years for the all-years file.
    classes = {}
    gl = defaultdict(dict)
    for row in rows:
        gender, athlete = row['gender'], row['athlete_id']
        score = row.get('gl')
        if score and score > gl[gender].get(athlete, 0):
            gl[gender][athlete] = score
        keys = dict.fromkeys(class_key(gender, weight, youth) for youth in (False, True)
                             if (weight := class_for(row, youth)))
        for key in keys:
            if key not in classes:
                classes[key] = [{} for _ in metrics]
            for metric, best in zip(metrics, classes[key]):
                value = row.get(metric)
                if value and value > best.get(athlete, 0):
                    best[athlete] = value
    return {'classes': {key: [sorted(best.values()) for best in by_metric]
                        for key, by_metric in classes.items()},
            'gl': {gender: sorted(by_athlete.values()) for gender, by_athlete in gl.items()}}


def rank_by_score(rows, metric):
    # As on the rankings page, a missing weigh-in precludes breaking that score's tie.
    missing_weigh_in = {row[metric] for row in rows if row['bodyweight'] is None}

    def score(row):
        return -row[metric], 0 if row[metric] in missing_weigh_in else row['bodyweight']

    previous = None
    for index, row in enumerate(sorted(rows, key=score), 1):
        current = score(row)
        if current != previous:
            place = index
            previous = current
        yield row, place


# These keys identify published age-division placings in placingStats.periods.
# The additional "combined" scope ranks all eligible finishers across divisions.
PLACING_SCOPES = {
    '公开组': 'open', '少年组': 'subjunior', '青年组': 'junior',
    '大师一组': 'masters1', '大师二组': 'masters2', '大师三组': 'masters3', '大师四组': 'masters4',
}


def age_group_places(row):
    places = {}
    primary = PLACING_SCOPES.get(row['division'])
    if primary and row.get('class_place'):
        places[primary] = row['class_place']
    for entry in row.get('class_places', ()):
        scope = PLACING_SCOPES.get(entry['division'])
        if scope and entry.get('place'):
            places[scope] = entry['place']
    return places


def nearest_increment(value):
    # Round half upwards to the next 2.5 kg using exact decimal input.
    step = Fraction(5, 2)
    return float(((value + step / 2) // step) * step)


def placing_summary(performances, limit):
    scores = []
    athletes = set()
    for athlete, place, score in performances:
        if place <= limit:
            scores.append(score)
            athletes.add(athlete)
    if not scores:
        return [0, None, None, []]
    return [len(athletes), nearest_increment(mean(scores)), nearest_increment(median(scores)),
            [float(score) for score in sorted(scores)]]


def placing_stats(rows, discipline):
    metric = 'bench' if discipline == 'B' else 'total'
    groups = defaultdict(list)
    classes = {'M': set(), 'F': set()}
    years = set()
    for row in rows:
        if row['discipline'] != discipline or row['meet_type'] != 'domestic':
            continue
        years.add(str(row['year']))
        if row.get('status') or row['place_basis'] == 'guest':
            continue
        places = age_group_places(row)
        if not row.get('class_place') and not places:
            continue
        gender = row['gender']
        original = row.get('placement_weight_class') or row['weight_class']
        # Women's historical 72 kg stays separate for placing statistics.
        weight = {('M', '53'): '59', ('F', '43'): '47'}.get((gender, original), original)
        classes[gender].add(weight)
        groups[row['meet_id'], gender, weight, 'combined'].append((row, None))
        for scope, place in places.items():
            groups[row['meet_id'], gender, weight, scope].append((row, place))

    performances = defaultdict(list)
    for (_, gender, weight, scope), results in groups.items():
        original_classes = {row.get('placement_weight_class') or row['weight_class']
                            for row, _ in results}
        # Preserve each division's published placings unless separate podiums are merged.
        if scope == 'combined' or len(original_classes) > 1:
            results = rank_by_score([row for row, _ in results], metric)
        for row, place in results:
            if place > 3:
                continue
            performance = (row['athlete_id'], place, Fraction(str(row[metric])))
            for period_key in ('all', str(row['year'])):
                performances[period_key, scope, gender, weight].append(performance)

    years = sorted(years, reverse=True)
    periods = {key: {scope: {'M': {}, 'F': {}} for scope in (*PLACING_SCOPES.values(), 'combined')}
               for key in ('all', *years)}
    for (period_key, scope, gender, weight), entries in performances.items():
        periods[period_key][scope][gender][weight] = [
            placing_summary(entries, limit) for limit in (3, 2, 1)]
    return {'years': years, 'classes': {g: sorted(values, key=class_sort) for g, values in classes.items()},
            'periods': periods}


def national_records(rows, metrics):
    possible = defaultdict(list)
    for row in rows:
        if not counts_for_record(row):
            continue
        divisions = (row.get('age_division') or row.get('division') or '').split(' / ')
        for age in AGES:
            if age == '公开组' or age in divisions:
                weight = class_for(row, age in YOUTH)
                if weight:
                    possible['/'.join((row['gender'], weight, age))].append(row)
    records, results, meets = {}, [], []
    result_ids, meet_ids = {}, {}
    for key, group in possible.items():
        records[key] = []
        for metric in metrics:
            maximum = max((r.get(metric) or 0 for r in group), default=0)
            ties = [r for r in group if maximum and r.get(metric) == maximum]
            first_end = min((period(r)[1] for r in ties), default='')
            winners = []
            for row in ties:
                if period(row)[0] > first_end:
                    continue
                rid, mid = row['record_id'], row['meet_id']
                if rid not in result_ids:
                    if mid not in meet_ids:
                        meet_ids[mid] = len(meets)
                        meets.append([row.get(k) for k in MEET_FIELDS])
                    result_ids[rid] = len(results)
                    results.append([meet_ids[mid], *[row.get(k) for k in RESULT_FIELDS],
                                    *[row.get(k) for k in metrics]])
                winners.append(result_ids[rid])
            records[key].append(winners)
    return {'groups': records, 'resultFields': [*RESULT_FIELDS, *metrics], 'results': results,
            'meetFields': MEET_FIELDS, 'meets': meets}


def world_records(rows):
    events, sources, entries = {}, {}, []
    for row in rows:
        event = tuple(row[k] for k in WORLD_EVENT)
        event_index = events.setdefault(event, len(events))
        source_index = sources.setdefault(row['source'], len(sources))
        # Fail loudly on new input fields rather than silently dropping future source annotations.
        if row.keys() != set(WORLD_EVENT) | set(WORLD_FIELDS) | {'source'}:
            raise ValueError('Unexpected world record fields')
        entries.append([event_index, source_index, *[row[k] for k in WORLD_FIELDS]])
    return {'fields': WORLD_FIELDS, 'eventFields': WORLD_EVENT, 'events': list(events),
            'sources': list(sources), 'entries': entries}


def build_analytics(ranking, asset, archive_rows):
    """Return discipline -> immutable index URL, using the packer's asset(kind, object)."""
    world = json.loads(Path(__file__).with_name('world_records.json').read_text(encoding='utf-8'))
    index = {}
    for discipline, metrics in METRICS.items():
        rows = sorted((r for r in ranking[discipline] if r['rankings_eligible']
                       and r.get('status') not in ('DNF', 'OVERWEIGHT', 'NS')
                       and r['gender'] in ('M', 'F')), key=lambda r: r['source_order'])
        by_year = defaultdict(list)
        for row in rows:
            by_year[row['year']].append(row)
        classes = {}
        for gender in ('M', 'F'):
            classes[gender] = {
                group: sorted({weight for r in rows if r['gender'] == gender
                               if (weight := class_for(r, youth))}, key=class_sort)
                for group, youth in (('open', False), ('youth', True))}
        analytics = {
            'classes': classes, 'all': sample(rows, metrics),
            'years': {str(year): asset('samples', sample(group, metrics)) for year, group in by_year.items()},
            'national': national_records(rows, metrics),
            'world': world_records(r for r in world if r['discipline'] == discipline),
            'placingStats': placing_stats(archive_rows, discipline)}
        index[discipline] = asset('analytics', analytics)
    return index
