"""Build immutable, on-demand assets for the IPFcn rankings using the owner-maintained public CSV."""
from build_analytics import build_analytics
import argparse
import csv
import hashlib
import json
import math
import re
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path
from tempfile import TemporaryDirectory

COLUMNS = [
    '成绩ID','运动员ID','姓名','拼音或排序名','其他姓名','性别','年份','赛事类别','代表队','纳入总榜','赛事名称','赛事英文名','赛事ID',
    '赛事首日','赛事末日','比赛日期或赛期首日','赛期末日','报名年龄组','榜单级别(kg)','名次所属级别(kg)','名次所属组别','级别名次','各组别名次',
    '名次依据','体重(kg)','蹲举(kg)','卧推举(kg)','硬举(kg)','总成绩(kg)','IPF GL系数','比赛项目','装备类别'
]
BASIS = {'赛事成绩表': 'official', '来宾，无正式名次': 'guest', '': 'unknown',
         '同场同性别、同年龄组与同体重级别的三项总成绩': 'computed_age_weight_class',
         '同场同性别、同年龄组与同体重级别的卧推举成绩': 'computed_bench_class'}
GL = {'SBD': {'M': (1199.72839, 1025.18162, .00921), 'F': (610.32796, 1045.59282, .03048)},
      'B': {'M': (320.98041, 281.40258, .01008), 'F': (142.40398, 442.52671, .04724)}}
DISCIPLINES = ('SBD','B')
STATUS_COLUMN = '完赛状态'
STATUS_LABELS = {'': None, '完赛': None, 'DNF': 'DNF', '未完赛 / DNF': 'DNF',
                 'OVERWEIGHT': 'OVERWEIGHT', '称重超重 / Overweight': 'OVERWEIGHT',
                 'NS': 'NS', '未到场 / NS': 'NS'}
CHINA = {'chn','china','中国'}
MERGED = {('M', '53'): '59', ('F', '43'): '47', ('F', '72'): '76'}
MEET_FIELDS = ('meet_id','meet_name','meet_name_en','year','meet_type','meet_start','meet_end','meet_date','date_precision')
SEARCH_FIELDS = ('record_id','athlete_id','name','name_sort','name_en','gender','year','discipline','total','bench','has_profile')
SCOPE_FIELDS = ('year','meet_type','discipline','gender','weight_class','division')
# Established two-character surnames. Athlete-specific spellings in metadata take precedence.
COMPOUND_SURNAMES = set((
    '欧阳 歐陽 司马 司馬 上官 诸葛 諸葛 夏侯 皇甫 司徒 司空 慕容 令狐 宇文 长孙 長孫 尉迟 尉遲 '
    '公孙 公孫 东方 東方 南宫 南宮 司寇 闻人 聞人 钟离 鍾離 端木 百里 仲孙 仲孫 呼延 褚师 褚師 '
    '轩辕 軒轅 独孤 獨孤 公羊 公冶 鲜于 鮮于 公输 公輸 澹台 万俟 萬俟 微生'
).split())
ALTERNATE_HAN_NAME = re.compile(r'([\u3400-\u9fff·]+)\s*[（(]([\u3400-\u9fff·]+)[）)]')


def encoded(obj):
    return json.dumps(obj,ensure_ascii=False,separators=(',', ':'),allow_nan=False).encode('utf-8')


def english_name(name, sort):
    if not re.search(r'[\u3400-\u9fff]', name):
        return name
    words = sort.split()
    if not words or not re.search(r'[A-Za-z]',sort):
        return name
    if '·' in name:
        return ' '.join(part.replace(' ', '').title() for part in sort.split('·'))
    end = 2 if name[:2] in COMPOUND_SURNAMES else 1
    return ' '.join(filter(None, [''.join(words[end:]).title(), ''.join(words[:end]).title()]))


