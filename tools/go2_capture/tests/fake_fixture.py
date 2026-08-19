#!/usr/bin/env python3
import argparse,json,math,pathlib,time
p=argparse.ArgumentParser(); p.add_argument('--trial-dir',required=True); p.add_argument('--seconds',type=int,default=30); a=p.parse_args(); d=pathlib.Path(a.trial_dir)
names={'/sportmodestate':'sportmodestate.jsonl','/lowstate':'lowstate.jsonl','/wirelesscontroller':'wirelesscontroller.jsonl'}; d.joinpath('bag').mkdir(parents=True,exist_ok=True); fs={k:(d/'bag'/v).open('w') for k,v in names.items()}; start=time.time(); n=0
while time.time()-start<a.seconds:
 ts=time.time(); q=[0.1*math.sin(n/10+i) for i in range(12)]; low={'timestamp':ts,'tick':n,'motor_state':[{'q':x,'dq':0.0,'ddq':0.0,'tau_est':0.0,'temperature':35.0} for x in q],'imu':{'rpy':[0.0,0.0,0.0]},'foot_force':[20.0]*4,'foot_force_est':[20.0]*4,'power_v':24.0,'power_a':1.0,'battery':90.0}; sport={'timestamp':ts,'mode':1,'gait_type':1,'foot_raise_height':0.08,'position':[0,0,0.3],'velocity':[0,0,0],'body_height':0.3,'yaw_speed':0,'imu':low['imu'],'foot_force':low['foot_force'],'foot_position_body':[0.0]*12,'foot_speed_body':[0.0]*12}; wireless={'timestamp':ts,'lx':0,'ly':0,'rx':0,'ry':0,'keys':0}
 for k,v in [('/lowstate',low),('/sportmodestate',sport),('/wirelesscontroller',wireless)]: fs[k].write(json.dumps(v)+'\n'); fs[k].flush()
 n+=1; time.sleep(0.02)
for f in fs.values(): f.close()
(d/'topics.txt').write_text('/sportmodestate\n/lowstate\n/wirelesscontroller\n'); print(f'LOCAL_TEST_ONLY messages={n}')
(d/'topic_rates.txt').write_text('LOCAL_TEST_ONLY\n/sportmodestate effective_hz=49.38\n/lowstate effective_hz=49.38\n/wirelesscontroller effective_hz=49.38\n')
