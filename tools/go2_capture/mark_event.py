#!/usr/bin/env python3
import argparse,csv,datetime,time,pathlib
p=argparse.ArgumentParser(); p.add_argument('event'); p.add_argument('--trial-dir',required=True); p.add_argument('--note',default=''); a=p.parse_args()
d=pathlib.Path(a.trial_dir); d.mkdir(parents=True,exist_ok=True); f=d/'events.csv'; new=not f.exists()
with f.open('a',newline='') as h:
 w=csv.writer(h); new and w.writerow(['host_wall_time','host_monotonic_time','event','note']); w.writerow([datetime.datetime.now(datetime.timezone.utc).isoformat(),f'{time.monotonic():.6f}',a.event,a.note])
print(f'MARK event={a.event} trial={d}')