def domestic_meet_titles(mid, year, zh, en):
    titles = {}
    for lang, original in (('zh', zh), ('en', en)):
        title = re.sub(rf'^{year}\s*(?:年\s*)?', '', original, count=1)
        title = re.sub(r'IPF(?:cn)?(?![A-Za-z])', 'IPFcn', title, flags=re.I)
        if lang == 'zh':
            title = re.sub(r'IPFcn\s*力量举', 'IPFcn', title)
        elif mid == 'ipfcn-greater-bay-2025':
            title = ('IPFcn Guangdong-Hong Kong-Macao Greater Bay Area Powerlifting Invitational '
                     'and 3rd Southern University Cup Powerlifting Invitational')
        if 'IPFcn' not in title:
            # Retain the archive's edition-before-federation convention.
            if lang == 'zh':
                title = re.sub(r'^(第[一二三四五六七八九十百零〇两\d]+届)?', r'\1IPFcn', title, count=1)
            else:
                title = re.sub(r'^(\d+(?:st|nd|rd|th)\s+)?', r'\1IPFcn ', title, count=1, flags=re.I)
        titles[lang] = str(year) + ('年' if lang == 'zh' else ' ') + title
    return titles


def number(value):
    if not value:
        return None
    n = float(value)
    if not math.isfinite(n) or n <= 0:
        raise ValueError('Invalid positive number: '+value)
    return int(n) if n.is_integer() else n


