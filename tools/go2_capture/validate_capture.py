#!/usr/bin/env python3
import argparse,json,pathlib,math,statistics
p=argparse.ArgumentParser(); p.add_argument('trial'); a=p.parse_args(); d=pathlib.Path(a.trial); bag=d/'bag'; result={'trial':str(d),'topics':{},'errors':[]}
for f in sorted(bag.glob('*.jsonl')):
 rows=[]
 for line in f.open():
  try: rows.append(json.loads(line))
  except Exception as e: result['errors'].append(f'{f.name}: malformed JSON: {e}')
 ts=[r.get('timestamp') for r in rows]; gaps=[b-x for x,b in zip(ts,ts[1:]) if isinstance(x,(int,float)) and isinstance(b,(int,float))]
 bad=[r for r in rows if any(isinstance(v,float) and (math.isnan(v) or math.isinf(v)) for v in r.values() if isinstance(v,float))]
 result['topics'][f.stem]={'message_count':len(rows),'duration_s':(ts[-1]-ts[0]) if len(ts)>1 else 0,'effective_hz':(len(rows)-1)/(ts[-1]-ts[0]) if len(ts)>1 and ts[-1]>ts[0] else 0,'max_gap_s':max(gaps,default=0),'duplicate_timestamps':len(ts)-len(set(ts)),'nan_inf':len(bad),'monotonic':all(b>=x for x,b in zip(ts,ts[1:])),'joint_count':len(rows[0].get('motor_state',[])) if rows and 'motor_state' in rows[0] else None,'foot_count':len(rows[0].get('foot_force',[])) if rows and 'foot_force' in rows[0] else None}
 if bad: result['errors'].append(f'{f.name}: NaN/Inf')
print(json.dumps(result,indent=2)); out=d/'processed'/'validation.json'; out.parent.mkdir(exist_ok=True); out.write_text(json.dumps(result,indent=2)+'\n'); raise SystemExit(1 if result['errors'] else 0)
