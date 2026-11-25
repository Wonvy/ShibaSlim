// Builds a presentation that exercises every code path: oversized photos,
// PNG photos, screenshots, transparency, crops, duplicates and orphans.
import JSZip from 'jszip';
import pptxgenModule from 'pptxgenjs';
import sharp from 'sharp';

const PptxGenJS = pptxgenModule.default ?? pptxgenModule;

/** Smooth random texture: compresses like a photograph rather than like noise. */
function photo(width, height, mean) {
  return sharp({
    create: { width, height, channels: 3, background: '#808080', noise: { type: 'gaussian', mean, sigma: 70 } },
  }).blur(4);
}

function screenshotSvg(width, height) {
  const rows = Array.from({ length: 24 }, (_, i) => {
    const y = 140 + i * 52;
    return `<rect x="80" y="${y}" width="${600 + ((i * 137) % 900)}" height="22" fill="#2b3a55"/>
            <text x="1700" y="${y + 20}" font-family="sans-serif" font-size="26" fill="#c0392b">Row ${i} value ${i * 31}</text>`;
  }).join('');
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#ffffff"/>
    <rect width="100%" height="90" fill="#1f6feb"/>
    <text x="80" y="60" font-family="sans-serif" font-size="40" fill="#ffffff">Quarterly dashboard</text>
    ${rows}</svg>`);
}

function cutoutSvg(size) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <defs><radialGradient id="g"><stop offset="0" stop-color="#ffd166"/><stop offset="1" stop-color="#ef476f"/></radialGradient></defs>
    <circle cx="${size / 2}" cy="${size / 2}" r="${size * 0.45}" fill="url(#g)"/></svg>`);
}

const uri = (mime, buffer) => `${mime};base64,${buffer.toString('base64')}`;

export async function buildImages() {
  const [photoA, photoB, photoC, photoPng, screenshot, cutout, keyed, icon, stray] = await Promise.all([
    photo(4000, 3000, 120).jpeg({ quality: 95 }).toBuffer(),
    photo(3000, 2250, 100).jpeg({ quality: 95 }).toBuffer(),
    photo(3200, 2400, 140).jpeg({ quality: 95 }).toBuffer(),
    photo(2400, 1600, 150).png().toBuffer(),
    sharp(screenshotSvg(2560, 1440)).png().toBuffer(),
    sharp(cutoutSvg(1600)).png().toBuffer(),
    photo(1200, 900, 110).png().toBuffer(),
    sharp({ create: { width: 48, height: 48, channels: 4, background: '#1f6feb' } }).png().toBuffer(),
    photo(800, 600, 90).png().toBuffer(),
  ]);
  return { photoA, photoB, photoC, photoPng, screenshot, cutout, keyed, icon, stray };
}

/**
 * Returns the fixture plus the media part name of each image, so tests can
 * make assertions without depending on how the generator numbers its files.
 */
export async function buildFixture() {
  const images = await buildImages();
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9'; // 10in x 5.625in

  // One picture per slide, so each slide's rels identify exactly one image.
  const layout = [
    ['photoA', 'image/jpeg', { x: 0, y: 0, w: 10, h: 5.625 }],
    ['photoB', 'image/jpeg', { x: 1, y: 1, w: 2, h: 1.5 }],
    ['photoC', 'image/jpeg', { x: 1, y: 1, w: 4, h: 3 }],
    ['photoPng', 'image/png', { x: 1, y: 1, w: 5, h: 3.3333 }],
    ['screenshot', 'image/png', { x: 0, y: 0, w: 10, h: 5.625 }],
    ['cutout', 'image/png', { x: 1, y: 1, w: 3, h: 3 }],
    ['keyed', 'image/png', { x: 1, y: 1, w: 4, h: 3 }],
    ['icon', 'image/png', { x: 1, y: 1, w: 0.5, h: 0.5 }],
    ['photoA', 'image/jpeg', { x: 1, y: 1, w: 2, h: 1.5 }],
  ];
  for (const [key, mime, box] of layout) {
    pptx.addSlide().addImage({ data: uri(mime, images[key]), ...box });
  }

  const zip = await JSZip.loadAsync(await pptx.write({ outputType: 'nodebuffer' }));
  const slideMedia = async (n) => {
    const rels = await zip.file(`ppt/slides/_rels/slide${n}.xml.rels`).async('string');
    const match = /Target="\.\.\/media\/([^"]+)"/.exec(rels);
    if (!match) throw new Error(`slide ${n} has no media relationship`);
    return `ppt/media/${match[1]}`;
  };
  const editSlide = async (n, edit) => {
    const name = `ppt/slides/slide${n}.xml`;
    const before = await zip.file(name).async('string');
    const after = edit(before);
    if (after === before) throw new Error(`fixture edit did not apply to slide ${n}`);
    zip.file(name, after);
  };

  const parts = {};
  for (let i = 0; i < layout.length - 1; i++) parts[layout[i][0]] = await slideMedia(i + 1);

  // Slide 3: crop to the middle half in each direction, so the bitmap needs twice the display size.
  await editSlide(3, (xml) => xml.replace(/<a:stretch>/, '<a:srcRect l="25000" t="25000" r="25000" b="25000"/><a:stretch>'));

  // Slide 7: "set transparent colour", which depends on exact pixel values.
  await editSlide(7, (xml) =>
    xml.replace(
      /<a:blip ([^>]*?)\/>|<a:blip ([^>]*?)>/,
      (_, selfClosed, open) =>
        `<a:blip ${selfClosed ?? open}><a:clrChange><a:clrFrom><a:srgbClr val="FFFFFF"/></a:clrFrom>` +
        `<a:clrTo><a:srgbClr val="FFFFFF"><a:alpha val="0"/></a:srgbClr></a:clrTo></a:clrChange>` +
        (selfClosed !== undefined ? '</a:blip>' : ''),
    ),
  );

  // Slide 9: point it at a byte-identical copy of photoA, as happens when a picture is inserted twice.
  const lastRels = `ppt/slides/_rels/slide${layout.length}.xml.rels`;
  const relsXml = await zip.file(lastRels).async('string');
  const original = /Target="\.\.\/media\/([^"]+)"/.exec(relsXml)[1];
  zip.file('ppt/media/duplicate-of-photoA.jpeg', Buffer.from(images.photoA));
  zip.file(lastRels, relsXml.replace(`../media/${original}`, '../media/duplicate-of-photoA.jpeg'));
  if (`ppt/media/${original}` !== parts.photoA) zip.remove(`ppt/media/${original}`);
  parts.duplicate = 'ppt/media/duplicate-of-photoA.jpeg';

  // Left behind by an earlier edit: nothing references it.
  zip.file('ppt/media/orphan.png', images.stray);
  parts.orphan = 'ppt/media/orphan.png';

  const data = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { data, parts, images };
}
