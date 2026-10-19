import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { toBuffer } from 'qrcode';

/** Create an owner-only QR image inside the already validated session directory. */
export async function savePairingQr(payload: string, directory: string): Promise<string> {
  const png = await toBuffer(payload, { type: 'png', errorCorrectionLevel: 'M', margin: 4, scale: 6 });
  const path = join(directory, `pairing-${randomUUID()}.png`);
  await writeFile(path, png, { flag: 'wx', mode: 0o600 });
  return path;
}
