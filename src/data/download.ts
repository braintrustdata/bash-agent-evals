import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { join } from 'path';

const DATA_DIR = join(import.meta.dirname, '../../data/raw');

// GH Archive stores hourly snapshots at:
// https://data.gharchive.org/{year}-{month}-{day}-{hour}.json.gz
// Let's download a recent hour with good activity

async function downloadHour(
  year: number,
  month: number,
  day: number,
  hour: number,
): Promise<string> {
  const paddedMonth = String(month).padStart(2, '0');
  const paddedDay = String(day).padStart(2, '0');
  const filename = `${year}-${paddedMonth}-${paddedDay}-${hour}.json`;
  const url = `https://data.gharchive.org/${filename}.gz`;
  const outputPath = join(DATA_DIR, filename);

  if (existsSync(outputPath)) {
    console.log(`File already exists: ${outputPath}`);
    return outputPath;
  }

  console.log(`Downloading ${url}...`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error('No response body');
  }

  // Create a readable stream from the response
  const readable = Readable.fromWeb(response.body as any);

  // Decompress and write to file
  const gunzip = createGunzip();
  const writeStream = createWriteStream(outputPath);

  await pipeline(readable, gunzip, writeStream);

  console.log(`Downloaded and decompressed to: ${outputPath}`);
  return outputPath;
}

async function main() {
  // Create data directory
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  // Download a specific hour - let's use a recent date with good activity
  // Using 2024-01-15 hour 15 (3 PM UTC) - typically high activity
  const year = 2024;
  const month = 1;
  const day = 15;
  const hour = 15;

  try {
    const filePath = await downloadHour(year, month, day, hour);
    console.log(`\nData downloaded to: ${filePath}`);
    console.log('Run `pnpm transform` to process the data.');
  } catch (error) {
    console.error('Download failed:', error);
    process.exit(1);
  }
}

main();