def parse_row(c, metadata):
    name, aid, rid, mid = (c[k] for k in ('姓名','运动员ID','成绩ID','赛事ID'))
    sort = c['拼音或排序名'] or name
    source_spellings = []
    alternatives = ALTERNATE_HAN_NAME.fullmatch(name.strip())
    if alternatives:
        source_spellings = [name, alternatives[2]]
        name = alternatives[1]
        sort = re.split(r'\s*[（(]', sort, maxsplit=1)[0].strip() or name
    if not all((name,aid,rid,mid,c['赛事名称'])):
        raise ValueError('Missing identity or missing competition')
    gender = {'男':'M','女':'F'}[c['性别']]
    event = {'卧推举单项':'B','力量举三项':'SBD'}[c['比赛项目']]
    status = STATUS_LABELS[c.get(STATUS_COLUMN, '')]
    meet_type = {'国内赛':'domestic','国际赛':'international'}[c['赛事类别']]
    eligible = {'是':True, '否':False}[c['纳入总榜']]
    team = c['代表队']
    if c['装备类别']!='经典' or (meet_type=='international' and (not team or eligible and team.lower() not in CHINA)):
        raise ValueError('Unknown equipment or inconsistent represented team')
    year = int(c['年份'])
    if not re.fullmatch(r'\d{4}',c['年份']) or year<(2017 if meet_type=='international' else 2020):
        raise ValueError('Invalid competition year')
    start, end, day, last = [c[k] for k in ('赛事首日','赛事末日','比赛日期或赛期首日','赛期末日')]
    for value in filter(None,(start,end,day,last)):
        if date.fromisoformat(value).isoformat()!=value:
            raise ValueError('Invalid competition date: '+value)
    start = start or str(year)
    end = end or start
    if not start.startswith(str(year)) or end < start:
        raise ValueError('Invalid meet date range')
    if not day and end != start and not last:
        last = end
    weight_class = c['榜单级别(kg)']
    actual = c['名次所属级别(kg)'] or weight_class
    if (weight_class or actual or status != 'NS') and not all(
        re.fullmatch(r'[1-9]\d*(?:\.\d+)?\+?', k) for k in (weight_class,actual)
    ):
        raise ValueError('Invalid weight class')
    weight_class = MERGED.get((gender,actual),actual)
    bw, squat, bench, deadlift, total, gl = [number(c[k]) for k in (
        '体重(kg)','蹲举(kg)','卧推举(kg)','硬举(kg)','总成绩(kg)','IPF GL系数')]
    if event == 'B' and any(x is not None for x in (squat, deadlift, total)):
        raise ValueError('Bench-only record contains lifts or total from powerlifting')
    if status:
        if total is not None or gl is not None or c['级别名次'] or c['各组别名次']:
            raise ValueError(f'{status} must have empty total, GL and placings')
        if status == 'NS' and (eligible or any(x is not None for x in (squat,bench,deadlift))):
            raise ValueError('A no-show cannot have lifts or be included in rankings')
    else:
        if not bench or (event == 'SBD' and (not all((squat, deadlift, total)) or abs(squat+bench+deadlift-total) > .011)):
            raise ValueError('Incomplete or inconsistent performance')
        if gl is None and bw:
            a,b,k = GL[event][gender]
            score = 100*(bench if event=='B' else total)/(a-b*math.exp(-k*bw))
            if not math.isfinite(score) or score <= 0:
                raise ValueError('Cannot calculate GL points from bodyweight')
            gl = math.floor(score*100+.5)/100
        if eligible and not (bw and gl):
            raise ValueError('Missing ranked bodyweight or GL points')
    meet_name = c['赛事名称']
    meet_name_en = c['赛事英文名'] or meet_name
    if meet_type == 'domestic':
        if not c['赛事英文名']:
            meet_name_en = metadata.get('meets', {}).get(mid, {}).get('en') or meet_name
        titles = domestic_meet_titles(mid, year, meet_name, meet_name_en)
        meet_name, meet_name_en = titles['zh'], titles['en']
    place=number(c['级别名次'])
    if place is not None and not isinstance(place,int):
        raise ValueError('Invalid placing')
    division=c['名次所属组别']
    places=[]
    for part in filter(None,re.split(r'[;；]',c['各组别名次'])):
        match=re.fullmatch(r'(.+?)\s+第([1-9]\d*)名',part.strip())
        if not match:
            raise ValueError('Invalid division placing: '+part)
        places.append({'division':match[1], 'place':int(match[2])})
    row=dict(record_id=rid,athlete_id=aid,name=name,name_sort=sort,
             name_en=metadata.get('athletes',{}).get(aid) or english_name(name,sort),
             gender=gender,year=year,discipline=event,equipment='Raw',meet_type=meet_type,
             meet_id=mid,meet_name=meet_name,meet_name_en=meet_name_en,
             meet_start=start,meet_end=end,meet_date=day or start,age_division=c['报名年龄组'],
             division=division,class_place=place,place_basis=BASIS[c['名次依据']],
             weight_class=weight_class,bodyweight=bw,squat=squat,bench=bench,deadlift=deadlift,total=total,
             gl=gl,rankings_eligible=eligible,
             record_federation=c.get('赛事认证机构',metadata.get('recordFederations',{}).get(mid,'')))
    if status:
        row['status'] = status
    if status == 'NS':
        divisions = list(dict.fromkeys(d.strip() for d in row['age_division'].split(' / ') if d.strip()))
        if len(divisions) > 1:
            row['registration_divisions'] = divisions
    if team:
        row['team']=team
    if actual!=weight_class:
        row['placement_weight_class']=actual
    if last:
        row['meet_end_date']=last
    if len(start)==4:
        row['date_precision']='year'
    if places and places!=[{'division':division, 'place':place}]:
        row['class_places']=places
    raw_aliases=[*c['其他姓名'].split(' / '), *metadata.get('aliases',{}).get(gender+'/'+aid,[]), *source_spellings]
    row['alternate_names']=list(dict.fromkeys(x for x in raw_aliases if x))
    return row


