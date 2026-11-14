(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MotionCalibration = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const GRID = 8, NAMES = ['верхняя левая', 'верхняя правая', 'нижняя правая', 'нижняя левая'];
  // A black border encloses 36 ID bits. There is no white enclosing quiet zone
  // or Android sync payload; these tags are decoded only from the saved JPEG.
  const WORDS = ['101101010001100110111000011010010101', '010011101100001010100111110001101010', '110010001011111000010101100101011100', '001110110100010111101001001100101011'];
  function cells(id) {
    if (!Number.isInteger(id) || id < 0 || id > 3) throw Error('Unknown calibration ID');
    return Array.from({length:GRID}, (_, y) => Array.from({length:GRID}, (_, x) => x === 0 || y === 0 || x === 7 || y === 7 ? 1 : Number(WORDS[id][(y - 1) * 6 + x - 1])));
  }
  function draw(ctx, {id, x, y, size}) {
    const bits = cells(id);
    if (![x,y,size].every(Number.isFinite) || size <= 0) throw Error('Invalid marker geometry');
    ctx.fillStyle = '#fff'; ctx.fillRect(x,y,size,size);
    ctx.fillStyle = '#000';
    bits.forEach((row, j) => row.forEach((bit, i) => {if (bit) ctx.fillRect(x+i*size/GRID,y+j*size/GRID,size/GRID,size/GRID);}));
  }
  const cross = (a,b,c) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  function hull(points) {
    points.sort((a,b)=>a[0]-b[0] || a[1]-b[1]);
    const half = list => {const out=[];for(const p of list) {while(out.length>1 && cross(out.at(-2),out.at(-1),p)<=0)out.pop();out.push(p);}return out;};
    const a=half(points),b=half(points.slice().reverse());a.pop();b.pop();return a.concat(b);
  }
  function quadrilateral(points) {
    const q=hull(points);
    while(q.length>4) {
      let index=0,minimum=Infinity;
      for(let i=0;i<q.length;i++) {const area=Math.abs(cross(q[(i+q.length-1)%q.length],q[i],q[(i+1)%q.length]));if(area<minimum){minimum=area;index=i;}}
      q.splice(index,1);
    }
    if(q.length!==4 || q.some((p,i)=>cross(p,q[(i+1)%4],q[(i+2)%4])<16))return null;
    let first=0;for(let i=1;i<4;i++)if(q[i][0]+q[i][1]<q[first][0]+q[first][1])first=i;
    const ordered=q.slice(first).concat(q.slice(0,first));
    // Fit the four outer edges away from rasterized corners, then intersect.
    // Removing hull vertices alone biases a corner along its pixel staircase.
    const lines=ordered.map((a,i)=>{
      const b=ordered[(i+1)%4],dx=b[0]-a[0],dy=b[1]-a[1],len=Math.hypot(dx,dy);
      const near=points.filter(p=>{const t=((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(len*len);return t>.12&&t<.88&&Math.abs(cross(a,b,p))/len<3;});
      if(near.length<4)return {a,b};
      const x=near.reduce((s,p)=>s+p[0],0)/near.length,y=near.reduce((s,p)=>s+p[1],0)/near.length;
      let xx=0,xy=0,yy=0;for(const p of near){xx+=(p[0]-x)**2;xy+=(p[0]-x)*(p[1]-y);yy+=(p[1]-y)**2;}
      const angle=.5*Math.atan2(2*xy,xx-yy);
      return {a:[x,y],b:[x+Math.cos(angle),y+Math.sin(angle)]};
    });
    return lines.map((line,i)=>{
      const previous=lines[(i+3)%4],a=previous.a,b=previous.b,c=line.a,d=line.b;
      const ux=b[0]-a[0],uy=b[1]-a[1],vx=d[0]-c[0],vy=d[1]-c[1],den=ux*vy-uy*vx;
      if(Math.abs(den)<1e-6)return ordered[i];
      const t=((c[0]-a[0])*vy-(c[1]-a[1])*vx)/den;
      return [a[0]+t*ux,a[1]+t*uy];
    });
  }
  function project(quad) {
    const [a,b,c,d]=quad, dx1=b[0]-c[0],dx2=d[0]-c[0],dx3=a[0]-b[0]+c[0]-d[0],dy1=b[1]-c[1],dy2=d[1]-c[1],dy3=a[1]-b[1]+c[1]-d[1];
    const det=dx1*dy2-dx2*dy1;if(Math.abs(det)<1e-9)throw Error('Degenerate marker');
    const g=(dx3*dy2-dx2*dy3)/det,h=(dx1*dy3-dx3*dy1)/det;
    return (u,v)=>{const den=g*u+h*v+1;if(Math.abs(den)<1e-9)throw Error('Degenerate marker');return [((b[0]-a[0]+g*b[0])*u+(d[0]-a[0]+h*d[0])*v+a[0])/den,((b[1]-a[1]+g*b[1])*u+(d[1]-a[1]+h*d[1])*v+a[1])/den];};
  }
  function detect({width,height,data}) {
    if (!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width*height>16777216||data?.length!==width*height*4)throw Error('Invalid calibration image');
    const count=width*height, mask=new Uint8Array(count), queue=new Int32Array(count), markers=[];
    for(let p=0;p<count;p++){const i=p*4;mask[p]=(77*data[i]+150*data[i+1]+29*data[i+2])/256<128 ? 1:0;}
    const black=(x,y)=>x>=0&&y>=0&&x<width&&y<height&&mask[y*width+x]!==0;
    const sample=(p)=>black(Math.round(p[0]),Math.round(p[1])) ? 1:0;
    for(let start=0;start<count;start++) {
      if(mask[start]!==1)continue;
      let head=0,tail=1,minX=width,minY=height,maxX=0,maxY=0;const boundary=[];
      queue[0]=start;mask[start]=2;
      while(head<tail) {
        const p=queue[head++],x=p%width,y=Math.floor(p/width);let edge=false;
        minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
        for(const n of [x>0?p-1:-1,x+1<width?p+1:-1,y>0?p-width:-1,y+1<height?p+width:-1]) {
          if(n<0 || mask[n]===0)edge=true;
          else if(mask[n]===1){mask[n]=2;queue[tail++]=n;}
        }
        if(edge && boundary.length<=20000)boundary.push([x,y]);
      }
      const w=maxX-minX+1,h=maxY-minY+1;
      if(w<16||h<16||w>width*.8||h>height*.8||tail<.15*w*h||boundary.length>20000)continue;
      const quad=quadrilateral(boundary);if(!quad)continue;
      const map=project(quad), grid=Array.from({length:8},(_,y)=>Array.from({length:8},(_,x)=>sample(map((x+.5)/8,(y+.5)/8))));
      if(grid.some((row,y)=>row.some((bit,x)=>(x===0||y===0||x===7||y===7)&&!bit)))continue;
      const matches=[];
      for(let id=0;id<4;id++)for(let rot=0;rot<4;rot++) {
        let errors=0;
        for(let y=0;y<6;y++)for(let x=0;x<6;x++) {
          let xx=x+1,yy=y+1;for(let r=0;r<rot;r++)[xx,yy]=[7-yy,xx];
          if(grid[yy][xx]!==Number(WORDS[id][y*6+x]))errors++;
        }
        if(errors<=1)matches.push(id);
      }
      if(matches.length!==1)continue;
      const center=map(.5,.5), size_px=quad.reduce((sum,p,i)=>sum+Math.hypot(p[0]-quad[(i+1)%4][0],p[1]-quad[(i+1)%4][1]),0)/4;
      markers.push({id:matches[0],corners:quad,center,size_px});
    }
    const missing=[0,1,2,3].filter(id=>!markers.some(m=>m.id===id));
    let ambiguous=markers.some((m,i)=>markers.findIndex(n=>n.id===m.id)!==i), points=null;
    if(!missing.length && !ambiguous) {
      const sorted=[0,1,2,3].map(id=>markers.find(m=>m.id===id).center);
      if(sorted.some((p,i)=>cross(p,sorted[(i+1)%4],sorted[(i+2)%4])<16))ambiguous=true;
      else points=sorted.map(([x,y])=>[x/width,y/height]);
    }
    return {markers,missing,ambiguous,points};
  }
  return {draw,detect,cells,project,NAMES,format:'dronecv-corner-8x8-v1'};
});
