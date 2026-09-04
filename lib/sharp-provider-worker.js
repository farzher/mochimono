let sharpPromise = null;

async function sharpLibrary() {
  if (!sharpPromise) sharpPromise = import('sharp').then(module => {
    const sharp = module.default || module;
    sharp.concurrency(1);
    sharp.cache({ memory: 32, files: 0, items: 24 });
    return sharp;
  });
  return sharpPromise;
}

process.on('message', async message => {
  if (message?.type !== 'thumbnail' || !message.id || !message.input) return;
  try {
    const sharp = await sharpLibrary();
    const { data, info } = await sharp(message.input)
      .rotate()
      .resize({
        width: Number(message.edge) || 768,
        height: Number(message.edge) || 768,
        fit: 'inside',
        withoutEnlargement: true
      })
      .webp({ quality: 78, effort: 2, smartSubsample: true })
      .toBuffer({ resolveWithObject: true });
    process.send?.({
      id: message.id,
      ok: true,
      data,
      info: { width: Number(info.width) || 0, height: Number(info.height) || 0 }
    });
  } catch (error) {
    process.send?.({
      id: message.id,
      ok: false,
      code: String(error?.code || ''),
      error: String(error?.message || error)
    });
  }
});

process.on('disconnect', () => process.exit(0));
