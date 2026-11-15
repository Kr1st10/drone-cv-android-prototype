import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {plan,sample}=createRequire(import.meta.url)('../motion-scenario.js');
const input={width:1280,height:800,workspace:{x:64,y:40,width:1152,height:720},calibration_size_px:48,sync_module_px:6,
  image_width:800,image_height:600,bbox:[200,100,600,500],target_width_px:40,max_speed_px_s:300,acceleration_px_s2:500,laps:1};
const run='12345678', p=plan(input), original=JSON.stringify(input);
assert.equal(p.config.version,'simple-motion-v1');assert.equal(p.config.calibration_ms,2000);assert.equal(p.config.stationary_ms,1500);
assert.equal(p.config.disappearance_ms,1000);assert.equal(p.config.final_blank_ms,1500);assert.equal(p.config.hidden_motion,'continue');
assert.equal(JSON.stringify(input),original,'plan does not modify caller config');
assert.equal(new Set(p.calibration_markers.map(t=>t.id)).size,4);
const area=input.workspace, inside=rect=>rect[0]>=area.x&&rect[1]>=area.y&&rect[2]<=area.x+area.width&&rect[3]<=area.y+area.height;
const overlap=(a,b)=>Math.min(a[2],b[2])>Math.max(a[0],b[0])&&Math.min(a[3],b[3])>Math.max(a[1],b[1]);
const tagRects=p.calibration_markers.map(t=>[t.x,t.y,t.x+t.size,t.y+t.size]);
const back=p.sync_backing, syncRect=[back[0],back[1],back[0]+back[2],back[1]+back[3]];
assert.ok(tagRects.every(inside));assert.ok(inside(syncRect));assert.ok(tagRects.every(r=>!overlap(r,syncRect)));
const {x,y,module_px:m}=p.marker;
assert.ok(syncRect[0]<x-m&&syncRect[1]<y-m&&syncRect[2]>x+11*m&&syncRect[3]>y+9*m,'black backing surrounds white quiet zone');
const phases=new Set();let step=0;
for(let t=0;t<=p.duration_ms+17;t+=17) {
  const s=sample(p,t,step++,run);phases.add(s.phase);assert.equal(s.elapsed_ms,t);assert.equal(s.step_id,step-1);assert.equal(s.run_id,run);
  if(s.visible) {
    assert.ok(inside(s.image_rect_px));assert.ok(inside(s.bbox_screen_px));
    assert.ok([...tagRects,syncRect].every(r=>!overlap(r,s.image_rect_px)),'photo never covers calibration or sync');
    const [l,top,r,b]=s.image_rect_px;assert.ok(Math.abs((r-l)/(b-top)-input.image_width/input.image_height)<1e-9);
    assert.ok(Math.abs(s.bbox_screen_px[2]-s.bbox_screen_px[0]-input.target_width_px)<1e-8);
  } else { assert.equal(s.bbox_screen_px,null);assert.equal(s.image_rect_px,null); }
}
for(const phase of ['calibration','stationary','accelerate','brake','disappearance','blank_after'])assert.ok(phases.has(phase),phase);
assert.equal(sample(p,0,0,run).phase,'calibration');assert.equal(sample(p,1999,1,run).visible,false);
assert.equal(sample(p,2000,2,run).phase,'stationary');assert.equal(sample(p,3499,3,run).visible,true);
const hiddenStart=p.config.disappearance_start_ms, returned=hiddenStart+p.config.disappearance_ms;
assert.equal(sample(p,hiddenStart,4,run).phase,'disappearance');assert.equal(sample(p,returned-.01,5,run).visible,false);
assert.equal(sample(p,returned,6,run).visible,true);
assert.notDeepEqual(sample(p,hiddenStart-.01,7,run).image_rect_px,sample(p,returned,8,run).image_rect_px,'position advances through hidden episode');
assert.ok(p.duration_ms-p.config.final_blank_ms-returned>=3000,'at least three seconds after reappearance');
assert.equal(sample(p,p.duration_ms,9,run).phase,'blank_after');
const shifted=plan({...input,workspace:{...input.workspace,x:input.workspace.x+10}});
for(const key of ['bbox_screen_px','image_rect_px']) {
 const a=sample(p,2500,0,run)[key],b=sample(shifted,2500,0,run)[key];assert.deepEqual(b,a.map((v,i)=>v+(i%2?0:10)));
}
assert.throws(()=>plan({...input,workspace:{...area,x:1280}}));
assert.throws(()=>plan({...input,target_width_px:10000}));
assert.throws(()=>plan({...input,sync_module_px:100}));
const short=plan({...input,max_speed_px_s:100000,acceleration_px_s2:1e8});
assert.ok(short.base.lap_ms<1000);
const Motion=createRequire(import.meta.url)('../motion.js'), returnedAt=short.config.disappearance_start_ms+short.config.disappearance_ms;
const expected=Motion.sampleMotion(short.base,1000+(returnedAt-3500)*short.base.lap_ms/short.config.movement_ms,0,run);
assert.deepEqual(sample(short,returnedAt,1,run).image_rect_px,expected.image_rect_px.map((v,i)=>v+short.offset[i%2]),
  'short routes continue their elapsed route clock through disappearance, including turns');
console.log('simple motion scenario geometry and timeline tests passed');

// Canvas pixels remain physical units; only workspace and CSS controls scale with DPR.
for(const [width,height] of [[1024,768],[1280,800],[1366,768],[1920,1080]])for(const dpr of [1,1.5,2]){
  const w=width*dpr,h=height*dpr;
  const config={...input,width:w,height:h,workspace:{x:w*.05,y:h*.05,width:w*.9,height:h*.9},
    sync_module_px:18,image_width:2400,image_height:1600,bbox:[1306,604,1593,895],control_width_px:80*dpr,control_height_px:32*dpr};
  const p=plan(config);
  assert.equal(p.marker.module_px,18);assert.equal(p.base.marker,null);
  const a=config.workspace,inside=r=>r[0]>=a.x&&r[1]>=a.y&&r[2]<=a.x+a.width&&r[3]<=a.y+a.height;
  const rect=([x,y,w,h])=>[x,y,x+w,y+h];
  const fixed=[rect(p.sync_backing),rect(p.control_rect),...p.calibration_markers.map(t=>rect([t.x,t.y,t.size,t.size]))];
  assert.ok(fixed.every(inside));
  fixed.forEach((r,i)=>assert.ok(fixed.slice(i+1).every(s=>!overlap(r,s))));
  for(let t=0;t<p.duration_ms;t+=17){
    const s=sample(p,t,t,run);if(!s.visible)continue;
    assert.ok(inside(s.image_rect_px));assert.ok(fixed.every(r=>!overlap(r,s.image_rect_px)));
    const [l,top,r,b]=s.image_rect_px;
    assert.ok(Math.abs((r-l)/(b-top)-1.5)<1e-9,'whole photo keeps aspect ratio');
    assert.ok(Math.abs(s.bbox_screen_px[2]-s.bbox_screen_px[0]-40)<1e-9);
    assert.ok(Math.abs(s.bbox_screen_px[0]-(l+1306*p.base.scale))<1e-9);
  }
}
const legacy=Motion.planMotion(input),explicitLegacy=Motion.planMotion(input,{reserveMarker:true});
assert.deepEqual(legacy,explicitLegacy,'existing callers retain their marker and route');
assert.ok(legacy.marker);assert.ok(legacy.legs[0].from[1]>40);
console.log('40/18 default geometry: four resolutions x DPR 1/1.5/2, whole photo, target and control separation passed');
