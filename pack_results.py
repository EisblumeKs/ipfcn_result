"""Build immutable, on-demand assets for the IPFcn rankings using the owner-maintained public CSV."""
import argparse
import csv
import hashlib
import json
import math
import re
import unicodedata
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

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
                 'OVERWEIGHT': 'OVERWEIGHT', '称重超重 / Overweight': 'OVERWEIGHT'}
CHINA = {'chn','china','中国'}
EXCLUDED_NAMES = {
    'bbcac730ccbda6bb34793d2e6fec8cd0b6af2e11508355849fe0533429c176e4',
    '828696096502bde0d51d5e31a7abbae677180271630484a2ae8abc250b629f20',
    'f4a5a28934281ede19fbfccfb65b4ecbba5a95b63c63207f96b24cb1f5e4e80f',
}
MERGED = {('M', '53'): '59', ('F', '43'): '47', ('F', '72'): '76'}
MEET_FIELDS = ('meet_id','meet_name','meet_name_en','year','meet_type','meet_start','meet_end','meet_date','date_precision')
SEARCH_FIELDS = ('record_id','athlete_id','name','name_sort','name_en','gender','year','discipline','total','bench','has_profile')
SCOPE_FIELDS = ('year','meet_type','discipline','gender','weight_class','division')


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
    if len(name)>3 and not name.startswith('欧阳'):
        return ' '.join(word.title() for word in words)
    end = 2 if name.startswith('欧阳') else 1
    return ' '.join(filter(None, [''.join(words[end:]).title(), ''.join(words[:end]).title()]))


def number(value):
    if not value:
        return None
    n = float(value)
    if not math.isfinite(n) or n <= 0:
        raise ValueError('Invalid positive number: '+value)
    return int(n) if n.is_integer() else n


def parse_row(c, metadata):
    name, aid, rid, mid = (c[k] for k in ('姓名','运动员ID','成绩ID','赛事ID'))
    norm=unicodedata.normalize('NFKC',name).strip()
    if not all((name,aid,rid,mid,c['赛事名称'])) or hashlib.sha256(norm.encode()).hexdigest() in EXCLUDED_NAMES:
        raise ValueError('Missing identity, excluded athlete or missing competition')
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
    if not all(re.fullmatch(r'[1-9]\d*(?:\.\d+)?\+?',k) for k in (weight_class,actual)):
        raise ValueError('Invalid weight class')
    weight_class = MERGED.get((gender,actual),actual)
    bw, squat, bench, deadlift, total, gl = [number(c[k]) for k in (
        '体重(kg)','蹲举(kg)','卧推举(kg)','硬举(kg)','总成绩(kg)','IPF GL系数')]
    if event == 'B' and any(x is not None for x in (squat, deadlift, total)):
        raise ValueError('Bench-only record contains lifts or total from powerlifting')
    if status:
        if total is not None or gl is not None or c['级别名次'] or c['各组别名次']:
            raise ValueError(f'{status} must have empty total, GL and placings')
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
    sort=c['拼音或排序名'] or name
    row=dict(record_id=rid,athlete_id=aid,name=name,name_sort=sort,
             name_en=metadata.get('athletes',{}).get(aid) or english_name(name,sort),
             gender=gender,year=year,discipline=event,equipment='Raw',meet_type=meet_type,
             meet_id=mid,meet_name=c['赛事名称'],meet_name_en=c['赛事英文名'] or c['赛事名称'],
             meet_start=start,meet_end=end,meet_date=day or start,age_division=c['报名年龄组'],
             division=division,class_place=place,place_basis=BASIS[c['名次依据']],
             weight_class=weight_class,bodyweight=bw,squat=squat,bench=bench,deadlift=deadlift,total=total,
             gl=gl,rankings_eligible=eligible,
             record_federation=c.get('赛事认证机构',metadata.get('recordFederations',{}).get(mid,'')))
    if status:
        row['status'] = status
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
    raw_aliases=[*c['其他姓名'].split(' / '), *metadata.get('aliases',{}).get(gender+'/'+aid,[])]
    row['alternate_names']=list(dict.fromkeys(x for x in raw_aliases if x))
    return row


def load_rows(csv_path,metadata):
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
            except (ValueError,KeyError) as exc:
                raise ValueError(f'CSV row {data.line_num}: {exc}') from exc
    if not rows:
        raise ValueError('No competition results')
    return rows


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
    rows=load_rows(csv_path,metadata)
    countries=metadata.get('athleteCountries',{})
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
        available=any((r.get('team','').lower() in CHINA if r['meet_type']=='international' else
                       (country.lower() in CHINA if country else r['rankings_eligible'])) for r in group)
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
        classes=sorted({r['weight_class'] for r in group},key=lambda c:(float(c.rstrip('+')),c.endswith('+')))
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
    for d in DISCIPLINES:
        preview=gl_preview(ranking[d])
        previews[d]=asset('preview',preview)
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
    catalog={'meets':meets,'assets':assets,'rankingCounts':counts_by_year,'previewYears':preview_years,
             'previousAthleteIds':metadata.get('previousAthleteIds',{}),
             'recordFederations':{mid:next(iter(events.values()))[0]['record_federation']
                                  for mid,events in competitions.items()}}
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
