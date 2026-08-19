#!/usr/bin/env python3
import pathlib,sys,datetime,socket,os
d=pathlib.Path(sys.argv[1]); stamp=sys.argv[2]; trial=sys.argv[3]
fields={'trial_id':f'{stamp}_{trial}','date':str(datetime.datetime.now(datetime.timezone.utc).date()),'host_time':datetime.datetime.now(datetime.timezone.utc).isoformat(),'hostname':socket.gethostname(),'robot_model':'Go2','robot_serial':None,'robot_firmware':None,'unitree_ros2_commit':None,'surface':None,'battery_start':None,'battery_end':None,'command_method':'remote_controller_only','command_vx':None,'command_vy':None,'command_yaw':None,'trial_phase':'planned','duration':None,'ros_distro':os.getenv('ROS_DISTRO'),'rmw':os.getenv('RMW_IMPLEMENTATION'),'ros_domain_id':os.getenv('ROS_DOMAIN_ID'),'network_interface':None,'host_ipv4':None,'sport_topic':None,'lowstate_topic':None,'wireless_topic':None,'notes':None}
def val(v): return 'null' if v is None else str(v)
(d/'manifest.yaml').write_text('\n'.join(f'{k}: {val(v)}' for k,v in fields.items())+'\nexternal_video:\n  camera: null\n  filename: null\n  sync_event: null\n')
