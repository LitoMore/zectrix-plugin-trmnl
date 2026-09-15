import sharp from 'sharp';

export async function prepareImage(input, fit = 'contain') {
  try {
    return await sharp(input, {limitInputPixels: 20_000_000, failOn: 'error'})
      .rotate()
      .flatten({background: '#ffffff'})
      .resize(400, 300, {fit, background: '#ffffff'})
      .grayscale()
      .png()
      .toBuffer();
  } catch {
    throw new Error('Image could not be decoded or resized');
  }
}
