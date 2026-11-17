// Synthetic raster tests check geometry/recognition, not phone readability.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url), C=require('../motion-calibration.js');
const width=720,height=520;
function image(){const data=new Uint8ClampedArray(width*height*4);data.fill(255);return {width,height,data};}
function polygon(im,poly,color){
  const xs=poly.map(p=>p[0]),ys=poly.map(p=>p[1]);
  for(let y=Math.max(0,Math.floor(Math.min(...ys)));y<=Math.min(height-1,Math.ceil(Math.max(...ys)));y++)for(let x=Math.max(0,Math.floor(Math.min(...xs)));x<=Math.min(width-1,Math.ceil(Math.max(...xs)));x++) {
    if(poly.every((p,i)=>{const q=poly[(i+1)%4];return (q[0]-p[0])*(y+.5-p[1])-(q[1]-p[1])*(x+.5-p[0])>=-1e-8;})) {
      const k=(y*width+x)*4;im.data[k]=im.data[k+1]=im.data[k+2]=color;
    }
  }
}
function stamp(im,id,q,rotation=0){
  const f=C.project(q),bits=C.cells(id);
  polygon(im,q,0);
  for(let y=1;y<7;y++)for(let x=1;x<7;x++)if(!bits[y][x]){
    let xx=x,yy=y;for(let r=0;r<rotation;r++)[xx,yy]=[7-yy,xx];
    polygon(im,[[xx/8,yy/8],[(xx+1)/8,yy/8],[(xx+1)/8,(yy+1)/8],[xx/8,(yy+1)/8]].map(([u,v])=>f(u,v)),255);
  }
}
const quads=[[[30,30],[140,40],[128,145],[43,130]],[[540,40],[630,30],[648,126],[533,139]],[[540,352],[650,366],[625,475],[554,457]],[[40,357],[112,344],[126,421],[31,439]]];
const im=image();quads.forEach((q,id)=>stamp(im,id,q,id));
const result=C.detect(im);
assert.equal(result.ambiguous,false);assert.deepEqual(result.missing,[]);assert.equal(result.points.length,4);
for(let id=0;id<4;id++) {
  const marker=result.markers.find(m=>m.id===id),q=quads[id];
  // The intersection of diagonals is a projective center, unlike the AABB center.
  const a=q[0],b=q[1],c=q[2],d=q[3],u=[c[0]-a[0],c[1]-a[1]],v=[d[0]-b[0],d[1]-b[1]],ba=[b[0]-a[0],b[1]-a[1]];
  const t=(ba[0]*v[1]-ba[1]*v[0])/(u[0]*v[1]-u[1]*v[0]),expected=[a[0]+t*u[0],a[1]+t*u[1]];
  assert.ok(Math.hypot(marker.center[0]-expected[0],marker.center[1]-expected[1])<2);
  assert.ok(marker.size_px>65&&marker.size_px<120);
}
const missing=image();quads.slice(0,3).forEach((q,id)=>stamp(missing,id,q));assert.deepEqual(C.detect(missing).missing,[3]);assert.equal(C.detect(missing).points,null);
const duplicate=image();quads.forEach((q,id)=>stamp(duplicate,id===3?0:id,q));assert.equal(C.detect(duplicate).ambiguous,true);assert.equal(C.detect(duplicate).points,null);
const wrong=image();quads.forEach((q,id)=>stamp(wrong,id===0?1:id===1?0:id,q));assert.equal(C.detect(wrong).ambiguous,true);
assert.deepEqual(C.detect(image()).missing,[0,1,2,3]);
const small=image();stamp(small,0,[[30,30],[54,30],[54,54],[30,54]]);assert.equal(C.detect(small).markers[0].id,0);
// Grayscale ringing/noise near black and white stays below the binarizer margin.
const noisy={width,height,data:im.data.slice()};
for(let i=0;i<noisy.data.length;i+=4)for(let c=0;c<3;c++)noisy.data[i+c]=noisy.data[i+c] ? 205+(i%48) : 8+(i%48);
assert.equal(C.detect(noisy).points.length,4);
// The separate Android 12x10 sync quiet zone plus backing is not a corner ID.
const sync=image(),bits=require('../motion.js').markerBits('1234abcd',91),m=8,x=300,y=200;
const rect=(left,top,w,h,color)=>polygon(sync,[[left,top],[left+w,top],[left+w,top+h],[left,top+h]],color);
rect(x-2*m,y-2*m,14*m,12*m,0);rect(x-m,y-m,12*m,10*m,255);
bits.forEach((bit,i)=>{if(bit)rect(x+(i%10)*m,y+Math.floor(i/10)*m,m,m,0);});
assert.deepEqual(C.detect(sync).markers,[]);
// Synthetic variants: cell scales down to 3 px before rotation/perspective,
// subpixel rasterization, arbitrary in-plane rotations and a sloping quad.
for(const size of [24,32,48,96])for(const angle of [0,.17,.63,1.57,2.4]) {
  const variant=image(),a=angle,cs=Math.cos(a),sn=Math.sin(a);
  const centers=[[140,130],[550,130],[550,390],[140,390]];
  centers.forEach(([cx,cy],id)=>{
    const q=[[-.5,-.5],[.5,-.5],[.44,.5],[-.48,.46]].map(([x,y])=>[cx+size*(x*cs-y*sn),cy+size*(x*sn+y*cs)]);
    stamp(variant,id,q,id);
  });
  const r=C.detect(variant);
  assert.deepEqual(r.missing,[],`size=${size}, angle=${angle}`);
  assert.equal(r.markers.length,4,'repeated passes must coalesce');assert.equal(r.ambiguous,false);
}
for(const uneven of [false,true]) {
  const variant={width,height,data:im.data.slice()};
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const k=(y*width+x)*4, factor=uneven?.2+.75*x/width:.27;
    const value=variant.data[k]*factor+12;
    variant.data[k]=variant.data[k+1]=variant.data[k+2]=value;
  }
  const r=C.detect(variant);assert.deepEqual(r.missing,[]);assert.equal(r.markers.length,4);assert.equal(r.ambiguous,false);
}
const clipped=image();stamp(clipped,0,[[-8,30],[24,30],[24,62],[-8,62]]);assert.deepEqual(C.detect(clipped).markers,[]);
for(const size of [16,20]) {
  const tiny=image();stamp(tiny,0,[[30,30],[30+size,30],[30+size,30+size],[30,30+size]]);
  assert.deepEqual(C.detect(tiny).markers.map(m=>m.id),[0]);
}
const damaged=image();stamp(damaged,0,[[30,30],[94,30],[94,94],[30,94]]);
// Erase three internal ID cells, beyond the unchanged one-bit allowance.
for(const [x,y] of [[1,1],[3,1],[4,1]])polygon(damaged,[[30+x*8,38],[38+x*8,38],[38+x*8,46],[30+x*8,46]],255);
assert.deepEqual(C.detect(damaged).markers,[]);
// Seeded random contrast patches and non-ID checkerboards.
const random=image();let seed=1729;
for(let y=20;y<480;y+=40)for(let x=20;x<680;x+=40)for(let j=0;j<8;j++)for(let i=0;i<8;i++) {
  seed=(Math.imul(seed,1664525)+1013904223)>>>0;
  if(seed&0x80000000)polygon(random,[[x+i*3,y+j*3],[x+i*3+3,y+j*3],[x+i*3+3,y+j*3+3],[x+i*3,y+j*3+3]],0);
}
assert.deepEqual(C.detect(random).markers,[]);
// Two concentric but physically distinct IDs must not coalesce by center.
const nested=image();stamp(nested,0,[[200,100],[520,100],[520,420],[200,420]]);
polygon(nested,[[348,248],[372,248],[372,272],[348,272]],255);
stamp(nested,0,[[352,252],[368,252],[368,268],[352,268]]);
const nestedResult=C.detect(nested);assert.equal(nestedResult.markers.length,2);assert.equal(nestedResult.ambiguous,true);
const render=[];C.draw({set fillStyle(v){render.push(v);},fillRect(...a){render.push(a);}},{id:2,x:8,y:16,size:80});assert.ok(render.length>30);
assert.throws(()=>C.draw({}, {id:9,x:0,y:0,size:10}));
console.log('motion calibration: perspective, four rotations/sizes, missing/duplicate/order, small tag and renderer passed');
