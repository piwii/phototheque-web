'use strict';

const filesInput = document.querySelector('#files');
const folderInput = document.querySelector('#folder');
const filesButton = document.querySelector('#choose-files');
const folderButton = document.querySelector('#choose-folder');
const status = document.querySelector('#status');
const progress = document.querySelector('#progress');
const errors = document.querySelector('#errors');
const download = document.querySelector('#download');
let archiveUrl;

filesButton.onclick = () => filesInput.click();
folderButton.onclick = () => folderInput.click();
folderButton.hidden = !('webkitdirectory' in folderInput);

for (const input of [filesInput, folderInput]) {
  input.addEventListener('change', () => {
    const files = Array.from(input.files).filter(file =>
      !file.name.startsWith('.') && file.webkitRelativePath.split('/').length <= 2
    );
    input.value = '';
    void convert(files);
  });
}

function resize(source, height) {
  const canvas = document.createElement('canvas');
  canvas.height = height;
  canvas.width = Math.max(1, Math.round(source.width * height / source.height));
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Le navigateur ne peut pas créer l’image.');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, height);
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, canvas.width, height);
  return canvas;
}

function jpeg(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob?.type === 'image/jpeg') resolve(blob);
      else reject(new Error('Impossible de générer le JPEG.'));
    }, 'image/jpeg', 1);
  });
}

function uniqueStem(name, used) {
  const safe = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  let stem = safe;
  let suffix = 2;
  while (used.has(stem.normalize('NFC').toLowerCase())) stem = safe + '-' + suffix++;
  used.add(stem.normalize('NFC').toLowerCase());
  return stem;
}

async function convert(files) {
  filesButton.disabled = folderButton.disabled = true;
  download.hidden = true;
  if (archiveUrl) URL.revokeObjectURL(archiveUrl);
  errors.replaceChildren();
  errors.hidden = true;
  progress.max = Math.max(1, files.length);
  progress.value = 0;
  progress.hidden = false;
  status.textContent = 'Conversion en cours…';
  const entries = [];
  const stems = new Set();
  let converted = 0;
  try {
    for (const file of files) {
      let bitmap;
      try {
        bitmap = await createImageBitmap(file);
        const web = resize(bitmap, 800);
        const thumbnail = resize(web, 160);
        const webJpeg = await jpeg(web);
        const thumbnailJpeg = await jpeg(thumbnail);
        const dot = file.name.lastIndexOf('.');
        const stem = uniqueStem(dot > 0 ? file.name.slice(0, dot) : file.name, stems);
        const extension = dot > 0 ? file.name.slice(dot).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') : '';
        entries.push(['vig/' + stem + '.ori' + extension, file]);
        entries.push(['vig/' + stem + '.web.jpg', webJpeg]);
        entries.push(['vig/' + stem + '.vig.jpg', thumbnailJpeg]);
        converted++;
      } catch {
        const item = document.createElement('li');
        item.textContent = file.name + ' — conversion impossible.';
        errors.append(item);
        errors.hidden = false;
      } finally {
        bitmap?.close();
        progress.value++;
      }
    }
    if (converted) {
      status.textContent = 'Création du ZIP…';
      archiveUrl = URL.createObjectURL(await createZip(entries));
      download.href = archiveUrl;
      download.hidden = false;
    }
    status.textContent = converted + ' / ' + files.length + ' images converties.';
  } catch (error) {
    status.textContent = error.message;
  } finally {
    progress.hidden = true;
    filesButton.disabled = folderButton.disabled = false;
  }
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) {
    value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return value;
});

async function checksum(blob) {
  let crc = 0xffffffff;
  for await (const chunk of blob.stream()) {
    for (const byte of chunk) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ZIP classique, sans compression. Les blobs sont conservés comme parties de l’archive.
async function createZip(entries) {
  const encoder = new TextEncoder();
  const parts = [];
  const directory = [];
  let offset = 0;
  let directorySize = 0;
  const maxSize = 0xffffffff;
  const sizeError = 'Le lot est trop volumineux pour un ZIP. Sélectionnez moins de fichiers.';
  const records = entries.map(([path, blob]) => [encoder.encode(path), blob]);
  const archiveSize = records.reduce((total, [name, blob]) =>
    total + 76 + 2 * name.length + blob.size, 22);
  if (entries.length >= 0xffff || archiveSize >= maxSize) throw new Error(sizeError);
  for (const [name, blob] of records) {
    if (name.length > 0xffff) throw new Error('Un nom de fichier est trop long.');
    const crc = await checksum(blob);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(12, 33, true); // 1er janvier 1980, date minimale du format ZIP.
    local.setUint32(14, crc, true);
    local.setUint32(18, blob.size, true);
    local.setUint32(22, blob.size, true);
    local.setUint16(26, name.length, true);
    parts.push(local.buffer, name, blob);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    new Uint8Array(central.buffer, 6, 26).set(new Uint8Array(local.buffer, 4, 26));
    central.setUint32(42, offset, true);
    directory.push(central.buffer, name);
    directorySize += 46 + name.length;
    offset += 30 + name.length + blob.size;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end.buffer], { type: 'application/zip' });
}
