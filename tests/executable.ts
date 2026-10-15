import { chmod, writeFile } from 'node:fs/promises';

export async function fixtureExecutable(filename: string, source: string) {
  if (process.platform !== 'win32') {
    await writeFile(filename, `#!${process.execPath}\n${source}`);
    await chmod(filename, 0o755);
    return filename;
  }
  const entry = filename + '.ts';
  await writeFile(entry, source);
  const output = filename + '.exe';
  await Bun.build({ entrypoints: [entry], target: 'bun', compile: { outfile: output } });
  return output;
}
