#!/usr/bin/env python3
import argparse,json,pathlib,statistics
p=argparse.ArgumentParser(); p.add_argument('trial'); a=p.parse_args(); d=pathlib.Path(a.trial); out={'trial':str(d),'topics':{}}
for f in (d/'bag').glob('*.jsonl'):
 rows=[json.loads(x) for x in f.open()]; s={}
 for key in ('mode','gait_type','battery','body_height','yaw_speed','power_v','power_a'):
  vals=[r[key] for r in rows if key in r and isinstance(r[key],(int,float))]
  if vals: s[key]={'min':min(vals),'max':max(vals),'mean':statistics.fmean(vals),'std':statistics.pstdev(vals)}
 if f.stem=='lowstate':
  s['joints']=[{k:{'min':min(v),'max':max(v),'rms':(statistics.fmean(x*x for x in v)**0.5)} for k,v in {q:[r['motor_state'][i][q] for r in rows] for q in ('q','dq','ddq','tau_est','temperature')}.items()} for i in range(12)]
 out['topics'][f.stem]=s
(d/'analysis').mkdir(exist_ok=True); (d/'analysis'/'summary.json').write_text(json.dumps(out,indent=2)+'\n'); print(json.dumps(out,indent=2))
