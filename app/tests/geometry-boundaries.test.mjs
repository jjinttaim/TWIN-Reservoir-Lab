import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { mapVisualState } from '../src/viewer3d.mjs';
import { sampleChannel, channelWaterGeometry } from '../src/channel-terrain.mjs';

// Inspect the shipped binary, not a duplicate terrain-height formula. These
// tests protect visual joins; they do not validate surveyed dam hydraulics.
const assetURL = process.env.TWIN_GEOMETRY_ASSETS
  ? pathToFileURL(resolve(process.env.TWIN_GEOMETRY_ASSETS) + sep)
  : new URL('../assets/models/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('twin-dam.scene.json', assetURL), 'utf8'));
const bytes = readFileSync(new URL(manifest.model, assetURL));
assert.equal(bytes.readUInt32LE(0), 0x46546c67, 'GLB header');
let gltf, binary;
for (let offset = 12; offset < bytes.length;) {
  const size = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4);
  const chunk = bytes.subarray(offset + 8, offset + 8 + size);
  if (type === 0x4e4f534a) gltf = JSON.parse(chunk.toString('utf8').replace(/[\s\0]+$/g, ''));
  if (type === 0x004e4942) binary = chunk;
  offset += size + 8;
}
assert.ok(gltf && binary, 'embedded geometry must be readable');

function accessor(index) {
  const a = gltf.accessors[index], view = gltf.bufferViews[a.bufferView];
  const format = { 5126: [4, 'readFloatLE'], 5125: [4, 'readUInt32LE'], 5123: [2, 'readUInt16LE'], 5121: [1, 'readUInt8'] }[a.componentType];
  assert.ok(format && !a.sparse, 'test supports ordinary uncompressed exported geometry');
  const width = { SCALAR: 1, VEC3: 3 }[a.type];
  assert.ok(width, 'position or triangle-index accessor');
  const [size, method] = format, stride = view.byteStride || size * width;
  const start = (view.byteOffset || 0) + (a.byteOffset || 0), values = new Float64Array(a.count * width);
  for (let i = 0; i < a.count; i++) for (let j = 0; j < width; j++) values[i * width + j] = binary[method](start + i * stride + j * size);
  return values;
}

const meshes = [];
const retained = /Terrain|Shore|Valley|Rockfill|Upstream_Armoring|Abutment|Forebay|Spillway_Chute|Crest_Road|Turbine_Outlet_Shadow|Collector|Gate_Chute_Returnwall/;
function visit(index, parent) {
  const node = gltf.nodes[index];
  const local = node.matrix ? new Matrix4().fromArray(node.matrix) : new Matrix4().compose(
    new Vector3(...(node.translation || [0, 0, 0])),
    new Quaternion(...(node.rotation || [0, 0, 0, 1])),
    new Vector3(...(node.scale || [1, 1, 1])),
  );
  const world = parent.clone().multiply(local);
  if (node.mesh != null && retained.test(node.name || '')) for (const primitive of gltf.meshes[node.mesh].primitives) {
    assert.equal(primitive.mode ?? 4, 4, 'exported boundary mesh uses triangles');
    const positions = accessor(primitive.attributes.POSITION), p = new Vector3();
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
      p.set(positions[i], positions[i + 1], positions[i + 2]).applyMatrix4(world);
      for (const [axis, value] of [p.x, p.y, p.z].entries()) {
        positions[i + axis] = value; min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value);
      }
    }
    const indices = primitive.indices == null ? Float64Array.from({ length: positions.length / 3 }, (_, i) => i) : accessor(primitive.indices);
    meshes.push({ name: node.name, positions, indices, min, max });
  }
  for (const child of node.children || []) visit(child, world);
}
for (const index of gltf.scenes[gltf.scene || 0].nodes) visit(index, new Matrix4());

// Barycentric interpolation in world XZ is a vertical ray/triangle query. It
// handles the real exported mesh spacing and all parent transforms.
function topSurface(x, z, namePattern) {
  let highest = -Infinity;
  for (const mesh of meshes) {
    if (!namePattern.test(mesh.name) || x < mesh.min[0] - 1e-5 || x > mesh.max[0] + 1e-5 || z < mesh.min[2] - 1e-5 || z > mesh.max[2] + 1e-5) continue;
    const p = mesh.positions, ids = mesh.indices;
    for (let i = 0; i < ids.length; i += 3) {
      const a = ids[i] * 3, b = ids[i + 1] * 3, c = ids[i + 2] * 3;
      const bx = p[b] - p[a], bz = p[b + 2] - p[a + 2], cx = p[c] - p[a], cz = p[c + 2] - p[a + 2];
      const determinant = bx * cz - bz * cx;
      if (Math.abs(determinant) < 1e-10) continue;
      const dx = x - p[a], dz = z - p[a + 2], u = (dx * cz - dz * cx) / determinant, v = (bx * dz - bz * dx) / determinant;
      if (u >= -1e-5 && v >= -1e-5 && u + v <= 1 + 1e-5) highest = Math.max(highest, p[a + 1] + u * (p[b + 1] - p[a + 1]) + v * (p[c + 1] - p[a + 1]));
    }
  }
  return highest;
}

