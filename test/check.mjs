import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { piRequire } from './pi-host.mjs';
const { transform } = piRequire('esbuild');
const source=fileURLToPath(new URL('..',import.meta.url));
const files=fs.readdirSync(source).filter(name=>name.endsWith('.ts'));
for(const file of files)await transform(fs.readFileSync(path.join(source,file),'utf8'),{loader:'ts',format:'esm',target:'node22',sourcefile:file});
console.log(`PASS TypeScript compilation: ${files.length} source files (esbuild); static type checking is not configured in this project`);
