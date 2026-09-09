import { Application, BLEND_PREMULTIPLIED, CULLFACE_FRONT, Entity, Layer, SEMANTIC_POSITION, ShaderMaterial } from 'playcanvas'
import type { FirePlaybackService } from '../../../services/fire-playback/firePlaybackService'
import { FireProxyDepth } from './FireProxyDepth'

// Display-only office atmosphere. Never feeds simulation, collision or telemetry.
export class RoomFireAtmosphere {
  private readonly entity: Entity
  private readonly material: ShaderMaterial
  private readonly depth: FireProxyDepth
  private readonly app: Application
  private readonly camera: Entity
  constructor(app: Application, camera: Entity, layer: Layer, depth: FireProxyDepth) {
    this.app = app; this.camera = camera
    this.depth = depth
    this.material = new ShaderMaterial({
      uniqueName: 'Room-fire-display-atmosphere', attributes: { aPosition: SEMANTIC_POSITION },
      vertexGLSL: `attribute vec3 aPosition; uniform mat4 matrix_model; uniform mat4 matrix_viewProjection;
        varying vec3 vWorld; void main(){vec4 w=matrix_model*vec4(aPosition,1.);vWorld=w.xyz;gl_Position=matrix_viewProjection*w;}`,
      fragmentGLSL: `precision highp float;
        varying vec3 vWorld; uniform vec3 view_position; uniform mat4 matrix_view;
        uniform float uTime; uniform float uFarClip; uniform vec2 uViewport;
        uniform sampler2D uDepth; uniform vec3 uSources;
        float hash(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
        float noise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
          return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
          mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
        float plume(vec3 p,vec3 source){float h=p.y-source.y;
          vec2 drift=vec2(sin(h*2.+uTime*.3),cos(h*1.7-uTime*.24))*.12;
          float radius=.24+max(h,0.)*.22;
          return exp(-dot(p.xz-source.xz-drift,p.xz-source.xz-drift)/(radius*radius))*smoothstep(0.,.55,h);}
        void main(){
          vec3 rd=normalize(vWorld-view_position);
          vec3 safe=sign(rd+vec3(1e-8))*max(abs(rd),vec3(1e-6));
          vec3 a=(vec3(1.3,.65,-2.65)-view_position)/safe,b=(vec3(10.,3.35,6.)-view_position)/safe;
          vec3 lo=min(a,b),hi=max(a,b);float start=max(0.,max(lo.x,max(lo.y,lo.z))),end=min(hi.x,min(hi.y,hi.z));
          float depth=dot(texture2D(uDepth,gl_FragCoord.xy/uViewport).rgb,vec3(1.,1./255.,1./65025.))*uFarClip;
          end=min(end,depth/max(-(matrix_view*vec4(rd,0.)).z,1e-5)-.05);
          if(end<=start)discard;
          float stepSize=(end-start)/32.,trans=1.;vec3 color=vec3(0.);
          float build=.3+.7*(1.-exp(-uTime/18.));
          for(int i=0;i<32;i++){
            vec3 p=view_position+rd*(start+(float(i)+.5)*stepSize);
            float n=noise(p*2.2-vec3(.08,uTime*.13,.04));
            float detail=noise(p*5.1-vec3(0.,uTime*.21,0.));
            float pillars=plume(p,vec3(2.92,.85,3.39))*uSources.x+plume(p,vec3(9.35,.65,2.67))*uSources.y+plume(p,vec3(8.61,1.9,-1.9))*uSources.z;
            float spread=exp(-dot(p.xz-vec2(3.,3.4),p.xz-vec2(3.,3.4))/13.)*uSources.x
              +exp(-dot(p.xz-vec2(9.,2.7),p.xz-vec2(9.,2.7))/12.)*uSources.y
              +exp(-dot(p.xz-vec2(8.6,-1.9),p.xz-vec2(8.6,-1.9))/10.)*uSources.z;
            float ceiling=smoothstep(2.25-.2*build,3.1,p.y)*min(spread,1.4)*build;
            float edge=smoothstep(.0,.3,3.35-p.y)*smoothstep(1.3,1.9,p.x)*smoothstep(0.,.4,10.-p.x)
              *smoothstep(-2.65,-2.1,p.z)*smoothstep(0.,.5,6.-p.z);
            float density=(pillars*.28+ceiling*.42)*(.3+.7*n)*(.75+.25*detail)*edge;
            float alpha=1.-exp(-density*stepSize);
            float warmth=min(pillars,1.)*exp(-max(p.y-1.,0.)*1.6)*(.85+.15*sin(uTime*4.3));
            vec3 tint=mix(vec3(.105,.10,.095),vec3(.38,.19,.065),warmth);
            color+=trans*alpha*tint;trans*=1.-alpha;
          }
          gl_FragColor=vec4(color,1.-trans);
        }`,
    })
    this.material.blendType = BLEND_PREMULTIPLIED
    this.material.cull = CULLFACE_FRONT
    this.material.depthTest = false; this.material.depthWrite = false
    this.material.setParameter('uDepth', this.depth.texture)
    this.material.update()
    this.entity = new Entity('Room display smoke', app)
    this.entity.addComponent('render', { type: 'box', material: this.material, layers: [layer.id] })
    this.entity.setPosition(5.65, 2, 1.675); this.entity.setLocalScale(8.7, 2.7, 8.65)
    for (const mesh of this.entity.render!.meshInstances) mesh.drawOrder = 2000
    this.entity.enabled = false; app.root.addChild(this.entity)
  }
  update(service: FirePlaybackService, contextLost: boolean): void {
    const state = service.getState()
    const enabled = !contextLost && service.atmosphereEnabled && state.sceneMode === 'room' && service.quality !== 'off'
      && ['ready', 'playing', 'paused'].includes(state.phase)
    // Hide on missing depth instead of painting smoke through foreground walls.
    this.entity.enabled = enabled && this.depth.active
    if (!this.entity.enabled) return
    const available = (s: FirePlaybackService | undefined) => s && ['ready', 'playing', 'paused'].includes(s.getState().phase) ? 1 : 0
    this.material.setParameter('uSources', [available(service), available(service.getCompanions().get('sofa_high')), available(service.getCompanions().get('curtain_high'))])
    this.material.setParameter('uTime', service.presentationSeconds)
    this.material.setParameter('uViewport', [this.app.graphicsDevice.width, this.app.graphicsDevice.height])
    this.material.setParameter('uFarClip', this.camera.camera!.farClip)
  }
  dispose(): void { this.entity.destroy(); this.material.destroy() }
}