function insidePolygon(x, z) {
  const polygon = manifest.reservoir.polygon;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, az] = polygon[j], [bx, bz] = polygon[i], dx = bx - ax, dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
    if (Math.hypot(x - ax - t * dx, z - az - t * dz) < 1e-5) return true;
    if ((az > z) !== (bz > z) && x < ax + (z - az) * dx / dz) inside = !inside;
  }
  return inside;
}

const spill = manifest.channels.find(c => c.kind === 'spill');
const solidShore = /Forest_Terrain|Sloping_Shore|Upstream_Armoring|Downstream_Rockfill|Rockfill_Endcap|Abutment|Crest_Road/;

test('spillway water starts at the real inlet and overlaps the connected lake', () => {
  assert.ok(manifest.boundaryContract, 're-export the repaired Blender model and manifest');
  const inlet = manifest.boundaryContract.forebayFloorPoints[0];
  assert.deepEqual(spill.bedPoints[0], inlet, 'the first chute point must not be dropped by slicing');
  for (const offset of [-spill.width * .48, 0, spill.width * .48]) assert.ok(insidePolygon(inlet[0] + offset, inlet[2]), 'lake reaches the entire gate inlet');
  const probeZ = inlet[2] + .25;
  const first = spill.bedPoints[0], next = spill.bedPoints[1];
  const expected = first[1] + (probeZ - first[2]) / (next[2] - first[2]) * (next[1] - first[1]);
  const exported = topSurface(inlet[0], probeZ, /Spillway_Chute$/);
  assert.ok(Math.abs(exported - expected) < .05, `first water segment must lie on exported chute: ${exported} vs ${expected}`);
});

test('visual level mapping stays above the inlet floor and below the dam crest, including waves', () => {
  const { minY, maxY, maxWaveDisplacementM: wave } = manifest.reservoir;
  assert.ok(Number.isFinite(wave) && wave > 0, 'declared presentation-wave bound');
  assert.deepEqual(manifest.boundaryContract?.renderLevelRangeM, [minY, maxY]);
  assert.ok(minY - wave > spill.bedPoints[0][1], 'lowest lake trough must still reach the inlet floor');
  assert.ok(maxY + wave < manifest.referenceDimensions.damHeightM, 'highest visual crest must not overtop the dam');
  const config = { minLevelM: 10, maxLevelM: 50, minStorageMcm: 0, maxStorageMcm: 100, initialStorageMcm: 50 };
  for (const [levelM, expected] of [[-10, minY], [10, minY], [30, (minY + maxY) / 2], [50, maxY], [80, maxY]]) {
    const row = { levelM, releaseCms: 100, turbineCms: 80, spillCms: 20 }, original = { ...row };
    assert.equal(mapVisualState(row, config, manifest.reservoir).level, expected);
    assert.deepEqual(row, original, 'presentation mapping must not mutate the operating result');
  }
});

test('outer lake edges are buried in the actual exported terrain, not cut above it', () => {
  assert.ok(manifest.boundaryContract, 'boundary contract is required');
  const limit = manifest.reservoir.maxY + manifest.reservoir.maxWaveDisplacementM;
  const frontZ = -manifest.boundaryContract.frontBoundaryBlenderY;
  const polygon = manifest.reservoir.polygon;
  let checked = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const front = Math.abs(a[1] - frontZ) < 1e-5 && Math.abs(b[1] - frontZ) < 1e-5;
    if (front) continue;
    const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 35);
    for (let step = 0; step <= steps; step++) {
      const t = step / steps, x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
      const ground = topSurface(x, z, solidShore);
      assert.ok(ground >= limit, `unsealed outer edge (${x.toFixed(2)}, ${z.toFixed(2)}): terrain ${ground.toFixed(3)} < water ${limit}`);
      checked++;
    }
  }
  assert.ok(checked > 60, 'sample all three shores, including their endpoints');
  for (const [x, z] of [[402, -245], [423, -655], [365, -830]]) assert.ok(insidePolygon(x, z), 'previous airborne cuts must now lie inside the continuous lake');
});

