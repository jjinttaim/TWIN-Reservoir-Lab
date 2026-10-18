#!/usr/bin/env node
/** Local, dependency-free GLB + water-placement check. Not a hydraulic validator. */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultManifest = fileURLToPath(new URL('../assets/models/twin-dam.scene.json', import.meta.url));
const requireValid = (condition, message) => { if (!condition) throw new Error(message); };
const vector = (v, n) => Array.isArray(v) && v.length === n && v.every(Number.isFinite);
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function multiply(a, b) {
  const out = Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
}
function matrixFor(node, i) {
  if (node.matrix) {
    requireValid(vector(node.matrix, 16), `node ${i}: 변환 행렬에 유효하지 않은 숫자가 있습니다.`);
    return node.matrix;
  }
  const t = node.translation || [0, 0, 0], s = node.scale || [1, 1, 1], q = node.rotation || [0, 0, 0, 1];
  requireValid(vector(t, 3) && vector(s, 3) && vector(q, 4), `node ${i}: 위치, 크기, 회전 값이 유효하지 않습니다.`);
  const [x, y, z, w] = q, [sx, sy, sz] = s;
  requireValid(Math.abs(x*x+y*y+z*z+w*w-1) < 0.02, `node ${i}: 회전 quaternion이 정규화되어 있지 않습니다.`);
  return [
    (1-2*y*y-2*z*z)*sx, (2*x*y+2*z*w)*sx, (2*x*z-2*y*w)*sx, 0,
    (2*x*y-2*z*w)*sy, (1-2*x*x-2*z*z)*sy, (2*y*z+2*x*w)*sy, 0,
    (2*x*z+2*y*w)*sz, (2*y*z-2*x*w)*sz, (1-2*x*x-2*y*y)*sz, 0,
    t[0], t[1], t[2], 1,
  ];
}
function addBounds(target, box, matrix) {
  for (let bits = 0; bits < 8; bits++) {
    const p = [0, 1, 2].map((axis) => bits & (1 << axis) ? box.max[axis] : box.min[axis]);
    const q = [0, 1, 2].map((r) => matrix[r]*p[0]+matrix[4+r]*p[1]+matrix[8+r]*p[2]+matrix[12+r]);
    requireValid(q.every(Number.isFinite), '변환된 모델 좌표에 NaN 또는 Infinity가 있습니다.');
    for (let a = 0; a < 3; a++) { target.min[a] = Math.min(target.min[a], q[a]); target.max[a] = Math.max(target.max[a], q[a]); }
  }
}
const emptyBounds = () => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });

function checkPath(path, name) {
  requireValid(path && Array.isArray(path.points) && path.points.length >= 2 && path.points.every((p) => vector(p, 3)), `${name}: 유한한 [x,y,z] 점이 두 개 이상 필요합니다.`);
  requireValid(Number.isFinite(path.width) && path.width > 0, `${name}: 너비는 0보다 커야 합니다.`);
  for (let i = 1; i < path.points.length; i++) requireValid(path.points[i].some((n, a) => n !== path.points[i-1][a]), `${name}: 연속한 ${i-1}, ${i} 점이 같습니다.`);
}

function parseGLB(bytes) {
  requireValid(bytes.length >= 20 && bytes.readUInt32LE(0) === 0x46546c67, 'glTF GLB 헤더가 없습니다.');
  requireValid(bytes.readUInt32LE(4) === 2, 'GLB 버전 2가 필요합니다.');
  requireValid(bytes.readUInt32LE(8) === bytes.length, 'GLB 선언 길이와 실제 파일 길이가 다릅니다.');
  let json = null, binary = null;
  for (let offset = 12; offset < bytes.length;) {
    requireValid(offset + 8 <= bytes.length, 'GLB chunk 헤더가 잘렸습니다.');
    const length = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset+4);
    requireValid(length % 4 === 0 && offset + 8 + length <= bytes.length, 'GLB chunk 길이가 잘못되었습니다.');
    const part = bytes.subarray(offset+8, offset+8+length);
    if (type === 0x4e4f534a) { requireValid(!json, 'JSON chunk가 중복되었습니다.'); json = JSON.parse(part.toString('utf8').replace(/[\s\0]+$/g, '')); }
    else if (type === 0x004e4942) { requireValid(!binary, 'BIN chunk가 중복되었습니다.'); binary = part; }
    offset += length + 8;
  }
  requireValid(json?.asset?.version === '2.0' && binary, 'GLB에 glTF 2.0 JSON과 BIN chunk가 필요합니다.');
  return { json, binary };
}

