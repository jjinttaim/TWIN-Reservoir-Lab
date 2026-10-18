import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { channelNetwork, sampleChannel, channelWaterGeometry, createChannelTerrain } from '../src/channel-terrain.mjs';

const manifest={river:{points:[[10,6.6,0],[10,6,30],[6,5,60],[5,3,110]],width:16},channels:[
  {kind:'spill',points:[[10,30.34,-50],[10,7.34,0]],bedPoints:[[10,30,-50],[10,7,0]],bedOffsetM:-.34,width:12},
  {kind:'turbine',points:[[-40,8,40],[-15,6,55],[6,5,60]],width:8},
]};
test('pre-confluence reach uses spill only and receiving reach uses total release',()=>{
  const [before,after]=channelNetwork(manifest);
  assert.equal(before.kind,'spill');assert.equal(after.kind,'release');
  assert.deepEqual(before.points.at(-1),after.points[0]);
  assert.deepEqual(before.points[0],[10,7,0]);
  assert.deepEqual(manifest.river.points[0],[10,6.6,0],'source coordinates remain unchanged');
});
test('metric UV increases downstream and tangent basis follows each bend',()=>{
  const path=sampleChannel(manifest.channels[1].points,8,32);
  const g=channelWaterGeometry(path,6),uv=g.attributes.uv,pos=g.attributes.position,tangent=g.attributes.aFlowTangent;
  assert.ok(path.length>46);
  for(let i=0;i<path.samples.length;i++){
    assert.ok(Number.isFinite(path.samples[i].halfWidth));
    assert.ok(Math.abs(path.samples[i].side.dot(path.samples[i].tangent))<1e-10);
    if(i)assert.ok(uv.getY(i*7)>uv.getY((i-1)*7));
  }
  for(const array of [pos.array,tangent.array,uv.array])assert.ok([...array].every(Number.isFinite));
  assert.ok(Math.abs(uv.getY(uv.count-1)-path.length)<1e-4);
});
test('water geometry keeps exact nominal widths and elevations at both joins',()=>{
  const path=sampleChannel(manifest.channels[1].points,8,20),g=channelWaterGeometry(path,4),p=g.attributes.position;
  const at=i=>[p.getX(i),p.getY(i),p.getZ(i)];
  for(const row of [0,20]){
    const l=at(row*5),r=at(row*5+4),centre=path.samples[row].point;
    assert.ok(Math.abs(Math.hypot(r[0]-l[0],r[2]-l[2])-8)<1e-5);
    assert.ok(Math.abs((l[1]+r[1])*.5-centre.y-.025)<1e-5);
  }
});
test('banks close the valley gap and do not emit invalid triangles',()=>{
  const paths=channelNetwork(manifest).map(d=>sampleChannel(d.points,d.width,24));
  paths.push(sampleChannel(manifest.channels[1].points,8,24));
  const group=createChannelTerrain(paths);
  assert.equal(group.children.length,7);
  for(const mesh of group.children){
    const p=mesh.geometry.attributes.position;
    assert.ok([...p.array].every(Number.isFinite));
    assert.ok([...mesh.geometry.index.array].every(i=>i<p.count));
  }
  const ys=Array.from(group.children[0].geometry.attributes.position.array).filter((_,i)=>i%3===1);
  assert.ok(Math.min(...ys)<0,'bank skirt reaches placeholder valley ground');
  assert.ok(Math.max(...ys)>7,'bank rises above representative water depth');
});


test('bank cross section covers water edge up to the 3 m presentation depth cap',()=>{
  const path=sampleChannel([[0,7,0],[0,2,100]],68,20,'linear');
  const bank=createChannelTerrain([path]).children[0].geometry.attributes.position;
  for(let row=0;row<path.samples.length;row++) {
    const edgeX=-path.samples[row].halfWidth,bedY=path.samples[row].point.y;
    let edgeHeight=null;
    for(let j=0;j<4;j++) {
      const a=row*5+j,b=a+1,ax=bank.getX(a),bx=bank.getX(b);
      if(edgeX>=Math.min(ax,bx)&&edgeX<=Math.max(ax,bx)) {
        const f=(edgeX-ax)/(bx-ax);edgeHeight=bank.getY(a)+(bank.getY(b)-bank.getY(a))*f;
      }
    }
    assert.ok(edgeHeight!==null,'bank crosses the fixed water outline');
    assert.ok(edgeHeight>=bedY+3.025,'bank covers maximum visible water surface');
  }
});