test('dam-to-bank joins close the front lake edge on both sides of the gate', () => {
  assert.ok(manifest.boundaryContract, 'boundary contract is required');
  const z = -manifest.boundaryContract.frontBoundaryBlenderY;
  const limit = manifest.reservoir.maxY + manifest.reservoir.maxWaveDisplacementM;
  // The deliberate gate aperture is checked separately through its floor and
  // water join. Avoid counting the overhead gate bridge as a solid shoreline.
  for (const x of [-450, -325, -270, -260, 0, 255, 264, 275, 280, 350, 355, 400, 500, 600]) {
    const height = topSurface(x, z, solidShore);
    assert.ok(height >= limit, `front join x=${x} leaves an opening: ${height.toFixed(3)} < ${limit}`);
  }
});

test('forebay floor remains continuous from the gate into the lake at the lowest display level', () => {
  const points = manifest.boundaryContract?.forebayFloorPoints;
  assert.ok(points?.length >= 3, 'forebay must connect the gate to the upstream lake');
  for (let i = 0; i < points.length - 1; i++) for (const t of [0, .5, 1]) {
    const [x, y, z] = points[i].map((value, axis) => value + (points[i + 1][axis] - value) * t);
    const floor = topSurface(x, z, /Spillway_Forebay_Closed_Floor$/);
    assert.ok(Math.abs(floor - y) < .05, `forebay floor gap at (${x}, ${z}): ${floor} vs ${y}`);
    assert.ok(floor < manifest.reservoir.minY - manifest.reservoir.maxWaveDisplacementM, 'forebay remains wetted at the lowest visual trough');
  }
});

test('the widened tailrace actually covers every exported powerhouse outlet opening', () => {
  const turbine = manifest.channels.find(c => c.kind === 'turbine');
  assert.ok(turbine.widths?.length === turbine.points.length, 'collector needs a width profile rather than a constant narrow ribbon');
  const path = sampleChannel(turbine.points, turbine.width, 160, turbine.interpolation || 'smooth', true, turbine.widths);
  const geometry = channelWaterGeometry(path), p = geometry.attributes.position;
  const sectionX = Array.from({ length: 13 }, (_, i) => p.getX(i));
  const sectionZ = Array.from({ length: 13 }, (_, i) => p.getZ(i));
  const left = Math.min(...sectionX), right = Math.max(...sectionX);
  const outlets = meshes.filter(m => /Turbine_Outlet_Shadow(?:\.\d+)?$/.test(m.name));
  const unitCount = Number.isInteger(manifest.powerhouseUnits) ? manifest.powerhouseUnits : 3;
  assert.equal(outlets.length, unitCount, 'every exported outlet mesh is inspected (unit count from the manifest)');
  for (const outlet of outlets) {
    assert.ok(left <= outlet.min[0] + .05 && right >= outlet.max[0] - .05,
      `${outlet.name} is disconnected: water X ${left.toFixed(2)}..${right.toFixed(2)}, opening ${outlet.min[0].toFixed(2)}..${outlet.max[0].toFixed(2)}`);
    assert.ok(Math.min(...sectionZ) <= outlet.max[2] + .05 && Math.max(...sectionZ) >= outlet.min[2] - .05, 'collector begins inside the actual outlet mouth');
  }
  for (const x of [left + .5, (left + right) / 2, right - .5]) {
    const floor = topSurface(x, turbine.points[0][2], /Powerhouse_Outlet_Collector_Apron$/);
    assert.ok(Number.isFinite(floor) && floor < turbine.points[0][1], 'collector has a continuous solid apron below its water');
  }
  assert.ok(path.samples.at(-1).halfWidth < path.samples[0].halfWidth, 'collector narrows into the existing downstream tailrace');
  geometry.dispose();
});

// The horizontal lake ends downstream of the gate. Its side edges must meet
// the return walls throughout that overlap, including variable water width.
test('inlet water reaches both return walls at the lake boundary', () => {
  const path = sampleChannel(spill.bedPoints, spill.width, 160, 'linear', false, spill.widths);
  const front = -manifest.boundaryContract.frontBoundaryBlenderY;
  const i = path.samples.findIndex(s => s.point.z >= front);
  assert.ok(i > 0);
  const a = path.samples[i - 1], b = path.samples[i];
  const t = (front-a.point.z)/(b.point.z-a.point.z);
  const x = a.point.x+(b.point.x-a.point.x)*t;
  const half = a.halfWidth+(b.halfWidth-a.halfWidth)*t;
  const walls=meshes.filter(m=>/Gate_Chute_Returnwall_/.test(m.name)).sort((a,b)=>a.min[0]-b.min[0]);
  assert.equal(walls.length,2);
  assert.ok(x-half<=walls[0].max[0], 'left water edge must overlap the left wall');
  assert.ok(x+half>=walls[1].min[0], 'right water edge must overlap the right wall');
});
