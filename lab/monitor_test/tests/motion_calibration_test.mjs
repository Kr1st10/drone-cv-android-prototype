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
const render=[];C.draw({set fillStyle(v){render.push(v);},fillRect(...a){render.push(a);}},{id:2,x:8,y:16,size:80});assert.ok(render.length>30);
assert.throws(()=>C.draw({}, {id:9,x:0,y:0,size:10}));
console.log('motion calibration: perspective, four rotations/sizes, missing/duplicate/order, small tag and renderer passed');