test('continuous valley apron supports a broad corridor while leaving the bed open',()=>{
  const path=sampleChannel([[0,5,0],[0,5,120]],30,30,'linear');
  const apron=createChannelTerrain([path]).getObjectByName('Continuous_Channel_Valley');
  assert.ok(apron);
  const p=apron.geometry.attributes.position,near=(x,z)=>{
    let d=Infinity,height=NaN;
    for(let i=0;i<p.count;i++){const e=Math.hypot(p.getX(i)-x,p.getZ(i)-z);if(e<d){d=e;height=p.getY(i);}}
    return height;
  };
  assert.ok(near(0,60)<5,'centre stays below the water bed');
  assert.ok(near(45,60)>3,'valley supports more than a narrow levee');
  assert.ok(near(120,60)<.1,'apron blends back into original ground');
});

test('collector width follows control points and stays exact at outlet and confluence',()=>{
  const points=[[-153,8,379],[-153,7,401],[-90,7,410],[20,6,440],[270,5,465]];
  const widths=[100,92,30,30,30],path=sampleChannel(points,30,80,'linear',false,widths);
  const g=channelWaterGeometry(path,8),p=g.attributes.position;
  for(let i=0;i<points.length;i++) {
    const row=path.samples.findIndex(s=>s.point.distanceTo(new THREE.Vector3(...points[i]))<1e-7);
    assert.ok(row>=0,'linear control points are retained as section rows');
    const left=row*9,right=left+8;
    assert.ok(Math.abs(Math.hypot(p.getX(left)-p.getX(right),p.getZ(left)-p.getZ(right))-widths[i])<1e-4);
  }
  assert.ok(Math.abs(path.samples[0].side.x)>0.99,'collector spans the three outlet openings across x');
  assert.equal(path.width,30,'hydraulic nominal width is not replaced by collector width');
});

test('splitting a variable-width river preserves widths on both sides of the confluence',()=>{
  const source={...manifest,river:{...manifest.river,widths:[20,18,16,12]}};
  const [before,after]=channelNetwork(source);
  assert.deepEqual(before.widths,[20,18,16]);assert.deepEqual(after.widths,[16,12]);
  assert.deepEqual(source.river.widths,[20,18,16,12]);
});

function surfaceHeight(mesh,x,z) {
  mesh.updateMatrixWorld(true);
  const ray=new THREE.Raycaster(new THREE.Vector3(x,100,z),new THREE.Vector3(0,-1,0));
  return ray.intersectObject(mesh,false)[0]?.point.y;
}

test('confluence retains partial dry bank wedges while clearing the actual water opening',()=>{
  const main=sampleChannel([[-20,2,0],[20,2,0]],10,4,'linear',false);
  const joining=sampleChannel([[0,2,-20],[0,2,20]],12,4,'linear',false);
  const group=createChannelTerrain([main,joining]),bank=group.getObjectByName('Channel_Banks_0');
  assert.ok(surfaceHeight(bank,8,5)>5,'dry part of a partly intersected bank quad is retained');
  assert.equal(surfaceHeight(bank,2,5),undefined,'no bank closes the other channel opening');
  const p=bank.geometry.attributes.position,indices=bank.geometry.index.array;
  for(let i=0;i<indices.length;i+=3) {
    const ids=[indices[i],indices[i+1],indices[i+2]];
    const x=ids.reduce((sum,k)=>sum+p.getX(k),0)/3,z=ids.reduce((sum,k)=>sum+p.getZ(k),0)/3;
    assert.ok(!(Math.abs(x)<6-1e-5&&Math.abs(z)<20-1e-5),'no emitted bank triangle lies inside the crossing stream');
  }
  const valley=group.getObjectByName('Continuous_Channel_Valley');
  for(const [x,z] of [[0,0],[2,5],[-5,0],[5,5]]) {
    const height=surfaceHeight(valley,x,z);
    assert.ok(Number.isFinite(height),'continuous ground remains below the clipped bank opening');
    assert.ok(height<2,'underlying terrain does not become a bar across the channel');
  }
});
