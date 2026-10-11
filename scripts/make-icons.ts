// Renders the raster icon set from public/favicon.svg. Run with `npm run icons` after editing the SVG.
import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const svg = await readFile('public/favicon.svg', 'utf8');
// iOS and Android apply their own corner mask, so those icons get a full-bleed background.
const squareSvg = svg.replace(/<rect width="64" height="64" rx="16"/, '<rect width="64" height="64"');

const render = (source: string, size: number) =>
  sharp(Buffer.from(source), { density: (72 * size * 4) / 64 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer();

function ico(images: { size: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const entry = 6 + i * 16;
    header.writeUInt8(size, entry);
    header.writeUInt8(size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.data)]);
}

await writeFile('public/favicon.ico', ico([
  { size: 16, data: await render(svg, 16) },
  { size: 32, data: await render(svg, 32) },
  { size: 48, data: await render(svg, 48) },
]));
await writeFile('public/apple-touch-icon.png', await render(squareSvg, 180));
await writeFile('public/icon-192.png', await render(squareSvg, 192));
await writeFile('public/icon-512.png', await render(squareSvg, 512));
console.log('icons written');
