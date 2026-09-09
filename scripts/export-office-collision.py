"""Create reviewable office collision proxies from existing scene metadata."""
import json, math
from pathlib import Path
root=Path('D:/interiorgs_data/office_01')
s=json.loads((root/'structure.json').read_text())
objects=json.loads((root/'semantic_bridge_all/objects_material_catalog.json').read_text())
boxes=[]
def box(id,label,x,z,hx,hz,y0,y1,yaw=0):
    boxes.append(dict(id=id,label=label,center=[x,z],half=[hx,hz],bottom=y0,top=y1,yaw=yaw))
for i,w in enumerate(s['walls']):
    a,b=w['location']; dx=b[0]-a[0]; dy=b[1]-a[1]; length=math.hypot(dx,dy); ux,uy=dx/length,dy/length
    spans=[(0,length)]
    for h in s['holes']:
        if h['type']!='DOOR': continue
        points=h['profile']; distances=[abs((p[0]-a[0])*uy-(p[1]-a[1])*ux) for p in points]
        if max(distances)>w['thickness']+.03: continue
        ts=[(p[0]-a[0])*ux+(p[1]-a[1])*uy for p in points]; lo,hi=min(ts)-.015,max(ts)+.015
        spans=[seg for l,r in spans for seg in [(l,min(r,lo)),(max(l,hi),r)] if seg[1]-seg[0]>.02]
    for j,(lo,hi) in enumerate(spans):
        t=(lo+hi)/2
        box(f'wall-{i}-{j}','墙体',a[0]+ux*t,-(a[1]+uy*t),(hi-lo)/2,w['thickness']/2,0,w['height'],math.atan2(-uy,ux))
for o in objects:
    lo,hi=o['bbox_min'],o['bbox_max']; id=o['instance_id']; name=o['object_name']
    x,z=(lo[0]+hi[0])/2,-(lo[1]+hi[1])/2; hx,hz=(hi[0]-lo[0])/2,(hi[1]-lo[1])/2
    if name=='Multi person sofa': box('sofa-'+id,'沙发 '+id,x,z,hx,hz,lo[2],hi[2])
    if name=='table' and id in ['65','66','113']:
        box('table-'+id+'-top','桌板 '+id,x,z,hx,hz,hi[2]-.09,hi[2])
        if id=='113': box('table-'+id+'-base','桌子支撑 '+id,x,z,.16,.16,lo[2],hi[2]-.09)
        else:
            for a in [-1,1]:
                for b in [-1,1]: box(f'table-{id}-leg-{a}-{b}','桌腿近似 '+id,x+a*(hx-.16),z+b*(hz-.12),.065,.065,lo[2],hi[2]-.09)
Path('src/services/robot-collision/officeCollision.json').write_text(json.dumps(boxes,ensure_ascii=False,indent=2),encoding='utf-8')
print(len(boxes),'obstacle boxes exported')
