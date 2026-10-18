import * as THREE from 'three';

/** Presentation geometry only: these banks close the placeholder valley surface.
 * Widths are nominal; no surveyed cross section or erosion solver is implied. */
const noise = (x, salt=0) => (Math.sin(x*.079+salt)*.52+Math.sin(x*.173+salt*2.3)*.28+Math.sin(x*.031+salt*.7)*.20);
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));

export function channelNetwork(manifest) {
  const river=manifest.river, points=river.points.map(p=>p.slice());
  const turbine=manifest.channels.find(c=>c.kind==='turbine');
  const spill=manifest.channels.find(c=>c.kind==='spill');
  if(!turbine || points.length<3) return [{...river,kind:'release',id:'downstream'}];
  const mouth=turbine.points.at(-1);
  let junction=1,best=Infinity;
  for(let i=1;i<points.length-1;i++) {
    const d=Math.hypot(points[i][0]-mouth[0],points[i][2]-mouth[2]);
    if(d<best){best=d;junction=i;}
  }
  // Each reach carries only water that has actually entered it.
  const upstream=points.slice(0,junction+1), downstream=points.slice(junction);
  if(spill) {
    const end=(spill.bedPoints||spill.points).at(-1);
    if(Math.hypot(upstream[0][0]-end[0],upstream[0][2]-end[2])<river.width) upstream[0][1]=end[1]+(spill.bedPoints?0:(spill.bedOffsetM||0));
  }
  return [{...river,points:upstream,widths:river.widths?.slice(0,junction+1),kind:'spill',id:'spill-reach'}, {...river,points:downstream,widths:river.widths?.slice(junction),kind:'release',id:'downstream'}];
}

export function sampleChannel(points,width,segments=160,interpolation='smooth',natural=true,widths=null) {
  const vertices=points.map(p=>new THREE.Vector3(...p)),linear=interpolation==='linear';
  const curve=linear?new THREE.CurvePath():new THREE.CatmullRomCurve3(vertices,false,'centripetal');
  if(linear)for(let i=1;i<vertices.length;i++)curve.add(new THREE.LineCurve3(vertices[i-1],vertices[i]));
  const length=curve.getLength(), times=Array.from({length:segments+1},(_,i)=>i/segments);
  if(linear){let s=0;for(let i=1;i<vertices.length-1;i++){s+=vertices[i].distanceTo(vertices[i-1]);times.push(s/length);}}
  const variableWidths=Array.isArray(widths)&&widths.length===points.length&&widths.every(w=>Number.isFinite(w)&&w>0)?widths:null;
  const controlDistances=[0];
  if(linear)for(let i=1;i<vertices.length;i++)controlDistances.push(controlDistances.at(-1)+vertices[i].distanceTo(vertices[i-1]));
  // Catmull-Rom interpolates control points at equally spaced curve parameters.
  // The sampled arc-length parameter must be converted back before reading widths.
  const widthAt=t=>{
    if(!variableWidths)return width;
    let knot;
    if(linear){
      const distance=t*length;let i=0;
      while(i<controlDistances.length-2&&distance>controlDistances[i+1])i++;
      knot=i+clamp((distance-controlDistances[i])/(controlDistances[i+1]-controlDistances[i]||1),0,1);
    }else knot=curve.getUtoTmapping(t)*(vertices.length-1);
    const i=Math.min(vertices.length-2,Math.floor(knot)),f=knot-i;
    return THREE.MathUtils.lerp(variableWidths[i],variableWidths[i+1],f);
  };
  const sorted=[...new Set(times)].sort((a,b)=>a-b);
  const samples=sorted.map(t=>{
    const point=linear?curve.getPoint(t):curve.getPointAt(t), tangent=linear?curve.getTangent(t):curve.getTangentAt(t);
    const side=new THREE.Vector3(tangent.z,0,-tangent.x).normalize();
    // Keep meeting points exact; small bank irregularity fades at both ends.
    const fade=Math.sin(Math.PI*t)**.5,halfWidth=widthAt(t)*.5*(1+(natural ? .034*noise(t*length,2)*fade : 0));
    return {point,tangent,side,t,distance:t*length,halfWidth};
  });
  return {samples,curve,length,width,widths:variableWidths?.slice()||null};
}