def load_rows(csv_path,metadata,changed_titles=None):
    rows=[]
    ids=set()
    with csv_path.open(encoding='utf-8-sig',newline='') as f:
        data=csv.DictReader(f,strict=True)
        head=data.fieldnames or []
        if len(set(head))!=len(head) or set(COLUMNS)-set(head):
            raise ValueError('Missing or duplicate downloadable-CSV headers')
        for c in data:
            try:
                if None in c or None in c.values():
                    raise ValueError('Wrong column count')
                row=parse_row({k:v.strip() for k,v in c.items()},metadata)
                if row['record_id'] in ids:
                    raise ValueError('Duplicate result ID '+row['record_id'])
                ids.add(row['record_id'])
                row['source_order']=len(rows)
                rows.append(row)
                if changed_titles is not None and row['meet_type']=='domestic':
                    titles=(row['meet_name'],row['meet_name_en'])
                    if titles!=(c['赛事名称'],c['赛事英文名']):
                        changed_titles[row['record_id']]=titles
            except (ValueError,KeyError) as exc:
                raise ValueError(f'CSV row {data.line_num}: {exc}') from exc
    if not rows:
        raise ValueError('No competition results')
    return rows


def rank_table(rows, output):
    """Write a Zarr v3 array. Each column's nonzero codes index its lossless value dictionary."""
    import struct

    columns = {}
    constants = {}
    block = bytearray()
    width = 2 if len(rows) <= 65535 else 4
    code = 'H' if width == 2 else 'I'
    fields = sorted({k for row in rows for k in row})
    for field in fields:
        # Zero preserves an absent optional field, independently of an explicit JSON null.
        values, indexes, codes = [], {}, []
        for row in rows:
            if field not in row:
                codes.append(0)
                continue
            value = row[field]
            key = encoded(value)
            if key not in indexes:
                values.append(value)
                indexes[key] = len(values)
            codes.append(indexes[key])
        if len(values) == 1 and 0 not in codes:
            constants[field] = values[0]
        else:
            columns[field] = values
            block.extend(struct.pack(f'<{len(codes)}{code}', *codes))
    # Singleton seasons also have a valid, nonempty Zarr chunk.
    shape = [max(1, len(columns)), len(rows)]
    if not columns:
        block.extend(bytes(width * len(rows)))
    header = encoded({
        'zarr_format': 3, 'node_type': 'array', 'shape': shape,
        'data_type': 'uint16' if width == 2 else 'uint32',
        'chunk_grid': {'name': 'regular', 'configuration': {'chunk_shape': shape}},
        'chunk_key_encoding': {'name': 'default', 'configuration': {'separator': '/'}},
        'fill_value': 0, 'codecs': [{'name': 'bytes', 'configuration': {'endian': 'little'}}],
        'dimension_names': ['field', 'result'],
        'attributes': {'constants': constants, 'fields': list(columns), 'dictionaries': list(columns.values())}
    })
    digest = hashlib.sha256(header + block).hexdigest()[:24]
    directory = output/'assets/data'/('rank-' + digest + '.zarr')
    chunk = directory/'c/0/0'
    chunk.parent.mkdir(parents=True, exist_ok=True)
    (directory/'zarr.json').write_bytes(header)
    chunk.write_bytes(block)
    return directory.relative_to(output).as_posix()


def gl_preview(rows):
    result=[]
    counts={}
    def performance(row):
        return (row['gl'], row['total'] or row['bench'], -(row['bodyweight'] or math.inf))
    for gender in ('M','F'):
        people={}
        appeared=set()
        for r in rows:
            if r['gender']!=gender:
                continue
            appeared.add(r['athlete_id'])
            if r['gl'] is None:
                continue
            best=people.get(r['athlete_id'])
            if best is None or performance(r)>performance(best):
                people[r['athlete_id']]=r
        counts[gender]=len(appeared)
        ranked=sorted(people.values(),key=lambda r:(-r['gl'],r['name_sort']))
        result.extend(ranked[:25])
    return {'rows':result,'counts':counts}


