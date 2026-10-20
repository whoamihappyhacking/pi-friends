import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
let piPackage = path.dirname(fs.realpathSync(execFileSync('which',[process.env.PI_FRIENDS_PI || 'pi'],{encoding:'utf8'}).trim()));
while (!fs.existsSync(path.join(piPackage,'dist/core/extensions/loader.js'))) {
  const parent=path.dirname(piPackage); if(parent===piPackage) throw Error('Pi extension loader not found'); piPackage=parent;
}
export const piRequire = createRequire(path.join(piPackage,'package.json'));
export const { loadExtensions, clearExtensionCache } = await import(pathToFileURL(path.join(piPackage,'dist/core/extensions/loader.js')).href);
const { createJiti } = await import(pathToFileURL(piRequire.resolve('jiti')).href);
const jiti = createJiti(import.meta.url,{moduleCache:false,alias:{'@earendil-works/pi-tui':piRequire.resolve('@earendil-works/pi-tui'),typebox:piRequire.resolve('typebox')}});
export const loadTS = file => jiti.import(file);