export function channelWaterGeometry(path,crossSegments=12) {
  const positions=[],uv=[],tangents=[],indices=[];
  for(let i=0;i<path.samples.length;i++) {
    const s=path.samples[i];
    for(let j=0;j<=crossSegments;j++) {
      const u=j/crossSegments,lateral=(u-.5)*s.halfWidth*2;
      positions.push(s.point.x+s.side.x*lateral,s.point.y+.025,s.point.z+s.side.z*lateral);
      uv.push(u,s.distance); tangents.push(s.tangent.x,s.tangent.y,s.tangent.z);
      if(i<path.samples.length-1&&j<crossSegments){const k=i*(crossSegments+1)+j,n=k+crossSegments+1;indices.push(k,n,k+1,k+1,n,n+1);}
    }
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
  geometry.setAttribute('aFlowTangent',new THREE.Float32BufferAttribute(tangents,3));
  geometry.setIndex(indices);geometry.computeVertexNormals();return geometry;
}

function geometry(positions,colors,uv,indices) {
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  g.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
  g.setIndex(indices);g.computeVertexNormals();return g;
}
// Subtract convex wetted triangles from bank polygons instead of dropping a
// complete bank quad when just one corner touches another stream. New vertices
// lie exactly on the water boundary, so confluences keep their dry bank wedges.
const cross2=(a,b,p)=>(b.x-a.x)*(p.z-a.z)-(b.z-a.z)*(p.x-a.x);
const mixVertex=(a,b,t)=>({x:THREE.MathUtils.lerp(a.x,b.x,t),y:THREE.MathUtils.lerp(a.y,b.y,t),z:THREE.MathUtils.lerp(a.z,b.z,t),color:a.color.map((v,i)=>THREE.MathUtils.lerp(v,b.color[i],t)),uv:a.uv.map((v,i)=>THREE.MathUtils.lerp(v,b.uv[i],t))});
function splitPolygon(polygon,a,b,orientation) {
  const inside=[],outside=[];
  for(let i=0;i<polygon.length;i++) {
    const p=polygon[i],q=polygon[(i+1)%polygon.length],dp=cross2(a,b,p)*orientation,dq=cross2(a,b,q)*orientation;
    if(dp>=-1e-8)inside.push(p);
    if(dp<=1e-8)outside.push(p);
    if((dp>1e-8&&dq<-1e-8)||(dp<-1e-8&&dq>1e-8)) {
      const hit=mixVertex(p,q,dp/(dp-dq));inside.push(hit);outside.push(hit);
    }
  }
  return {inside,outside};
}
function subtractTriangle(polygon,triangle) {
  const orientation=Math.sign(cross2(triangle[0],triangle[1],triangle[2]));
  if(!orientation)return [polygon];
  let remaining=polygon;const kept=[];
  for(let i=0;i<3&&remaining.length>=3;i++) {
    const {inside,outside}=splitPolygon(remaining,triangle[i],triangle[(i+1)%3],orientation);
    if(outside.length>=3)kept.push(outside);
    remaining=inside;
  }
  return kept;
}
function wetTriangles(path) {
  const edge=(s,sign)=>({x:s.point.x+sign*s.side.x*s.halfWidth,z:s.point.z+sign*s.side.z*s.halfWidth});
  const triangles=[];
  for(let i=1;i<path.samples.length;i++) {
    const a=edge(path.samples[i-1],-1),b=edge(path.samples[i-1],1),c=edge(path.samples[i],-1),d=edge(path.samples[i],1);
    for(const vertices of [[a,c,b],[b,c,d]])triangles.push({vertices,minX:Math.min(...vertices.map(v=>v.x)),maxX:Math.max(...vertices.map(v=>v.x)),minZ:Math.min(...vertices.map(v=>v.z)),maxZ:Math.max(...vertices.map(v=>v.z))});
  }
  return triangles;
}

export function createChannelTerrain(paths) {
  const group=new THREE.Group();group.name='Presentation_Channel_Banks';
  const size=128,pixels=new Uint8Array(size*size*4);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++) {
    const h=Math.sin(x*127.1+y*311.7)*43758.5453,v=105+Math.floor((h-Math.floor(h))*108),i=(y*size+x)*4;
    pixels[i]=v;pixels[i+1]=v;pixels[i+2]=v;pixels[i+3]=255;
  }
  const grit=new THREE.DataTexture(pixels,size,size);grit.wrapS=grit.wrapT=THREE.RepeatWrapping;grit.needsUpdate=true;
  const material=new THREE.MeshStandardMaterial({color:'#e9e3d5',vertexColors:true,roughness:1,bumpMap:grit,bumpScale:.19,side:THREE.DoubleSide});
  const wetted=paths.map(path=>({path,triangles:wetTriangles(path)}));
  for(const path of paths) {
    const otherTriangles=wetted.filter(entry=>entry.path!==path).flatMap(entry=>entry.triangles);
    const positions=[],colors=[],uv=[],indices=[];
    const offsets=[-.17,-.075,-.012,.19,.48];
    for(let sign of [-1,1]) {
      const base=positions.length/3;
      for(let i=0;i<path.samples.length;i++) {
        const s=path.samples[i];
        for(let j=0;j<offsets.length;j++) {
          const lateral=sign*(s.halfWidth+s.halfWidth*2*offsets[j]);
          const x=s.point.x+s.side.x*lateral,z=s.point.z+s.side.z*lateral;
          // Cover the capped visible water depth at the ribbon edge, including
          // peak discharge. These are illustrative banks, not surveyed levees.
          const crest=3.8+.30*noise(s.distance,7+sign);
          const y=[s.point.y-.13,s.point.y+.12,s.point.y+crest,s.point.y+crest-.5,-.22][j];
          const c=j<2?new THREE.Color('#626c56'):j<4?new THREE.Color('#86866c'):new THREE.Color('#536447');
          c.multiplyScalar(.87+.13*noise(s.distance,13+j));
          positions.push(x,y,z);colors.push(c.r,c.g,c.b);uv.push(x*.15,z*.15);
        }
      }
      for(let i=0;i<path.samples.length-1;i++)for(let j=0;j<offsets.length-1;j++) {
        const k=base+i*offsets.length+j,n=k+offsets.length;
        for(const triangle of [[k,n,k+1],[k+1,n,n+1]]) {
          let polygons=[triangle.map(idx=>({x:positions[idx*3],y:positions[idx*3+1],z:positions[idx*3+2],color:colors.slice(idx*3,idx*3+3),uv:uv.slice(idx*2,idx*2+2)}))];
          const original=polygons[0],minX=Math.min(...original.map(p=>p.x)),maxX=Math.max(...original.map(p=>p.x)),minZ=Math.min(...original.map(p=>p.z)),maxZ=Math.max(...original.map(p=>p.z));
          const crossings=otherTriangles.filter(t=>t.maxX>minX+1e-8&&t.minX<maxX-1e-8&&t.maxZ>minZ+1e-8&&t.minZ<maxZ-1e-8);
          if(!crossings.length){indices.push(...triangle);continue;}
          for(const crossing of crossings) {
            polygons=polygons.flatMap(polygon=>subtractTriangle(polygon,crossing.vertices));
            if(!polygons.length)break;
          }
          for(const polygon of polygons) {
            const base=positions.length/3;
            for(const p of polygon){positions.push(p.x,p.y,p.z);colors.push(...p.color);uv.push(...p.uv);}
            for(let j=1;j<polygon.length-1;j++) {
              if(Math.abs(cross2(polygon[0],polygon[j],polygon[j+1]))>1e-8)indices.push(base,base+j,base+j+1);
            }
          }
        }
      }
    }
    const bank=new THREE.Mesh(geometry(positions,colors,uv,indices),material);bank.name=`Channel_Banks_${paths.indexOf(path)}`;bank.receiveShadow=true;bank.castShadow=true;group.add(bank);
    // Gravel bed closes the underside as a full surface, visible at low flow.
    const bed=channelWaterGeometry(path);const p=bed.attributes.position;
    for(let i=0;i<p.count;i++)p.setY(i,p.getY(i)-.12);
    const bedColors=[];for(let i=0;i<p.count;i++){const c=new THREE.Color('#455247').multiplyScalar(.94+.1*noise(i,1));bedColors.push(c.r,c.g,c.b);}
    bed.setAttribute('color',new THREE.Float32BufferAttribute(bedColors,3));bed.computeVertexNormals();
    const bedMesh=new THREE.Mesh(bed,material);bedMesh.name=`Channel_Bed_${paths.indexOf(path)}`;bedMesh.receiveShadow=true;group.add(bedMesh);
  }
  // A broad, continuous valley apron supports the entire channel corridor.
  // The former narrow bank skirts disappear into this terrain rather than
  // reading as two artificial levees perched on an unrelated flat plane.
  // This is an original visual approximation; it does not change model storage.
  const everySample=paths.flatMap(p=>p.samples),apron=100,spacing=6;
  const minX=Math.floor((Math.min(...everySample.map(s=>s.point.x-s.halfWidth))-apron)/spacing)*spacing;
  const maxX=Math.ceil((Math.max(...everySample.map(s=>s.point.x+s.halfWidth))+apron)/spacing)*spacing;
  const minZ=Math.floor((Math.min(...everySample.map(s=>s.point.z-s.halfWidth))-apron)/spacing)*spacing;
  const maxZ=Math.ceil((Math.max(...everySample.map(s=>s.point.z+s.halfWidth))+apron)/spacing)*spacing;
  const nx=Math.ceil((maxX-minX)/spacing),nz=Math.ceil((maxZ-minZ)/spacing);
  const positions=[],colors=[],uv=[],indices=[];
  const nearest=(x,z,path)=>{
    let result={distance:Infinity};
    for(let i=1;i<path.samples.length;i++) {
      const a=path.samples[i-1],b=path.samples[i],dx=b.point.x-a.point.x,dz=b.point.z-a.point.z;
      const t=clamp(((x-a.point.x)*dx+(z-a.point.z)*dz)/(dx*dx+dz*dz||1),0,1);
      const distance=Math.hypot(x-a.point.x-dx*t,z-a.point.z-dz*t);
      if(distance<result.distance)result={distance,bed:a.point.y+(b.point.y-a.point.y)*t,width:a.halfWidth+(b.halfWidth-a.halfWidth)*t};
    }
    return result;
  };
  for(let iz=0;iz<=nz;iz++)for(let ix=0;ix<=nx;ix++) {
    const x=minX+ix*spacing,z=minZ+iz*spacing;
    let height=-.45,interior=Infinity,wet=0,influence=0;
    for(const path of paths) {
      const n=nearest(x,z,path),outside=n.distance-n.width;
      if(outside<3) {
        // Keep the full wetted section unobstructed. Fine bank geometry closes
        // the shoreline above this coarse valley grid, including confluences.
        interior=Math.min(interior,n.bed-.22);
        wet=1;
      } else if(outside<apron) {
        const falloff=1-clamp((outside-3)/(apron-3),0,1);
        const ease=falloff*falloff*(3-2*falloff);
        const h=-.45+(n.bed+3.55+.45)*ease;
        height=Math.max(height,h);influence=Math.max(influence,ease);
      }
    }
    if(Number.isFinite(interior))height=interior;
    const c=new THREE.Color(wet?'#64715a':'#4e6543');
    c.multiplyScalar(.91+.09*noise(x+z*.37,9));
    positions.push(x,height,z);colors.push(c.r,c.g,c.b);uv.push(x*.15,z*.15);
    if(ix<nx&&iz<nz){const k=iz*(nx+1)+ix;indices.push(k,k+nx+1,k+1,k+1,k+nx+1,k+nx+2);}
  }
  const apronMesh=new THREE.Mesh(geometry(positions,colors,uv,indices),material);
  apronMesh.name='Continuous_Channel_Valley';apronMesh.receiveShadow=true;apronMesh.castShadow=true;group.add(apronMesh);
  return group;
}