def pack(csv_path, metadata, output):
    changed_titles={}
    rows=load_rows(csv_path,metadata,changed_titles)
    countries=metadata.get('athleteCountries',{})
    additional_profiles=set(metadata.get('additionalAthleteProfiles', ()))
    people=defaultdict(list)
    competitions=defaultdict(lambda:defaultdict(list))
    entries=defaultdict(set)
    for r in rows:
        key=r['gender']+'/'+r['athlete_id']
        people[key].append(r)
        mid=r['meet_id']
        event=r['discipline']
        competitions[mid][event].append(r)
        entries[(mid,key)].add(event)
    search=[]
    buckets=[{'profiles':{},'foreign':[]} for _ in range(32)]
    directory=output/'assets/data'
    directory.mkdir(parents=True,exist_ok=True)
    def asset(kind, obj):
        content=encoded(obj)
        digest=hashlib.sha256(content).hexdigest()[:24]
        file=directory/(kind+'-'+digest+'.json')
        if not file.exists() or file.read_bytes()!=content:
            file.write_bytes(content)
        return file.relative_to(output).as_posix()
    for key, group in people.items():
        country=countries.get(key)
        available=key in additional_profiles or any((r.get('team','').lower() in CHINA if r['meet_type']=='international' else
                       (country.lower() in CHINA if country else r['rankings_eligible'] or r.get('status')=='NS')) for r in group)
        aliases=dict.fromkeys(a for r in group for a in r['alternate_names'])
        for r in group[1:]:
            for field in ('name','name_sort','name_en'):
                if r[field]!=group[0][field]:
                    aliases[r[field]]=None
        bucket_id=0
        for c in key:
            bucket_id=(31*bucket_id+ord(c))%len(buckets)
        bucket=buckets[bucket_id]
        for r in group:
            r['has_profile']=available
            r['alternate_names']=list(aliases)
            if len(entries[(r['meet_id'],key)])>1:
                r['meet_disciplines']=list(DISCIPLINES)
        if not available:
            bucket['foreign'].append(key)
            continue
        bucket['profiles'][key]={'file':asset('athlete',group),'ids':[r['record_id'] for r in group]}
        classes=sorted({r['weight_class'] for r in group if r['weight_class']},key=lambda c:(float(c.rstrip('+')),c.endswith('+')))
        representative = next((r for r in group if not r.get('status')), group[0])
        record={k:representative[k] for k in SEARCH_FIELDS}
        if representative.get('status'):
            record['status'] = representative['status']
        search.append({'record':record,'classes':classes,'aliases':list(aliases)})
    scope_rows={}
    ranking={d:[] for d in DISCIPLINES}
    for r in rows:
        if not r['rankings_eligible']:
            continue
        ranking[r['discipline']].append(r)
        for div in r.get('class_places') or [{'division':r['division'] or r['age_division']}]:
            scope={k:r[k] for k in SCOPE_FIELDS}
            scope['division']=div['division']
            scope_rows.setdefault(tuple(scope.values()),scope)
    meets=[]
    meet_files={}
    for mid,events in competitions.items():
        first=next(iter(events.values()))[0]
        identity=('year','meet_type','meet_start','meet_end','meet_name','meet_name_en','record_federation')
        if any(any(row[k]!=first[k] for k in identity) for group in events.values() for row in group):
            raise ValueError(f'Conflicting venue, dates, titles or federation for {mid}')
        meet={k:first[k] for k in MEET_FIELDS if k in first}
        details = metadata.get('meets', {}).get(mid, {})
        for field in ('location', 'location_en'):
            if details.get(field):
                meet[field] = details[field]
        meet['disciplines']=[d for d in DISCIPLINES if d in events]
        meet['counts']={d:len(events.get(d,[])) for d in DISCIPLINES}
        if metadata.get('meetAliases',{}).get(mid):
            meet['alternate_names']=metadata['meetAliases'][mid]
        meets.append(meet)
        meet_files[mid]={d:asset('meet',group) for d,group in events.items()}
    previews={}
    annual_ranks={}
    counts_by_year={}
    preview_years={}
    ranking_views={}
    def preview_index(file, part):
        return {'file': file, 'orders': [r['source_order'] for r in part['rows']], 'counts': part['counts']}
    for d in DISCIPLINES:
        preview=gl_preview(ranking[d])
        previews[d]=asset('preview',preview)
        views={'all':preview_index(previews[d],preview)}
        global_orders=set(views['all']['orders'])
        for kind in ('domestic','international'):
            matching=[r for r in ranking[d] if r['meet_type']==kind]
            part=gl_preview(matching)
            view=preview_index(asset('preview',part),part)
            extra=[r for r in part['rows'] if r['source_order'] not in global_orders]
            if extra:
                view['extra']=asset('ranks',extra)
            extra_orders={r['source_order'] for r in extra}
            by_year=defaultdict(list)
            for r in matching:
                by_year[str(r['year'])].append(r)
            view['years']={}
            for year,group in by_year.items():
                season={'count':len(group)}
                remainder=[r for r in group if r['source_order'] not in global_orders and r['source_order'] not in extra_orders]
                if remainder:
                    season['remainder']=asset('ranks',remainder)
                for label,orders in (('global',global_orders),('extra',extra_orders)):
                    members=[r for r in group if r['source_order'] in orders]
                    if members:
                        season[label]={'file':asset('ranks',members),'orders':[r['source_order'] for r in members]}
                view['years'][year]=season
            views[kind]=view
        ranking_views[d]=views
        counts_by_year[d]=dict(Counter(str(row['year']) for row in ranking[d]))
        preview_years[d]=sorted({row['year'] for row in preview['rows']})
        shipped={r['record_id'] for r in preview['rows']}
        years=defaultdict(list)
        for r in ranking[d]:
            annual=years[r['year']]
            if r['record_id'] not in shipped:
                annual.append(r)
        annual_ranks[d]={str(year):asset('ranks',group) if group else None for year,group in years.items()}
    assets={'scopes':asset('scopes',list(scope_rows.values())), 'preview':previews, 'ranks':annual_ranks,
            'meets':meet_files, 'search':asset('search',search), 'profiles':[asset('profiles',bucket) for bucket in buckets]}
    assets['analytics'] = build_analytics(ranking, asset)
    assets['rankTables'] = {}
    for discipline, records in ranking.items():
        partitions = defaultdict(lambda: defaultdict(list))
        for row in records:
            partitions[str(row['year'])][row['meet_type']].append(row)
        assets['rankTables'][discipline] = {
            year: {kind: rank_table(group, output) for kind, group in types.items()}
            for year, types in partitions.items()}
    catalog={'meets':meets,'assets':assets,'rankingCounts':counts_by_year,'previewYears':preview_years,'rankingViews':ranking_views,
             'athleteNotes':metadata.get('athleteNotes', {}),
             'previousAthleteIds':metadata.get('previousAthleteIds',{}),
             'recordFederations':{mid:next(iter(events.values()))[0]['record_federation']
                                  for mid,events in competitions.items()}}
    if changed_titles:
        destination=output/'IPFcn-results.csv'
        with TemporaryDirectory(dir=output) as staging:
            updated=Path(staging)/destination.name
            with csv_path.open(encoding='utf-8-sig', newline='') as source, updated.open(
                    'w', encoding='utf-8-sig', newline='') as handle:
                reader=csv.DictReader(source)
                writer=csv.DictWriter(handle, reader.fieldnames)
                writer.writeheader()
                for values in reader:
                    titles=changed_titles.get(values['成绩ID'].strip())
                    if titles:
                        values['赛事名称'],values['赛事英文名']=titles
                    writer.writerow(values)
            updated.replace(destination)
    (directory/'catalog.json').write_bytes(encoded(catalog))
    return catalog


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--csv',type=Path,required=True)
    parser.add_argument('--metadata',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    catalog=pack(args.csv,json.loads(args.metadata.read_text(encoding='utf-8')),args.output)
    print(f"Built {len(catalog['meets'])} competitions in {args.output}/assets/data")
