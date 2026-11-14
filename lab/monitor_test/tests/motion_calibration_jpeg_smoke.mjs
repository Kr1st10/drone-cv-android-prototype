// Browser JPEG round-trip is synthetic, not an optical camera test.
import {createRequire} from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';
const {chromium}=createRequire(path.join(process.cwd(),'x.js'))('playwright');
const browser=await chromium.launch({executablePath:process.env.CHROMIUM,args:['--allow-file-access-from-files']});
try {
  const page=await browser.newPage();
  await page.goto('about:blank');
  await page.addScriptTag({path:path.resolve(process.argv[2], 'motion-calibration.js')});
  const output=await page.evaluate(async()=>{
    const c=document.createElement('canvas');c.width=640;c.height=480;const ctx=c.getContext('2d');
    ctx.fillStyle='#fff';ctx.fillRect(0,0,c.width,c.height);
    [[0,30,30,32],[1,520,30,64],[2,520,350,80],[3,30,350,48]].forEach(([id,x,y,size])=>MotionCalibration.draw(ctx,{id,x,y,size}));
    const img=new Image();img.src=c.toDataURL('image/jpeg',.6);await img.decode();ctx.clearRect(0,0,c.width,c.height);ctx.drawImage(img,0,0);
    return MotionCalibration.detect(ctx.getImageData(0,0,c.width,c.height));
  });
  assert.deepEqual(output.missing,[]);assert.equal(output.ambiguous,false);assert.equal(output.points.length,4);
  assert.deepEqual(output.markers.map(m=>m.id).sort(),[0,1,2,3]);
  console.log('calibration browser JPEG round-trip (quality .6, 32/48/64/80 px tags): passed');
} finally {await browser.close();}
