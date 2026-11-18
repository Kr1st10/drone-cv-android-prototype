const YoloPilotArchive = (() => {
  'use strict';

  const pathDecoder = new TextDecoder();
  const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
    let crc = byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    return crc;
  });

  async function view(file, start, size) {
    const bytes = await file.slice(start, start + size).arrayBuffer();
    if (bytes.byteLength !== size) throw new Error('ZIP обрывается.');
    return new DataView(bytes);
  }

  // The central directory also indexes Android entries with a trailing data descriptor.
  async function entries(file) {
    const endLength = 22;
    const tailStart = Math.max(0, file.size - endLength - 0xffff);
    const tail = await view(file, tailStart, file.size - tailStart);
    let end = tail.byteLength - endLength;
    for (; end >= 0; end--) {
      if (tail.getUint32(end, true) === 0x06054b50 &&
          end + endLength + tail.getUint16(end + 20, true) === tail.byteLength) break;
    }
    if (end < 0) throw new Error('Не найден каталог ZIP.');
    const count = tail.getUint16(end + 10, true);
    const size = tail.getUint32(end + 12, true);
    const offset = tail.getUint32(end + 16, true);
    if (tail.getUint16(end + 4, true) || tail.getUint16(end + 6, true) ||
        tail.getUint16(end + 8, true) !== count || count === 0xffff ||
        offset === 0xffffffff || size === 0xffffffff) {
      throw new Error('Поддерживается ZIP без разбиения на тома и без ZIP64.');
    }
    if (offset + size > tailStart + end) throw new Error('Некорректный каталог ZIP.');
    const directory = await view(file, offset, size);
    const contents = [];
    let pos = 0;
    for (let i = 0; i < count; i++) {
      if (pos + 46 > size || directory.getUint32(pos, true) !== 0x02014b50) throw new Error('Повреждён каталог ZIP.');
      const nameLength = directory.getUint16(pos + 28, true);
      const next = pos + 46 + nameLength + directory.getUint16(pos + 30, true) + directory.getUint16(pos + 32, true);
      if (next > size) throw new Error('Повреждён каталог ZIP.');
      const path = pathDecoder.decode(new Uint8Array(directory.buffer, pos + 46, nameLength));
      const member = {
        flags: directory.getUint16(pos + 8, true), method: directory.getUint16(pos + 10, true),
        crc: directory.getUint32(pos + 16, true), packed: directory.getUint32(pos + 20, true),
        size: directory.getUint32(pos + 24, true), local: directory.getUint32(pos + 42, true),
      };
      contents.push({ path, text: () => readMember(file, offset, member) });
      pos = next;
    }
    return contents;
  }

  async function readMember(file, directoryStart, member) {
    const { flags, method, packed, size, local } = member;
    if (flags & 1) throw new Error('Запись ZIP защищена паролем.');
    if (method !== 0 && method !== 8) throw new Error('Неподдерживаемый способ сжатия ZIP.');
    if (local + 30 > directoryStart) throw new Error('Повреждён заголовок записи ZIP.');
    const header = await view(file, local, 30);
    if (header.getUint32(0, true) !== 0x04034b50 || header.getUint16(8, true) !== method) {
      throw new Error('Повреждён заголовок записи ZIP.');
    }
    const start = local + 30 + header.getUint16(26, true) + header.getUint16(28, true);
    if (start + packed > directoryStart || (method === 0 && packed !== size)) {
      throw new Error('Некорректный размер записи ZIP.');
    }
    let stream = file.slice(start, start + packed).stream();
    if (method === 8) stream = stream.pipeThrough(new DecompressionStream('deflate-raw'));
    const reader = stream.getReader();
    const utf8 = new TextDecoder('utf-8', { fatal: true });
    const chunks = [];
    let total = 0;
    let crc = 0xffffffff;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > size) throw new Error('Некорректный размер записи ZIP.');
        for (const byte of value) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
        chunks.push(utf8.decode(value, { stream: true }));
      }
      if (total !== size || ((crc ^ 0xffffffff) >>> 0) !== member.crc) {
        throw new Error('Размер или контрольная сумма записи ZIP не совпадает.');
      }
      chunks.push(utf8.decode());
      return chunks.join('');
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  const filename = path => path.split('/').pop();
  const runName = name => name.replace(/\.(?:ndjson|json)$/i, '') || name;
  const isJournal = name => /\.(?:ndjson|json)$/i.test(name);

  async function journals(file, onError) {
    if (!/\.zip$/i.test(file.name)) {
      return [{ filename: file.name, title: runName(file.name), text: () => file.text() }];
    }
    const contents = await entries(file);
    const manifest = contents.find(entry => entry.path === 'manifest.json');
    const metadata = new Map();
    if (manifest) {
      try {
        const info = JSON.parse(await manifest.text());
        if (info?.schema !== 'dronecv-journal-batch-1' || !Array.isArray(info.journals) ||
            info.journals.some(row => typeof row?.path !== 'string' ||
                typeof row.id !== 'string' || typeof row.title !== 'string' || !row.title.trim()) ||
            new Set(info.journals.map(row => row.path)).size !== info.journals.length) {
          throw new Error('Некорректный список журналов.');
        }
        for (const row of info.journals) metadata.set(row.path, row);
      } catch (error) {
        onError(`${file.name} / manifest.json`, error);
      }
    }

    const journalEntries = contents.filter(entry => entry !== manifest && isJournal(entry.path));
    if (!journalEntries.length) throw new Error('В ZIP нет журналов JSON или NDJSON.');
    const paths = new Set(journalEntries.map(entry => entry.path));
    for (const path of metadata.keys()) {
      if (!paths.has(path)) onError(`${file.name} / ${path}`, new Error('Файл из списка журналов отсутствует в ZIP.'));
    }
    return journalEntries.map(entry => ({
      filename: filename(entry.path), archive: file.name, path: entry.path,
      id: metadata.get(entry.path)?.id, title: metadata.get(entry.path)?.title ?? runName(filename(entry.path)),
      text: entry.text,
    }));
  }

  return { journals };
})();