export async function checkModel(manifestFile = defaultManifest) {
  const warnings = [];
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  requireValid(typeof manifest.model === 'string' && /^[a-zA-Z0-9_.-]+\.glb$/i.test(manifest.model), 'model은 같은 폴더 안의 .glb 파일 이름이어야 합니다.');
  requireValid(manifest.reservoir && Number.isFinite(manifest.reservoir.minY) && Number.isFinite(manifest.reservoir.maxY) && manifest.reservoir.minY < manifest.reservoir.maxY, '저수지 minY/maxY 범위를 확인하세요.');
  if (manifest.reservoir.polygon) {
    const p = manifest.reservoir.polygon;
    requireValid(Array.isArray(p) && p.length >= 3 && p.every((v) => vector(v, 2)), '저수지 polygon에는 유한한 [x,z] 점이 세 개 이상 필요합니다.');
    const area2 = p.reduce((sum, v, i) => { const next = p[(i+1)%p.length]; return sum + v[0]*next[1]-next[0]*v[1]; }, 0);
    requireValid(Math.abs(area2) > 1e-6, '저수지 polygon 면적이 0입니다.');
  } else {
    requireValid(vector(manifest.reservoir.center, 3) && vector(manifest.reservoir.size, 2) && manifest.reservoir.size.every((n) => n > 0), '저수지 center/size 또는 polygon이 필요합니다.');
  }
  checkPath(manifest.river, '하류 수면');
  requireValid(Array.isArray(manifest.channels) && manifest.channels.length > 0, '한 개 이상의 방류 채널이 필요합니다.');
  for (const [i, channel] of manifest.channels.entries()) {
    checkPath(channel, `방류 채널 ${i}`);
    requireValid(['spill', 'turbine', 'release'].includes(channel.kind), `방류 채널 ${i}: kind는 spill/turbine/release여야 합니다.`);
    if (channel.width > 100) warnings.push(`방류 채널 ${i} 너비 ${channel.width}m: viewer 최대 너비 100m를 넘습니다.`);
    if (channel.points.some((p, j) => j > 0 && p[1] > channel.points[j-1][1] + 0.5)) warnings.push(`방류 채널 ${i}에 상승 구간이 있습니다. 물길 표면과 좌표를 확인하세요.`);
  }
  for (const name of ['overview', 'upstream', 'spillway', 'downstream', 'top']) {
    const cam = manifest.cameras?.[name];
    requireValid(cam && vector(cam.position, 3) && vector(cam.target, 3), `${name} 카메라 position/target이 필요합니다.`);
    requireValid(cam.position.some((n, i) => n !== cam.target[i]), `${name} 카메라 위치와 주시점이 같습니다.`);
  }
  const filename = resolve(dirname(manifestFile), manifest.model);
  const bytes = await readFile(filename);
  if (bytes.length > 20 * 1024 * 1024) warnings.push(`모델이 20 MiB를 넘습니다 (${(bytes.length/1024/1024).toFixed(1)} MiB). 압축/정리를 권장합니다.`);
  const { json: gltf, binary } = parseGLB(bytes);
  for (const item of [...(gltf.buffers || []), ...(gltf.images || [])]) requireValid(!item.uri || item.uri.startsWith('data:'), 'GLB에 외부 파일 URI가 있습니다. 텍스처를 포함한 독립 GLB로 내보내세요.');
  requireValid(gltf.buffers?.length === 1 && gltf.buffers[0].byteLength <= binary.length, '단일 내장 binary buffer를 확인하세요.');
  for (const [index, view] of (gltf.bufferViews || []).entries()) {
    const offset = view.byteOffset || 0;
    requireValid((view.buffer || 0) === 0 && Number.isInteger(offset) && offset >= 0 && Number.isInteger(view.byteLength) && view.byteLength > 0 && offset + view.byteLength <= gltf.buffers[0].byteLength && offset + view.byteLength <= binary.length, `bufferView ${index}: 내장 binary 범위가 유효하지 않습니다.`);
  }
  let embeddedTextureBytes = 0;
  for (const [index, image] of (gltf.images || []).entries()) {
    let content;
    if (image.bufferView != null) {
      const view = gltf.bufferViews?.[image.bufferView];
      requireValid(view, `image ${index}: 내장 bufferView가 없습니다.`);
      content = binary.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
    } else {
      const match = image.uri?.match(/^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/=]+)$/);
      requireValid(match, `image ${index}: PNG/JPEG 내장 이미지가 필요합니다.`);
      content = Buffer.from(match[1], 'base64');
    }
    const png = content.length >= 24 && content.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpeg = content.length >= 4 && content[0] === 255 && content[1] === 216 && content.at(-2) === 255 && content.at(-1) === 217;
    requireValid(png || jpeg, `image ${index}: PNG/JPEG 파일 헤더가 손상되었습니다.`);
    if (image.mimeType) requireValid(image.mimeType === (png ? 'image/png' : 'image/jpeg'), `image ${index}: 선언 MIME 형식과 실제 이미지가 다릅니다.`);
    if (png) requireValid(content.readUInt32BE(16) > 0 && content.readUInt32BE(20) > 0, `image ${index}: 이미지 크기가 0입니다.`);
    embeddedTextureBytes += content.length;
  }
  for (const [index, texture] of (gltf.textures || []).entries()) {
    requireValid(Number.isInteger(texture.source) && gltf.images?.[texture.source], `texture ${index}: 내장 source image가 없습니다.`);
    if (texture.sampler != null) requireValid(gltf.samplers?.[texture.sampler], `texture ${index}: sampler가 없습니다.`);
  }
  function materialTextures(material) {
    return [material?.pbrMetallicRoughness?.baseColorTexture, material?.pbrMetallicRoughness?.metallicRoughnessTexture, material?.normalTexture, material?.occlusionTexture, material?.emissiveTexture].filter(Boolean);
  }
  for (const [index, material] of (gltf.materials || []).entries()) {
    for (const info of materialTextures(material)) requireValid(Number.isInteger(info.index) && gltf.textures?.[info.index], `material ${index}: PBR texture 참조가 유효하지 않습니다.`);
  }
  if (manifest.materials?.maps?.includes('tangent normal')) {
    requireValid((gltf.materials || []).some((m) => m.pbrMetallicRoughness?.baseColorTexture && m.pbrMetallicRoughness?.metallicRoughnessTexture && m.normalTexture), 'manifest가 선언한 PBR base color, normal, roughness 맵이 GLB에 없습니다.');
  }
  const checkedAttributes = new Set();
  function checkVectorAttribute(index, semantic, vertexCount) {
    const key = `${semantic}:${index}:${vertexCount}`;
    if (checkedAttributes.has(key)) return;
    const a = gltf.accessors?.[index];
    const width = semantic.startsWith('TEXCOORD_') ? 2 : 3;
    requireValid(a && a.type === `VEC${width}` && !a.sparse && Number.isInteger(a.count) && a.count === vertexCount, `${semantic} accessor ${index}: POSITION과 개수가 같은 VEC${width} 속성이 필요합니다.`);
    const format = ({ 5126: [4, 'readFloatLE'], 5121: [1, 'readUInt8'], 5123: [2, 'readUInt16LE'] })[a.componentType];
    requireValid(format && (a.componentType === 5126 || (width === 2 && a.normalized)), `${semantic} accessor ${index}: 지원하지 않는 component 형식입니다.`);
    const [componentBytes, read] = format;
    const view = gltf.bufferViews?.[a.bufferView];
    requireValid(view && (view.buffer || 0) === 0, `${semantic} accessor ${index}: bufferView가 없습니다.`);
    const elementBytes = width * componentBytes, stride = view.byteStride || elementBytes;
    const localOffset = a.byteOffset || 0, offset = (view.byteOffset || 0) + localOffset;
    requireValid(Number.isInteger(localOffset) && localOffset >= 0 && Number.isInteger(stride) && stride >= elementBytes && localOffset + (a.count - 1) * stride + elementBytes <= view.byteLength, `${semantic} accessor ${index}: binary 범위를 벗어납니다.`);
    for (let i = 0; i < a.count; i++) {
      let lengthSquared = 0;
      for (let axis = 0; axis < width; axis++) {
        const value = binary[read](offset + i * stride + axis * componentBytes);
        requireValid(Number.isFinite(value), `${semantic} accessor ${index}: vertex ${i}에 NaN/Infinity가 있습니다.`);
        lengthSquared += value * value;
      }
      if (semantic === 'NORMAL') requireValid(Math.abs(lengthSquared - 1) < 0.08, `NORMAL accessor ${index}: vertex ${i}의 법선 길이가 1이 아닙니다.`);
    }
    checkedAttributes.add(key);
  }
  const positions = new Map();
  function positionBounds(index) {
    if (positions.has(index)) return positions.get(index);
    const a = gltf.accessors?.[index];
    requireValid(a && a.type === 'VEC3' && a.componentType === 5126 && !a.sparse, `POSITION accessor ${index}: 압축하지 않은 Float32 VEC3 형식이 필요합니다.`);
    requireValid(Number.isInteger(a.count) && a.count > 0, `POSITION accessor ${index}: vertex 개수가 잘못되었습니다.`);
    const view = gltf.bufferViews?.[a.bufferView];
    requireValid(view && (view.buffer || 0) === 0, `POSITION accessor ${index}: bufferView가 없습니다.`);
    const stride = view.byteStride || 12, offset = (view.byteOffset || 0) + (a.byteOffset || 0);
    const end = offset+(a.count-1)*stride+12, viewEnd = (view.byteOffset || 0)+view.byteLength;
    requireValid(Number.isInteger(stride) && stride >= 12 && Number.isInteger(offset) && offset >= 0 && Number.isInteger(viewEnd) && end <= viewEnd && viewEnd <= binary.length, `POSITION accessor ${index}: binary 범위를 벗어납니다.`);
    const bounds = emptyBounds();
    for (let i = 0; i < a.count; i++) for (let axis = 0; axis < 3; axis++) {
      const n = binary.readFloatLE(offset+i*stride+axis*4);
      requireValid(Number.isFinite(n), `POSITION accessor ${index}: vertex ${i}에 NaN/Infinity가 있습니다.`);
      bounds.min[axis] = Math.min(bounds.min[axis], n); bounds.max[axis] = Math.max(bounds.max[axis], n);
    }
    for (const key of ['min', 'max']) if (a[key]) requireValid(vector(a[key], 3), `POSITION accessor ${index}: 선언 ${key} 값이 유효하지 않습니다.`);
    positions.set(index, bounds); return bounds;
  }
  const bounds = emptyBounds(); let meshInstances = 0, triangleInstances = 0, texturedPrimitiveInstances = 0, normalPrimitiveInstances = 0, uvPrimitiveInstances = 0;
  const roots = gltf.scenes?.[gltf.scene || 0]?.nodes;
  requireValid(Array.isArray(roots) && roots.length > 0, '기본 scene의 root node가 없습니다.');
  function visit(index, parent, ancestors = new Set()) {
    requireValid(!ancestors.has(index), 'node 계층이 순환합니다.');
    const node = gltf.nodes?.[index]; requireValid(node, `node ${index}가 없습니다.`);
    const world = multiply(parent, matrixFor(node, index));
    if (node.mesh != null) {
      const mesh = gltf.meshes?.[node.mesh]; requireValid(mesh?.primitives?.length > 0, `mesh ${node.mesh}가 없습니다.`);
      meshInstances++;
      for (const primitive of mesh.primitives) {
        requireValid(Number.isInteger(primitive.attributes?.POSITION), `mesh ${node.mesh}: POSITION이 없습니다.`);
        const accessorIndex = primitive.attributes.POSITION;
        addBounds(bounds, positionBounds(accessorIndex), world);
        const vertexCount = gltf.accessors[accessorIndex].count;
        if (primitive.attributes.NORMAL != null) {
          checkVectorAttribute(primitive.attributes.NORMAL, 'NORMAL', vertexCount);
          normalPrimitiveInstances++;
        }
        const uvAttributes = Object.entries(primitive.attributes).filter(([name]) => /^TEXCOORD_\d+$/.test(name));
        for (const [semantic, attribute] of uvAttributes) checkVectorAttribute(attribute, semantic, vertexCount);
        if (uvAttributes.length) uvPrimitiveInstances++;
        const material = gltf.materials?.[primitive.material];
        const textureInfos = materialTextures(material);
        if (textureInfos.length) {
          texturedPrimitiveInstances++;
          requireValid(primitive.attributes.NORMAL != null, `mesh ${node.mesh}: PBR 텍스처에 필요한 NORMAL이 없습니다.`);
          for (const info of textureInfos) {
            const uvSet = info.extensions?.KHR_texture_transform?.texCoord ?? info.texCoord ?? 0;
            requireValid(Number.isInteger(uvSet) && primitive.attributes[`TEXCOORD_${uvSet}`] != null, `mesh ${node.mesh}: 텍스처가 사용하는 TEXCOORD_${uvSet}가 없습니다.`);
          }
        }
        const count = primitive.indices != null ? gltf.accessors?.[primitive.indices]?.count : gltf.accessors[accessorIndex].count;
        requireValid(Number.isInteger(count) && count > 0, `mesh ${node.mesh}: index/vertex 개수가 유효하지 않습니다.`);
        const mode = primitive.mode ?? 4;
        if (mode === 4) { requireValid(count % 3 === 0, `mesh ${node.mesh}: 삼각형 index 개수가 3의 배수가 아닙니다.`); triangleInstances += count/3; }
        else if (mode === 5 || mode === 6) triangleInstances += Math.max(0, count-2);
      }
    }
    const next = new Set(ancestors).add(index);
    for (const child of node.children || []) visit(child, world, next);
  }
  for (const index of roots) visit(index, identity());
  const dimensions = bounds.max.map((n, i) => n-bounds.min[i]);
  requireValid(meshInstances > 0 && dimensions.every((n) => Number.isFinite(n) && n >= 0 && n < 1e7) && dimensions.some((n) => n > 0), '모델 전체 경계가 유효하지 않습니다.');
  if (triangleInstances > 500000) warnings.push(`삼각형 ${triangleInstances.toLocaleString()}개: 브라우저 성능을 확인하세요.`);
  const waterPoints = [...manifest.river.points, ...manifest.channels.flatMap((p) => p.points), ...(manifest.reservoir.polygon || []).map(([x,z]) => [x,manifest.reservoir.minY,z])];
  const outside = waterPoints.filter((p) => [0, 2].some((a) => p[a] < bounds.min[a]-dimensions[a]*0.1 || p[a] > bounds.max[a]+dimensions[a]*0.1)).length;
  if (outside) warnings.push(`물길 점 ${outside}개가 모델 수평 범위에서 10% 이상 벗어납니다. 배치를 확인하세요.`);
  if (manifest.reservoir.minY < bounds.min[1]-1 || manifest.reservoir.maxY > bounds.max[1]+1) warnings.push('저수지 수위 범위가 모델 높이 범위를 벗어납니다.');
  return {
    ok: true, file: filename, bytes: bytes.length,
    meshes: gltf.meshes?.length || 0, meshInstances, nodes: gltf.nodes?.length || 0,
    materials: gltf.materials?.length || 0, uniqueVertices: [...positions.keys()].reduce((n, index) => n+gltf.accessors[index].count, 0), triangleInstances,
    pbr: {
      embeddedImages: gltf.images?.length || 0, textures: gltf.textures?.length || 0, embeddedTextureBytes,
      baseColorTextureMaterials: (gltf.materials || []).filter((m) => m.pbrMetallicRoughness?.baseColorTexture).length,
      normalTextureMaterials: (gltf.materials || []).filter((m) => m.normalTexture).length,
      roughnessTextureMaterials: (gltf.materials || []).filter((m) => m.pbrMetallicRoughness?.metallicRoughnessTexture).length,
      texturedPrimitiveInstances, uvPrimitiveInstances, normalPrimitiveInstances,
    },
    bounds, dimensions, reservoirRangeY: [manifest.reservoir.minY, manifest.reservoir.maxY], channels: manifest.channels.length,
    warnings,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await checkModel(process.argv[2] ? resolve(process.argv[2]) : defaultManifest), null, 2)); }
  catch (error) { console.error(`MODEL CHECK FAILED: ${error.message}`); process.exitCode = 1; }
}
