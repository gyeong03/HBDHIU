import fs from 'node:fs';
import path from 'node:path';
import { MeshoptSimplifier } from '../npm-cache-npc/node_modules/meshoptimizer/meshopt_simplifier.js';

const [input, output, textureOutput, ratioText = '0.30'] = process.argv.slice(2);
const ratio = Number(ratioText);
if (!input || !output || !textureOutput || !(ratio > 0 && ratio <= 1)) {
  throw new Error('Usage: node optimize-npc-uv-safe.mjs input.glb output.glb texture.png [ratio]');
}

const source = fs.readFileSync(input);
if (source.readUInt32LE(0) !== 0x46546c67 || source.readUInt32LE(4) !== 2) throw new Error('Expected GLB v2');
const jsonLength = source.readUInt32LE(12);
const json = JSON.parse(source.subarray(20, 20 + jsonLength).toString('utf8').replace(/\0+$/, ''));
const binaryStart = 20 + jsonLength + 8;
const view = (index) => {
  const value = json.bufferViews[index];
  return source.subarray(binaryStart + (value.byteOffset || 0), binaryStart + (value.byteOffset || 0) + value.byteLength);
};
const floatView = (index) => {
  const bytes = view(index);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
};
const uintView = (index) => {
  const bytes = view(index);
  return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
};

const positions = floatView(0);
const normals = floatView(1);
const uvs = floatView(2);
const sourceIndices = uintView(3);
const texture = view(4);
const vertexCount = positions.length / 3;
if (normals.length / 3 !== vertexCount || uvs.length / 2 !== vertexCount) throw new Error('Unexpected attribute layout');

// UV and normals participate in the error metric. Surviving vertices are copied exactly:
// unlike the earlier grid merge, no UVs, positions, or skin pixels are averaged or remapped.
const attributes = new Float32Array(vertexCount * 5);
for (let i = 0; i < vertexCount; i++) {
  attributes.set(normals.subarray(i * 3, i * 3 + 3), i * 5);
  attributes.set(uvs.subarray(i * 2, i * 2 + 2), i * 5 + 3);
}
await MeshoptSimplifier.ready;
const targetIndexCount = Math.max(3, Math.floor(sourceIndices.length * ratio / 3) * 3);
const [simplified, error] = MeshoptSimplifier.simplifyWithAttributes(
  sourceIndices, positions, 3, attributes, 5, [0.25, 0.25, 0.25, 8, 8], null,
  targetIndexCount, 0.015, ['LockBorder']
);
const indices = new Uint32Array(simplified);
const [remap, compactCount] = MeshoptSimplifier.compactMesh(indices);
const compactPositions = new Float32Array(compactCount * 3);
const compactNormals = new Float32Array(compactCount * 3);
const compactUvs = new Float32Array(compactCount * 2);
for (let oldIndex = 0; oldIndex < remap.length; oldIndex++) {
  const newIndex = remap[oldIndex];
  if (newIndex === 0xffffffff) continue;
  compactPositions.set(positions.subarray(oldIndex * 3, oldIndex * 3 + 3), newIndex * 3);
  compactNormals.set(normals.subarray(oldIndex * 3, oldIndex * 3 + 3), newIndex * 3);
  compactUvs.set(uvs.subarray(oldIndex * 2, oldIndex * 2 + 2), newIndex * 2);
}

const pad = (buffer) => buffer.length % 4 ? Buffer.concat([buffer, Buffer.alloc(4 - buffer.length % 4)]) : buffer;
const chunks = [
  pad(Buffer.from(compactPositions.buffer)), pad(Buffer.from(compactNormals.buffer)),
  pad(Buffer.from(compactUvs.buffer)), pad(Buffer.from(indices.buffer)), pad(Buffer.from(texture)),
];
let offset = 0;
for (let i = 0; i < chunks.length; i++) {
  Object.assign(json.bufferViews[i], { buffer: 0, byteOffset: offset, byteLength: chunks[i].length });
  offset += chunks[i].length;
}
json.bufferViews[0].target = json.bufferViews[1].target = json.bufferViews[2].target = 34962;
json.bufferViews[3].target = 34963;
json.accessors[0].count = json.accessors[1].count = compactCount;
json.accessors[2].count = compactCount;
json.accessors[3].count = indices.length;
const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < compactPositions.length; i += 3) {
  for (let axis = 0; axis < 3; axis++) {
    min[axis] = Math.min(min[axis], compactPositions[i + axis]);
    max[axis] = Math.max(max[axis], compactPositions[i + axis]);
  }
}
json.accessors[0].min = min;
json.accessors[0].max = max;
json.buffers[0].byteLength = offset;
const jsonChunk = pad(Buffer.from(JSON.stringify(json)));
const binaryChunk = Buffer.concat(chunks);
const header = Buffer.alloc(12), jsonHeader = Buffer.alloc(8), binaryHeader = Buffer.alloc(8);
header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binaryChunk.length, 8);
jsonHeader.writeUInt32LE(jsonChunk.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4);
binaryHeader.writeUInt32LE(binaryChunk.length, 0); binaryHeader.writeUInt32LE(0x004e4942, 4);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, Buffer.concat([header, jsonHeader, jsonChunk, binaryHeader, binaryChunk]));
fs.writeFileSync(textureOutput, texture);
console.log(JSON.stringify({ input: path.basename(input), sourceTriangles: sourceIndices.length / 3, triangles: indices.length / 3, vertices: compactCount, geometricError: error, bytes: fs.statSync(output).size }));
