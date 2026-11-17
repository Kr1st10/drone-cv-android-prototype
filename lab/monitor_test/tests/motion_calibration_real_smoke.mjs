// Real camera JPEG; all brightness/rotation/erasure/duplicate variants below
// are synthetic. Optional original NDJSON is local input, never a fixture.
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const {chromium}=createRequire(path.join(process.cwd(),'x.js'))('playwright');
const root=path.resolve(process.argv[2]),jpeg=await readFile(path.join(root,'tests/fixtures/xiaomi-corners-480x478.jpg'));
assert.equal(createHash('sha256').update(jpeg).digest('hex'),'d8c41fefd48c5659787b8aec9ce5cf05ad8c1c08cc7e8e7541222d243707631e');
const url='data:image/jpeg;base64,'+jpeg.toString('base64');
const browser=await chromium.launch({executablePath:process.env.CHROMIUM,args:['--allow-file-access-from-files']});
try {
  const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  await page.goto('file://'+path.join(root,'gallery.html'));await page.click('[data-section=motion]');
  const variants=await page.evaluate(async url=>{
    const im=new Image();im.src=url;await im.decode();
    const results=[];
    for(const rotation of [0,1,2,3])for(const lighting of ['original','uniform','gradient']) {
      const c=document.createElement('canvas');c.width=rotation%2?478:480;c.height=rotation%2?480:478;
      const ctx=c.getContext('2d');ctx.translate(c.width/2,c.height/2);ctx.rotate(rotation*Math.PI/2);ctx.drawImage(im,-240,-239);ctx.resetTransform();
      const pixels=ctx.getImageData(0,0,c.width,c.height);
      if(lighting!=='original')for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++) {
        const k=(y*c.width+x)*4,f=lighting==='uniform'?.7:.55+.4*x/c.width;
        for(let ch=0;ch<3;ch++)pixels.data[k+ch]=pixels.data[k+ch]*f;
      }
      results.push({rotation,lighting,width:c.width,height:c.height,result:MotionCalibration.detect(pixels)});
    }
    return results;
  },url);
  // Independent manually bounded interiors, not coordinates supplied to detect().
  const bounds=[[25,197,47,219],[405,200,428,223],[403,401,427,425],[23,396,46,420]];
  for(const v of variants) {
    const r=v.result;assert.deepEqual(r.missing,[],JSON.stringify(v));assert.equal(r.ambiguous,false);
    assert.deepEqual(r.markers.map(m=>m.id).sort(),[0,1,2,3]);assert.equal(r.points.length,4);
    for(const m of r.markers) {
      let [x,y]=m.center;
      for(let i=0;i<v.rotation;i++)[x,y]=[y,(i%2?478:480)-1-x]; // undo clockwise raster rotation
      const [l,t,rr,b]=bounds[m.id];assert.ok(x>l&&x<rr&&y>t&&y<b,JSON.stringify({v:v.lighting,rotation:v.rotation,m,x,y}));
      assert.deepEqual(r.points[m.id],m.center.map((p,k)=>p/(k?v.height:v.width)));
    }
    for(let i=0;i<4;i++) {
      const [a,b,c]=[r.points[i],r.points[(i+1)%4],r.points[(i+2)%4]];
      assert.ok((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])>.1);
    }
  }
  console.log('real Xiaomi JPEG + 11 synthetic lighting/rotation variants: four unique IDs and centers inside tags');
  const original=process.env.CORNER_NDJSON?await readFile(process.env.CORNER_NDJSON,'utf8'):null;
  const journal=original?await page.evaluate(text=>{const p=MotionReport.timelineImporter();text.trim().split('\n').forEach(l=>p.push(JSON.parse(l)));return p.finish(false);},original):{
    schema:'dronecv-motion-android-1',mode:'yolo_lk',complete:true,truncated:false,stop_ns:1e9,geometry:{width:480,height:478},
    calibration_image:{width:480,height:478,data_url:url},frames:[{frame_id:0,capture_ns:1e8,analyzer_ns:1.1e8,marker:{run_id:'12345678',step_id:0}}],publications:[],detections:[]
  };
  assert.equal(journal.calibration_image.data_url,url);
  const run_id=journal.frames.find(f=>f.marker).marker.run_id;
  // This is deliberately a synthetic geometry-only reference. It is not the
  // monitor's original trajectory, so no tracking metric is asserted.
  const reference={schema:'dronecv-motion-run-2',run_id,complete:false,calibration_points:[[0,0],[640,0],[640,480],[0,480]],samples:[]};
  await page.evaluate(()=>{
    const detect=MotionCalibration.detect;MotionCalibration.detect=im=>(window.lastCorners=detect(im));
    const homography=MotionReport.homography;MotionReport.homography=(a,b)=>{window.usedCorners=structuredClone(b);return homography(a,b);};
  });
  await page.setInputFiles('#reportReference',{name:'synthetic-geometry-only.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(reference))});
  await page.waitForFunction(()=>document.querySelector('#reportStatus').textContent.includes('Загружено эталонов'));
  async function imported(data,name='camera.json') {
    await page.setInputFiles('#reportJournals',{name,mimeType:'application/json',buffer:Buffer.from(typeof data==='string'?data:JSON.stringify(data))});
    await page.waitForFunction(()=>!document.querySelector('#reportSelect').disabled&&document.querySelector('#reportSelect').options.length===1);
  }
  await imported(original||journal,original?'original.ndjson':'camera.json');
  assert.match(await page.textContent('#motionCameraStatus'),/4 из 4 найдены/);
  assert.match(await page.textContent('#reportCalibrationStatus'),/Калибровка выполнена/);
  assert.deepEqual(await page.evaluate(()=>usedCorners),variants[0].result.points);
  if(original) {
    const counts=journal.frames.filter(f=>f.marker),first=journal.frames.findIndex(f=>f.marker),last=journal.frames.findLastIndex(f=>f.marker);
    assert.equal(counts.length,286);assert.equal(last-first+1,442);
    console.log('original NDJSON imported through file input: real JPEG points used; sync remains 286/442 in reading interval');
  }
  const negative=await page.evaluate(async url=>{
    const im=new Image();im.src=url;await im.decode();const c=document.createElement('canvas');c.width=480;c.height=478;const ctx=c.getContext('2d');
    ctx.drawImage(im,0,0);ctx.fillStyle='#aaa';ctx.fillRect(399,397,32,32);const missing=c.toDataURL('image/jpeg',.95);
    ctx.drawImage(im,0,0);MotionCalibration.draw(ctx,{id:0,x:200,y:300,size:32});const duplicate=c.toDataURL('image/jpeg',.95);
    return {missing,duplicate};
  },url);
  await imported({...journal,calibration_image:{width:480,height:478,data_url:negative.missing}});
  assert.match(await page.textContent('#motionCameraStatus'),/нижняя правая.*3 из 4/);
  assert.equal(await page.evaluate(()=>lastCorners.points),null);
  await imported({...journal,calibration_image:{width:480,height:478,data_url:negative.duplicate}});
  assert.match(await page.textContent('#motionCameraStatus'),/неоднозначно/);assert.equal(await page.evaluate(()=>lastCorners.ambiguous),true);
  await page.click('#reportReset');assert.match(await page.textContent('#motionCameraStatus'),/Ручная калибровка/);
  for(const [x,y] of [[36,208],[416,211],[415,412],[35,407]]) {
    const box=await page.locator('#reportCanvas').boundingBox();await page.locator('#reportCanvas').click({position:{x:x/480*box.width,y:y/478*box.height}});
  }
  assert.match(await page.textContent('#motionCameraStatus'),/4 из 4 точек/);
  assert.match(await page.textContent('#reportCalibrationStatus'),/Калибровка выполнена/);
  assert.deepEqual(errors,[]);console.log('UI import, geometry handoff, missing, ambiguous and four manual clicks passed');
} finally {await browser.close();}
