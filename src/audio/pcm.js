// Mean signal energy of little-endian signed 16-bit mono audio, normalized to 0..1.
export function pcmRms(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = Math.floor(view.byteLength / 2);
  if (!count) return 0;
  let energy = 0;
  for (let offset = 0; offset < count * 2; offset += 2) energy += view.getInt16(offset, true) ** 2;
  return Math.sqrt(energy / count) / 32768;
}
