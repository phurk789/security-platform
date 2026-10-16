// Shrinks a camera photo before upload: long edge ≤ 1600 px, JPEG.
const MAX_EDGE = 1600;

export async function downscale(file: File): Promise<{ mime: string; base64: string; width: number; height: number }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('decode failed'));
      i.src = url;
    });
    const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas');
    ctx.drawImage(img, 0, 0, width, height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
    return { mime: 'image/jpeg', base64: dataUrl.slice(dataUrl.indexOf(',') + 1), width, height };
  } finally {
    URL.revokeObjectURL(url);
  }
}
