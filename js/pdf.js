// Minimal PDF writer: one full-page JPEG per page, no dependencies.
const enc = new TextEncoder();

// images: [{ bytes: Uint8Array (JPEG), width, height }]; page size in points.
export function jpegPagesToPdf(images, pageW = 960, pageH = 540) {
  const parts = [];
  const offsets = [];
  let length = 0;
  const push = (data) => {
    const b = typeof data === 'string' ? enc.encode(data) : data;
    parts.push(b);
    length += b.length;
  };
  const obj = (n, ...body) => {
    offsets[n] = length;
    push(`${n} 0 obj\n`);
    body.forEach(push);
    push('\nendobj\n');
  };

  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // binary marker comment

  const kids = images.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${images.length} >>`);
  images.forEach((img, i) => {
    const page = 3 + i * 3, content = page + 1, xobj = page + 2;
    const draw = `q ${pageW} 0 0 ${pageH} 0 0 cm /Im0 Do Q`;
    obj(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] ` +
      `/Resources << /XObject << /Im0 ${xobj} 0 R >> >> /Contents ${content} 0 R >>`);
    obj(content, `<< /Length ${draw.length} >>\nstream\n`, draw, '\nendstream');
    obj(xobj, `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.length} >>\nstream\n`,
      img.bytes, '\nendstream');
  });

  const size = 3 + images.length * 3;
  const xref = length;
  push(`xref\n0 ${size}\n0000000000 65535 f \n`);
  for (let i = 1; i < size; i++) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}
